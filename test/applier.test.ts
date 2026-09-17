import { beforeEach, describe, expect, it } from 'vitest'
import { Applier } from '../src/core/applier.js'
import { TranslationFilter } from '../src/core/filter.js'
import { scan } from '../src/core/scanner.js'
import { redistribute } from '../src/core/segmenter.js'
import type { AttributeUnit, BlockUnit, TextUnit } from '../src/types.js'

function unitsFor(html: string, options?: { segment?: boolean }) {
  document.body.innerHTML = html
  const { units } = scan(document.body, new TranslationFilter(), options)
  return {
    text: units.filter((u): u is TextUnit => u.kind === 'text'),
    blocks: units.filter((u): u is BlockUnit => u.kind === 'block'),
    attributes: units.filter((u): u is AttributeUnit => u.kind === 'attribute'),
  }
}

describe('Applier, writing text', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('writes the translation into the node', () => {
    const { text } = unitsFor('<p>Hello</p>')
    new Applier().applyText(text[0] as TextUnit, 'Hola')
    expect(document.body.textContent).toBe('Hola')
  })

  it('restores the original whitespace around the translation', () => {
    const { text } = unitsFor('<p>\n      Read more\n    </p>')
    new Applier().applyText(text[0] as TextUnit, 'Leer más')
    // Losing the trailing space here is what jams adjacent inline words together.
    expect(document.querySelector('p')?.firstChild?.nodeValue).toBe('\n      Leer más\n    ')
  })

  it('counts only writes that changed something', () => {
    const { text } = unitsFor('<p>Hello</p>')
    const applier = new Applier()
    const unit = text[0] as TextUnit

    applier.applyText(unit, 'Hola')
    expect(applier.applied).toBe(1)
    applier.applyText(unit, 'Hola')
    expect(applier.applied).toBe(1)
  })
})

describe('Applier, framework safety', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps the very same text node object in place', () => {
    const { text } = unitsFor('<p>Hello</p>')
    const paragraph = document.querySelector('p') as HTMLElement
    const before = paragraph.firstChild

    new Applier().applyText(text[0] as TextUnit, 'Hola')

    expect(paragraph.firstChild).toBe(before)
    expect(paragraph.childNodes).toHaveLength(1)
    expect(before?.nodeType).toBe(3)
    expect(before?.isConnected).toBe(true)
  })

  // facebook/react#11538, open since 2017. React stores a reference to a text
  // node and later calls parent.removeChild(node) on it. Google Translate has
  // by then swapped that node for a <font> wrapper, so the node is no longer a
  // child of that parent and React throws:
  //   Failed to execute 'removeChild' on 'Node'
  it('leaves parent.removeChild(textNode) working, the React #11538 crash', () => {
    // The exact shape from the issue: a text node that is not its parent's only
    // child, so React tracks it and later removes it directly.
    const { text } = unitsFor('<p>Hello<span>x</span></p>', { segment: false })
    const paragraph = document.querySelector('p') as HTMLElement
    const textNode = paragraph.firstChild as Text

    new Applier().applyText(text[0] as TextUnit, 'Hola')

    // This is the exact call React makes, and the exact one that throws today.
    expect(() => paragraph.removeChild(textNode)).not.toThrow()
    expect(paragraph.textContent).toBe('x')
  })

  it('leaves parent.insertBefore(node, textNode) working, the other #11538 path', () => {
    const { text } = unitsFor('<p>Hello<span>x</span></p>', { segment: false })
    const paragraph = document.querySelector('p') as HTMLElement
    const textNode = paragraph.firstChild as Text

    new Applier().applyText(text[0] as TextUnit, 'Hola')

    const inserted = document.createElement('b')
    expect(() => paragraph.insertBefore(inserted, textNode)).not.toThrow()
    expect(paragraph.firstChild).toBe(inserted)
  })

  it('stays React-safe on the block path too', () => {
    const { blocks } = unitsFor('<p>Only <b>signed-in</b> users can post</p>')
    const paragraph = document.querySelector('p') as HTMLElement
    const before = [...paragraph.childNodes]
    const unit = blocks[0] as BlockUnit

    const texts = redistribute(unit, 'Solo los usuarios <0>registrados</0> pueden publicar')
    new Applier().applyBlock(unit, texts as Map<Text, string>)

    // Same nodes, same order, same count, only their contents changed.
    expect([...paragraph.childNodes]).toEqual(before)
    expect(() => paragraph.removeChild(before[0] as Node)).not.toThrow()
  })

  it('documents why the wrapper approach is unsafe', () => {
    document.body.innerHTML = '<p>Hello<span>x</span></p>'
    const paragraph = document.querySelector('p') as HTMLElement
    const textNode = paragraph.firstChild as Text

    // What Google Translate does: wrap the text node in a <font> element.
    const font = document.createElement('font')
    paragraph.replaceChild(font, textNode)
    font.appendChild(textNode)

    // The node React is holding is no longer a child of the paragraph, so the
    // call React makes next throws. This is the failure we must never cause.
    expect(textNode.parentNode).not.toBe(paragraph)
    expect(() => paragraph.removeChild(textNode)).toThrow()
  })

  it('keeps a select usable after its options are translated', () => {
    const { text } = unitsFor(
      '<select><option value="es">Spain</option><option value="fr">France</option></select>',
    )
    const select = document.querySelector('select') as HTMLSelectElement
    const applier = new Applier()

    applier.applyText(text[0] as TextUnit, 'España')
    applier.applyText(text[1] as TextUnit, 'Francia')

    expect([...select.options].map((o) => o.textContent)).toEqual(['España', 'Francia'])
    // Values are machine-facing and must survive untouched, or every form breaks.
    expect([...select.options].map((o) => o.value)).toEqual(['es', 'fr'])
    select.value = 'fr'
    expect(select.value).toBe('fr')
  })
})

describe('Applier, recursion guard and re-render recovery', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('recognises its own write so the observer does not loop', () => {
    const { text } = unitsFor('<p>\n  Hello\n</p>')
    const applier = new Applier()
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text

    applier.applyText(text[0] as TextUnit, 'Hola')

    // The observer fires with our own value; recognising it stops the loop.
    expect(applier.wroteText(node, node.nodeValue)).toBe(true)
    expect(applier.wroteText(node, 'something else')).toBe(false)
  })

  it('remembers the source text so a re-render can be recognised', () => {
    const { text } = unitsFor('<p>  Hello  </p>')
    const applier = new Applier()
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text

    applier.applyText(text[0] as TextUnit, 'Hola')

    expect(applier.textStateOf(node)?.source).toBe('Hello')
    expect(applier.textStateOf(node)?.prefix).toBe('  ')
  })

  it('re-applies a translation a framework overwrote, preserving whitespace', () => {
    const { text } = unitsFor('<p>\n  Hello\n</p>')
    const applier = new Applier()
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text

    applier.applyText(text[0] as TextUnit, 'Hola')

    // React re-renders and writes the source string straight back.
    node.nodeValue = '\n  Hello\n'

    applier.reapplyText(node, 'Hola')

    expect(node.nodeValue).toBe('\n  Hola\n')
    expect(applier.wroteText(node, node.nodeValue)).toBe(true)
  })

  it('ignores a re-apply for a node it never touched', () => {
    document.body.innerHTML = '<p>Hello</p>'
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text
    new Applier().reapplyText(node, 'Hola')
    expect(node.nodeValue).toBe('Hello')
  })

  it('forgets a node on request so it is treated as fresh content', () => {
    const { text } = unitsFor('<p>Hello</p>')
    const applier = new Applier()
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text

    applier.applyText(text[0] as TextUnit, 'Hola')
    applier.forget(node)

    expect(applier.textStateOf(node)).toBeUndefined()
  })
})

describe('Applier, attributes', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('writes the attribute and guards against its own echo', () => {
    const { attributes } = unitsFor('<input placeholder="Search products">')
    const applier = new Applier()
    const input = document.querySelector('input') as HTMLInputElement

    applier.applyAttribute(attributes[0] as AttributeUnit, 'Buscar productos')

    expect(input.placeholder).toBe('Buscar productos')
    expect(applier.wroteAttribute(input, 'placeholder', 'Buscar productos')).toBe(true)
    expect(applier.wroteAttribute(input, 'placeholder', 'Search products')).toBe(false)
    expect(applier.attributeStateOf(input, 'placeholder')?.source).toBe('Search products')
  })

  it('tracks several attributes on one element independently', () => {
    const { attributes } = unitsFor('<img alt="A bicycle" title="Our bestseller" src="x">')
    const applier = new Applier()
    const img = document.querySelector('img') as HTMLImageElement

    for (const unit of attributes) {
      applier.applyAttribute(unit, unit.attribute === 'alt' ? 'Una bicicleta' : 'Nuestro éxito')
    }

    expect(img.getAttribute('alt')).toBe('Una bicicleta')
    expect(img.getAttribute('title')).toBe('Nuestro éxito')
  })
})

describe('Applier, restore', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('puts text and attributes back exactly as they were', () => {
    const html = '<p>\n  Hello\n</p><input placeholder="Search">'
    const { text, attributes } = unitsFor(html)
    const applier = new Applier()

    applier.applyText(text[0] as TextUnit, 'Hola')
    applier.applyAttribute(attributes[0] as AttributeUnit, 'Buscar')

    applier.restore()

    expect((document.querySelector('p') as HTMLElement).firstChild?.nodeValue).toBe('\n  Hello\n')
    expect((document.querySelector('input') as HTMLInputElement).placeholder).toBe('Search')
    expect(applier.applied).toBe(0)
  })

  it('drops its state so nodes are no longer recognised', () => {
    const { text } = unitsFor('<p>Hello</p>')
    const applier = new Applier()
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text

    applier.applyText(text[0] as TextUnit, 'Hola')
    applier.restore()

    expect(applier.textStateOf(node)).toBeUndefined()
  })

  it('restores a segmented block byte-for-byte, spaces included', () => {
    // Regression: applyBlock recorded only the trimmed text, so restore() wrote
    // "Only<b>signed-in</b>users" back. That jams words together on teardown,
    // and because every setLanguage() restores first, each switch compounded it
    // and turned the block's source string into a permanent cache miss.
    const { blocks } = unitsFor('<p>Only <b>signed-in</b> users can post a review.</p>')
    const paragraph = document.querySelector('p') as HTMLElement
    const original = paragraph.innerHTML
    const unit = blocks[0] as BlockUnit
    const applier = new Applier()

    const texts = redistribute(unit, '<0>ログイン済み</0>のユーザーのみ投稿できます。')
    applier.applyBlock(unit, texts as Map<Text, string>)
    expect(paragraph.textContent).toBe('ログイン済みのユーザーのみ投稿できます。')

    applier.restore()

    expect(paragraph.innerHTML).toBe(original)
  })

  it('re-derives the identical block source after a restore', () => {
    const { blocks } = unitsFor('<p>Only <b>signed-in</b> users can post a review.</p>')
    const unit = blocks[0] as BlockUnit
    const applier = new Applier()

    const texts = redistribute(unit, 'Solo los usuarios <0>registrados</0> pueden publicar')
    applier.applyBlock(unit, texts as Map<Text, string>)
    applier.restore()

    // A drifted source here means every language switch re-pays for the block.
    const again = scan(document.body, new TranslationFilter()).units.find(
      (u): u is BlockUnit => u.kind === 'block',
    )
    expect(again?.source).toBe(unit.source)
  })

  it('can translate, restore, then translate again', () => {
    // Guards the tracking-set bookkeeping: a second restore must still work.
    const { text } = unitsFor('<p>Hello</p>')
    const applier = new Applier()
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text

    applier.applyText(text[0] as TextUnit, 'Hola')
    applier.restore()
    expect(node.nodeValue).toBe('Hello')

    const again = scan(document.body, new TranslationFilter()).units.filter(
      (u): u is TextUnit => u.kind === 'text',
    )
    applier.applyText(again[0] as TextUnit, 'Bonjour')
    expect(node.nodeValue).toBe('Bonjour')

    applier.restore()
    expect(node.nodeValue).toBe('Hello')
  })
})

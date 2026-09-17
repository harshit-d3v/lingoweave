import { beforeEach, describe, expect, it } from 'vitest'
import { TranslationFilter } from '../src/core/filter.js'
import {
  collectIndices,
  parseSegment,
  redistribute,
  serializeBlock,
  splitLongSource,
} from '../src/core/segmenter.js'
import { scan } from '../src/core/scanner.js'
import type { BlockUnit } from '../src/types.js'

const filter = new TranslationFilter()

function block(html: string): BlockUnit | null {
  document.body.innerHTML = html
  return serializeBlock(document.body.firstElementChild as Element, filter)
}

describe('serializeBlock, building one sentence', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('folds inline markup into placeholders', () => {
    // Without this the provider sees "Only", "signed-in" and "users can post"
    // as three unrelated strings and picks gender and case for each blindly.
    expect(block('<p>Only <b>signed-in</b> users can post</p>')?.source).toBe(
      'Only <0>signed-in</0> users can post',
    )
  })

  it('numbers several inline elements in document order', () => {
    expect(block('<p>See <a>docs</a> or <em>examples</em> now</p>')?.source).toBe(
      'See <0>docs</0> or <1>examples</1> now',
    )
  })

  it('nests placeholders', () => {
    expect(block('<p>A <b>bold <i>and italic</i></b> tail</p>')?.source).toBe(
      'A <0>bold <1>and italic</1></0> tail',
    )
  })

  it('gives void elements a self-closing placeholder so they can move', () => {
    expect(block('<p>First line<br>second line</p>')?.source).toBe(
      'First line<0/>second line',
    )
  })

  it('keeps the space between adjacent inline elements', () => {
    // The whitespace-only node between the spans is not translated, but its
    // space has to survive or the two words run together.
    expect(block('<p><span>Hello</span> <span>world</span></p>')?.source).toBe(
      '<0>Hello</0> <1>world</1>',
    )
  })

  it('collapses indentation the way rendering does', () => {
    expect(block('<p>\n  Hello\n  <b>world</b>\n</p>')?.source).toBe('Hello <0>world</0>')
  })

  it('declines a single text node, where placeholders would only add cost', () => {
    expect(block('<p>Just text</p>')).toBeNull()
    expect(block('<div><em>Only this</em></div>')).toBeNull()
  })

  it('declines a block that contains other blocks', () => {
    // The caller descends and treats each paragraph as its own sentence.
    expect(block('<div><p>One</p><p>Two</p></div>')).toBeNull()
  })

  it('declines when an inline child is opted out', () => {
    expect(block('<p>Made by <b translate="no">Acme</b> today</p>')).toBeNull()
    expect(block('<p>Run <code>npm i</code> to install</p>')).toBeNull()
  })

  it('records each node original so a re-render can be detected later', () => {
    const unit = block('<p>Only <b>signed-in</b> users</p>') as BlockUnit
    expect(unit.sources).toEqual(['Only', 'signed-in', 'users'])
    expect(unit.paths).toEqual(['', '0', ''])
    // Both root-level nodes share path '', so only the slot distinguishes the
    // one before <b> from the one after it.
    expect(unit.slots).toEqual([0, 0, 1])
  })
})

describe('parseSegment, trusting the reply or not', () => {
  const expected = new Set([0])

  it('splits a well-formed reply, recording each position', () => {
    expect(parseSegment('Solo los <0>registrados</0> pueden', expected)).toEqual([
      { path: '', slot: 0, text: 'Solo los ' },
      { path: '0', slot: 0, text: 'registrados' },
      // slot 1: this text comes after the placeholder, so it belongs in the
      // node that follows the inline element rather than the one before it.
      { path: '', slot: 1, text: ' pueden' },
    ])
  })

  it('accepts a reordered placeholder, which is the normal case', () => {
    // Word order changes between languages; that is the point of segmenting.
    expect(parseSegment('<0>Registrados</0> solamente', expected)).toEqual([
      { path: '0', slot: 0, text: 'Registrados' },
      { path: '', slot: 1, text: ' solamente' },
    ])
  })

  it('rejects a dropped placeholder', () => {
    expect(parseSegment('Solo los registrados pueden', expected)).toBeNull()
  })

  it('rejects an unknown placeholder index', () => {
    expect(parseSegment('Solo <7>los</7> registrados', expected)).toBeNull()
  })

  it('rejects a duplicated placeholder', () => {
    expect(parseSegment('<0>a</0> and <0>b</0>', expected)).toBeNull()
  })

  it('rejects an unclosed placeholder', () => {
    expect(parseSegment('Solo <0>registrados', expected)).toBeNull()
  })

  it('rejects crossed tags', () => {
    expect(parseSegment('<0>a<1>b</0>c</1>', new Set([0, 1]))).toBeNull()
  })

  it('handles nesting, counting slots per level', () => {
    expect(parseSegment('<0>bold <1>italic</1></0>', new Set([0, 1]))).toEqual([
      { path: '0', slot: 0, text: 'bold ' },
      { path: '0.1', slot: 0, text: 'italic' },
    ])
  })
})

describe('redistribute, writing the sentence back', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('gives each node its share of the translation', () => {
    const unit = block('<p>Only <b>signed-in</b> users can post</p>') as BlockUnit
    const result = redistribute(
      unit,
      'Solo los usuarios <0>registrados</0> pueden publicar',
    ) as Map<Text, string>

    expect(result.get(unit.nodes[0] as Text)).toBe('Solo los usuarios ')
    expect(result.get(unit.nodes[1] as Text)).toBe('registrados')
    expect(result.get(unit.nodes[2] as Text)).toBe(' pueden publicar')
  })

  it('follows a placeholder that moved to the front', () => {
    const unit = block('<p>Only <b>signed-in</b> users</p>') as BlockUnit
    const result = redistribute(unit, '<0>Registrados</0> usuarios solamente') as Map<
      Text,
      string
    >

    expect(result.get(unit.nodes[1] as Text)).toBe('Registrados')
    expect(result.get(unit.nodes[0] as Text)).toBe('')
    expect(result.get(unit.nodes[2] as Text)).toBe(' usuarios solamente')
  })

  it('never loses text when a run gets merged', () => {
    const unit = block('<p>The <b>big</b> dog barks</p>') as BlockUnit
    const result = redistribute(unit, 'El perro grande ladra<0>x</0>') as Map<Text, string>

    // Two outer chunks became one; everything still lands somewhere.
    const joined = unit.nodes.map((n) => result.get(n) ?? '').join('')
    expect(joined).toContain('El perro grande ladra')
    expect(joined).toContain('x')
  })

  it('refuses a reply it cannot map, so the caller can fall back', () => {
    const unit = block('<p>Only <b>signed-in</b> users</p>') as BlockUnit
    expect(redistribute(unit, 'Solo los registrados pueden')).toBeNull()
    expect(redistribute(unit, 'Solo <9>los</9> registrados')).toBeNull()
  })

  it('round-trips an untouched reply back to the original text', () => {
    const unit = block('<p>Only <b>signed-in</b> users can post</p>') as BlockUnit
    const result = redistribute(unit, unit.source) as Map<Text, string>

    expect(unit.nodes.map((n) => result.get(n))).toEqual(['Only ', 'signed-in', ' users can post'])
  })
})

describe('scan integration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('emits one block instead of three fragments', () => {
    document.body.innerHTML = '<p>Only <b>signed-in</b> users can post</p>'
    const units = scan(document.body, filter).units

    expect(units).toHaveLength(1)
    expect(units[0]?.kind).toBe('block')
  })

  it('does not also emit the block text nodes separately', () => {
    document.body.innerHTML = '<p>Only <b>signed-in</b> users can post</p>'
    const units = scan(document.body, filter).units
    expect(units.filter((u) => u.kind === 'text')).toHaveLength(0)
  })

  it('still finds attributes inside a segmented block', () => {
    document.body.innerHTML =
      '<p>See <a title="Read the docs">docs</a> or <em>examples</em></p>'
    const units = scan(document.body, filter).units

    expect(units.filter((u) => u.kind === 'block')).toHaveLength(1)
    expect(units.filter((u) => u.kind === 'attribute')).toHaveLength(1)
  })

  it('can be turned off', () => {
    document.body.innerHTML = '<p>Only <b>signed-in</b> users can post</p>'
    const units = scan(document.body, filter, { segment: false }).units

    expect(units.filter((u) => u.kind === 'block')).toHaveLength(0)
    expect(units.map((u) => u.source)).toEqual(['Only', 'signed-in', 'users can post'])
  })
})

describe('splitLongSource', () => {
  it('leaves a short string alone', () => {
    expect(splitLongSource('Short', 'en', 100)).toEqual(['Short'])
  })

  it('breaks at sentence boundaries', () => {
    const source = 'First sentence here. Second sentence here. Third sentence here.'
    const parts = splitLongSource(source, 'en', 30)

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(source)
    // Splitting mid-sentence would destroy the grammar we segmented to protect.
    for (const part of parts) expect(part.trim()).toMatch(/\.$/)
  })

  it('still breaks a single over-long sentence', () => {
    const source = 'word '.repeat(50).trim()
    const parts = splitLongSource(source, 'en', 40)

    expect(parts.every((p) => p.length <= 40)).toBe(true)
    expect(parts.join('')).toBe(source)
  })

  it('never drops characters', () => {
    const source = '句子一。句子二。句子三。'.repeat(20)
    expect(splitLongSource(source, 'zh', 50).join('')).toBe(source)
  })
})

describe('collectIndices', () => {
  it('finds every placeholder index once', () => {
    expect(collectIndices('a <0>b</0> c <1/> d <2>e</2>')).toEqual(new Set([0, 1, 2]))
    expect(collectIndices('no placeholders')).toEqual(new Set())
  })
})

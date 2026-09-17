import { beforeEach, describe, expect, it } from 'vitest'
import { TranslationFilter } from '../src/core/filter.js'
import { scan } from '../src/core/scanner.js'
import type { AttributeUnit, TextUnit } from '../src/types.js'

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body
}

function run(html: string, options?: Parameters<typeof scan>[2], ignore?: string[]) {
  const root = mount(html)
  const filter = new TranslationFilter(ignore ? { ignore } : {})
  return scan(root, filter, options)
}

function texts(html: string, ignore?: string[]): string[] {
  return run(html, {}, ignore)
    .units.filter((u): u is TextUnit => u.kind === 'text')
    .map((u) => u.source)
}

function attributes(html: string): Array<[string, string]> {
  return run(html)
    .units.filter((u): u is AttributeUnit => u.kind === 'attribute')
    .map((u) => [u.attribute, u.source])
}

describe('scan, text', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('finds text in document order', () => {
    expect(texts('<h1>First</h1><p>Second</p><span>Third</span>')).toEqual([
      'First',
      'Second',
      'Third',
    ])
  })

  it('finds deeply nested text', () => {
    expect(texts('<div><div><div><em>Deep</em></div></div></div>')).toEqual(['Deep'])
  })

  it('separates whitespace from content so indentation is not translated', () => {
    const [unit] = run('<p>\n      Read more\n    </p>').units as TextUnit[]
    expect(unit?.source).toBe('Read more')
    expect(unit?.prefix).toBe('\n      ')
    expect(unit?.suffix).toBe('\n    ')
  })

  it('skips whitespace-only nodes', () => {
    expect(texts('<p>  </p><p>\n\t</p><p>Real</p>')).toEqual(['Real'])
  })

  it('skips text with no letters, which is most of a page by node count', () => {
    expect(texts('<span>•</span><span>→</span><span>123</span><span>, </span><span>$</span><span>19:45</span><b>Yes</b>')).toEqual(
      ['Yes'],
    )
  })

  it('keeps text in non-latin scripts', () => {
    expect(texts('<p>مرحبا</p><p>你好</p><p>नमस्ते</p>')).toEqual(['مرحبا', '你好', 'नमस्ते'])
  })
})

describe('scan, content the visitor cannot see yet', () => {
  // The single most common complaint about every existing translator.
  it('translates a closed dropdown', () => {
    expect(
      texts(`
        <nav>
          <button>Products</button>
          <ul style="display:none">
            <li>Laptops</li>
            <li>Phones</li>
          </ul>
        </nav>`),
    ).toEqual(['Products', 'Laptops', 'Phones'])
  })

  it('translates a nested submenu', () => {
    expect(
      texts(`
        <ul hidden>
          <li>More
            <ul hidden><li>Even more</li></ul>
          </li>
        </ul>`),
    ).toEqual(['More', 'Even more'])
  })

  it('translates an unopened modal', () => {
    expect(texts('<div role="dialog" aria-hidden="true"><h2>Confirm</h2></div>')).toEqual([
      'Confirm',
    ])
  })

  it('translates select options and their groups', () => {
    const html = `
      <select>
        <optgroup label="Europe">
          <option>Spain</option>
          <option>France</option>
        </optgroup>
      </select>`
    expect(texts(html)).toEqual(['Spain', 'France'])
    expect(attributes(html)).toEqual([['label', 'Europe']])
  })
})

describe('scan, attributes', () => {
  it('finds the common label-bearing attributes', () => {
    expect(
      attributes(`
        <input placeholder="Search products">
        <img alt="A red bicycle" src="x">
        <button aria-label="Close dialog"></button>
        <abbr title="World Health Organization">WHO</abbr>`),
    ).toEqual([
      ['placeholder', 'Search products'],
      ['alt', 'A red bicycle'],
      ['aria-label', 'Close dialog'],
      ['title', 'World Health Organization'],
    ])
  })

  it('translates value only where it is a label, never user data', () => {
    expect(attributes('<input type="submit" value="Send message">')).toEqual([
      ['value', 'Send message'],
    ])
    expect(attributes('<input type="text" value="typed by the user">')).toEqual([])
    expect(attributes('<input type="email" value="me@example.com">')).toEqual([])
  })

  it('reads attributes on elements whose contents are skipped', () => {
    // The regression this guards: skipping textarea text must not also skip
    // its placeholder, which is one of the most visible strings on a form.
    expect(attributes('<textarea placeholder="Write a review">draft text</textarea>')).toEqual([
      ['placeholder', 'Write a review'],
    ])
    expect(texts('<textarea placeholder="Write a review">draft text</textarea>')).toEqual([])
  })

  it('ignores attributes that hold no prose', () => {
    expect(attributes('<img alt="" src="x"><button aria-label="   "></button>')).toEqual([])
    expect(attributes('<img alt="123" src="x">')).toEqual([])
  })

  it('reads attributes on the root element it was given', () => {
    const root = mount('<div></div>').firstElementChild as HTMLElement
    root.setAttribute('aria-label', 'Root label')
    const result = scan(root, new TranslationFilter())
    expect(result.units).toEqual([
      { kind: 'attribute', element: root, attribute: 'aria-label', source: 'Root label' },
    ])
  })
})

describe('scan, head and metadata', () => {
  it('picks up the tab title and social descriptions', () => {
    document.head.innerHTML = `
      <title>My shop</title>
      <meta name="description" content="The best shop">
      <meta property="og:title" content="My shop online">
      <meta name="viewport" content="width=device-width">
      <meta charset="utf-8">`

    const result = scan(document, new TranslationFilter())
    const sources = result.units.map((u) => u.source)

    expect(sources).toContain('My shop') // the browser tab title
    expect(sources).toContain('The best shop')
    expect(sources).toContain('My shop online')
    // Machine-facing metadata must be left alone or the page breaks.
    expect(sources).not.toContain('width=device-width')
    expect(sources).not.toContain('utf-8')
    document.head.innerHTML = ''
  })

  it('updates document.title when the title text node is written', () => {
    document.head.innerHTML = '<title>My shop</title>'
    const titleNode = document.querySelector('title')?.firstChild as Text
    titleNode.nodeValue = 'Mi tienda'
    // Confirms the tab title needs no special case, assigning to the text
    // node is enough, which keeps it on the same code path as everything else.
    expect(document.title).toBe('Mi tienda')
    document.head.innerHTML = ''
  })
})

describe('scan, exclusions', () => {
  it('never translates code, scripts or styles', () => {
    expect(
      texts(`
        <p>Prose</p>
        <script>const greeting = "Hello"</script>
        <style>.a { color: red }</style>
        <code>npm install</code>
        <pre>indented block</pre>
        <kbd>Ctrl</kbd>`),
    ).toEqual(['Prose'])
  })

  it('honours the standard translate="no" opt-out', () => {
    expect(texts('<p translate="no">Brand name</p><p>Translate me</p>')).toEqual([
      'Translate me',
    ])
  })

  it('honours the notranslate class convention', () => {
    expect(texts('<p class="notranslate">Brand name</p><p>Translate me</p>')).toEqual([
      'Translate me',
    ])
  })

  it('honours its own data attribute', () => {
    expect(texts('<p data-lw-ignore>Leave</p><p>Take</p>')).toEqual(['Take'])
  })

  it('leaves editable regions to the user', () => {
    expect(texts('<div contenteditable="true">My draft</div><p>Chrome</p>')).toEqual(['Chrome'])
    expect(texts('<div contenteditable="false">Not editable</div>')).toEqual(['Not editable'])
  })

  it('honours user-supplied ignore selectors', () => {
    expect(texts('<div class="skip"><p>Inside</p></div><p>Outside</p>', ['.skip'])).toEqual([
      'Outside',
    ])
  })

  it('skips attributes too when the author opted the element out', () => {
    const root = mount('<img translate="no" alt="Brand logo" src="x">')
    const result = scan(root, new TranslationFilter())
    expect(result.units).toEqual([])
  })

  it('survives an invalid ignore selector without dropping the scan', () => {
    const warnings: string[] = []
    const root = mount('<p>Still translated</p>')
    const filter = new TranslationFilter({
      ignore: ['['],
      onWarning: (m) => warnings.push(m),
    })
    const result = scan(root, filter)
    expect(result.units).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('leaves template contents inert until they are cloned in', () => {
    expect(texts('<template><p>Row</p></template><p>Live</p>')).toEqual(['Live'])
  })
})

describe('scan, shadow roots', () => {
  it('reports open shadow roots for the caller to handle', () => {
    const root = mount('<my-card></my-card>')
    const host = root.firstElementChild as HTMLElement
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>Inside shadow</p>'

    const result = scan(root, new TranslationFilter())
    expect(result.shadowRoots).toEqual([shadow])
    // The host's own tree holds no text, so nothing is found in this pass.
    expect(result.units).toEqual([])
  })

  it('finds text when handed a shadow root directly', () => {
    const root = mount('<my-card></my-card>')
    const host = root.firstElementChild as HTMLElement
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>Inside shadow</p>'

    const result = scan(shadow, new TranslationFilter())
    expect(result.units.map((u) => u.source)).toEqual(['Inside shadow'])
  })

  it('can be told to leave shadow roots alone', () => {
    const root = mount('<my-card></my-card>')
    const host = root.firstElementChild as HTMLElement
    host.attachShadow({ mode: 'open' }).innerHTML = '<p>Inside</p>'

    const result = scan(root, new TranslationFilter(), { shadowDom: false })
    expect(result.shadowRoots).toEqual([])
  })
})

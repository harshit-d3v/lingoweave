import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Applier } from '../src/core/applier.js'
import { TranslationFilter } from '../src/core/filter.js'
import { DomObserver } from '../src/core/observer.js'
import { scan } from '../src/core/scanner.js'
import type { TextUnit } from '../src/types.js'

/** MutationObserver delivers on a microtask; give it one. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness() {
  const applier = new Applier()
  const onNewContent = vi.fn<(nodes: Node[]) => void>()
  const onTextReset = vi.fn<(node: Text, source: string) => void>()
  const onAttributeReset = vi.fn<(el: Element, attr: string, source: string) => void>()

  const observer = new DomObserver(applier, { onNewContent, onTextReset, onAttributeReset })
  observer.observe(document.body)

  /** Translate whatever is currently in the tree, as the engine would. */
  const translateAll = (render: (source: string) => string) => {
    const units = scan(document.body, new TranslationFilter()).units
    for (const unit of units) {
      if (unit.kind === 'text') applier.applyText(unit, render(unit.source))
      else if (unit.kind === 'attribute') applier.applyAttribute(unit, render(unit.source))
    }
  }

  return { applier, observer, onNewContent, onTextReset, onAttributeReset, translateAll }
}

function newNodes(mock: { mock: { calls: Array<[Node[]]> } }): Node[] {
  return mock.mock.calls.flatMap(([nodes]) => nodes)
}

let active: DomObserver | null = null

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  active?.disconnect()
  active = null
})

describe('DomObserver, content that arrives later', () => {
  it('reports a dropdown panel appended after the first pass', async () => {
    const { observer, onNewContent } = harness()
    active = observer

    const menu = document.createElement('ul')
    menu.innerHTML = '<li>Laptops</li><li>Phones</li>'
    document.body.append(menu)
    await settle()

    expect(onNewContent).toHaveBeenCalled()
    expect(newNodes(onNewContent)).toContain(menu)
  })

  it('reports a bare text node a framework appends', async () => {
    const { observer, onNewContent } = harness()
    active = observer

    const text = document.createTextNode('Saved')
    document.body.append(text)
    await settle()

    expect(newNodes(onNewContent)).toContain(text)
  })

  it('reports only the container when a whole subtree lands at once', async () => {
    const { observer, onNewContent } = harness()
    active = observer

    // A route change reports the container and its descendants; scanning the
    // container already covers everything inside it.
    const container = document.createElement('section')
    const child = document.createElement('p')
    child.textContent = 'Inside'
    container.append(child)
    document.body.append(container)
    await settle()

    const reported = newNodes(onNewContent)
    expect(reported).toContain(container)
    expect(reported).not.toContain(child)
  })

  it('ignores nodes it cannot translate', async () => {
    const { observer, onNewContent } = harness()
    active = observer

    document.body.append(document.createComment('a comment'))
    await settle()

    expect(onNewContent).not.toHaveBeenCalled()
  })
})

describe('DomObserver, the recursion guard', () => {
  it('does not react to its own writes', async () => {
    document.body.innerHTML = '<p>Hello</p><span>World</span>'
    const { observer, onNewContent, onTextReset, translateAll } = harness()
    active = observer

    // Without a guard this is the infinite loop: write, observe, write again.
    translateAll((source) => `[${source}]`)
    await settle()

    expect(onNewContent).not.toHaveBeenCalled()
    expect(onTextReset).not.toHaveBeenCalled()
    expect(document.body.textContent).toBe('[Hello][World]')
  })

  it('does not react to its own attribute writes', async () => {
    document.body.innerHTML = '<input placeholder="Search">'
    const { observer, onNewContent, onAttributeReset, translateAll } = harness()
    active = observer

    translateAll((source) => `[${source}]`)
    await settle()

    expect(onNewContent).not.toHaveBeenCalled()
    expect(onAttributeReset).not.toHaveBeenCalled()
  })

  it('stays quiet when translating repeatedly', async () => {
    document.body.innerHTML = '<p>Hello</p>'
    const { observer, onNewContent, translateAll } = harness()
    active = observer

    for (let i = 0; i < 5; i++) {
      translateAll((source) => `[${source}]`)
      await settle()
    }

    expect(onNewContent).not.toHaveBeenCalled()
  })
})

describe('DomObserver, surviving framework re-renders', () => {
  it('recognises the source text being written back over a translation', async () => {
    document.body.innerHTML = '<p>Hello</p>'
    const { observer, onTextReset, onNewContent, translateAll } = harness()
    active = observer

    translateAll(() => 'Hola')
    await settle()

    // React re-renders and puts its own string back. Other libraries either
    // give up here or pay to re-translate; we already know the answer.
    const node = (document.querySelector('p') as HTMLElement).firstChild as Text
    node.nodeValue = 'Hello'
    await settle()

    expect(onTextReset).toHaveBeenCalledOnce()
    expect(onTextReset.mock.calls[0]?.[1]).toBe('Hello')
    expect(onNewContent).not.toHaveBeenCalled()
  })

  it('recognises a re-render even when the whitespace differs', async () => {
    document.body.innerHTML = '<p>\n  Hello\n</p>'
    const { observer, onTextReset, translateAll } = harness()
    active = observer

    translateAll(() => 'Hola')
    await settle()

    const node = (document.querySelector('p') as HTMLElement).firstChild as Text
    node.nodeValue = '   Hello '
    await settle()

    expect(onTextReset).toHaveBeenCalledOnce()
  })

  it('treats genuinely different text as new content', async () => {
    document.body.innerHTML = '<p>Hello</p>'
    const { observer, onTextReset, onNewContent, applier, translateAll } = harness()
    active = observer

    translateAll(() => 'Hola')
    await settle()

    const node = (document.querySelector('p') as HTMLElement).firstChild as Text
    node.nodeValue = 'Goodbye'
    await settle()

    expect(onTextReset).not.toHaveBeenCalled()
    expect(newNodes(onNewContent)).toContain(node)
    // The old record is stale and must not be used to "restore" anything.
    expect(applier.textStateOf(node)).toBeUndefined()
  })

  it('recognises an attribute reset back to its source value', async () => {
    document.body.innerHTML = '<input placeholder="Search">'
    const { observer, onAttributeReset, onNewContent, translateAll } = harness()
    active = observer

    translateAll(() => 'Buscar')
    await settle()

    const input = document.querySelector('input') as HTMLInputElement
    input.setAttribute('placeholder', 'Search')
    await settle()

    expect(onAttributeReset).toHaveBeenCalledOnce()
    expect(onAttributeReset.mock.calls[0]?.[2]).toBe('Search')
    expect(onNewContent).not.toHaveBeenCalled()
  })

  it('treats a changed attribute as new content', async () => {
    document.body.innerHTML = '<input placeholder="Search">'
    const { observer, onNewContent, translateAll } = harness()
    active = observer

    translateAll(() => 'Buscar')
    await settle()

    const input = document.querySelector('input') as HTMLInputElement
    input.setAttribute('placeholder', 'Filter results')
    await settle()

    expect(newNodes(onNewContent)).toContain(input)
  })
})

describe('DomObserver, scope and cost', () => {
  it('ignores attributes that carry no prose', async () => {
    document.body.innerHTML = '<div>Content</div>'
    const { observer, onNewContent } = harness()
    active = observer

    // Styling churn is constant on a real page and must not wake the engine.
    const div = document.querySelector('div') as HTMLElement
    div.className = 'active highlighted'
    div.setAttribute('style', 'color: red')
    div.setAttribute('data-state', 'open')
    await settle()

    expect(onNewContent).not.toHaveBeenCalled()
  })

  it('watches extra attributes when asked', async () => {
    document.body.innerHTML = '<div data-tooltip="Old tip">Content</div>'
    const applier = new Applier()
    const onNewContent = vi.fn<(nodes: Node[]) => void>()
    const observer = new DomObserver(
      applier,
      { onNewContent, onTextReset: vi.fn(), onAttributeReset: vi.fn() },
      { attributes: ['data-tooltip'] },
    )
    observer.observe(document.body)
    active = observer

    const div = document.querySelector('div') as HTMLElement
    div.setAttribute('data-tooltip', 'New tip')
    await settle()

    expect(newNodes(onNewContent)).toContain(div)
  })

  it('watches each root it is given, including shadow roots', async () => {
    document.body.innerHTML = '<my-card></my-card>'
    const host = document.body.firstElementChild as HTMLElement
    const shadow = host.attachShadow({ mode: 'open' })

    const { observer, onNewContent } = harness()
    active = observer
    observer.observe(shadow)
    expect(observer.rootCount).toBe(2)

    const inner = document.createElement('p')
    inner.textContent = 'Inside shadow'
    shadow.append(inner)
    await settle()

    expect(newNodes(onNewContent)).toContain(inner)
  })
})

describe('DomObserver, lifecycle', () => {
  it('stops and restarts on pause and resume', async () => {
    const { observer, onNewContent } = harness()
    active = observer

    observer.pause()
    const whilePaused = document.createElement('p')
    whilePaused.textContent = 'While paused'
    document.body.append(whilePaused)
    await settle()
    expect(onNewContent).not.toHaveBeenCalled()

    observer.resume()
    const later = document.createElement('p')
    later.textContent = 'After resume'
    document.body.append(later)
    await settle()

    expect(newNodes(onNewContent)).toContain(later)
  })

  it('drops a single root without losing the others', async () => {
    document.body.innerHTML = '<my-card></my-card>'
    const host = document.body.firstElementChild as HTMLElement
    const shadow = host.attachShadow({ mode: 'open' })

    const { observer, onNewContent } = harness()
    active = observer
    observer.observe(shadow)

    observer.unobserve(shadow)
    expect(observer.rootCount).toBe(1)

    shadow.append(document.createTextNode('Ignored'))
    const watched = document.createElement('p')
    watched.textContent = 'Still watched'
    document.body.append(watched)
    await settle()

    const reported = newNodes(onNewContent)
    expect(reported).toContain(watched)
    expect(reported.some((n) => n.textContent === 'Ignored')).toBe(false)
  })

  it('goes quiet after disconnect', async () => {
    const { observer, onNewContent } = harness()
    observer.disconnect()

    const afterDisconnect = document.createElement('p')
    afterDisconnect.textContent = 'After disconnect'
    document.body.append(afterDisconnect)
    await settle()

    expect(onNewContent).not.toHaveBeenCalled()
    expect(observer.rootCount).toBe(0)
  })

  it('processes pending records on demand', () => {
    const { observer, onNewContent } = harness()
    active = observer

    const node = document.createElement('p')
    node.textContent = 'Immediate'
    document.body.append(node)

    // No awaiting: flush lets the engine settle the page before first paint.
    observer.flush()

    expect(newNodes(onNewContent)).toContain(node)
  })

  it('ignores a root observed twice', () => {
    const { observer } = harness()
    active = observer
    observer.observe(document.body)
    expect(observer.rootCount).toBe(1)
  })
})

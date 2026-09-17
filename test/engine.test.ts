import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeaver, weave } from '../src/index.js'
import type { LingoWeave } from '../src/core/engine.js'
import { custom } from '../src/providers/http.js'
import type { WeaveOptions } from '../src/types.js'

/**
 * A provider that prefixes each string, and records every call.
 *
 * `sent` is a function, not a getter: destructuring a getter would snapshot it
 * before any translation had happened.
 */
function fakeProvider(render: (text: string) => string = (t) => `[${t}]`) {
  const calls: string[][] = []
  const provider = custom(async (texts) => {
    calls.push([...texts])
    return texts.map(render)
  })
  return { calls, provider, sent: () => calls.flat() }
}

function page(html: string): void {
  document.documentElement.lang = 'en'
  document.body.innerHTML = html
}

let live: LingoWeave | null = null

async function start(options: WeaveOptions): Promise<LingoWeave> {
  const instance = await weave(options)
  live = instance
  await instance.whenIdle()
  return instance
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('dir')
})

afterEach(async () => {
  await live?.destroy()
  live = null
})

describe('weave, translating a page', () => {
  it('translates text, attributes and options in one pass', async () => {
    page(`
      <h1>Welcome</h1>
      <input placeholder="Search products">
      <img alt="A red bicycle" src="x">
      <button aria-label="Close dialog"></button>
      <select><option>Spain</option><option>France</option></select>`)

    const { provider } = fakeProvider()
    await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    expect(document.querySelector('h1')?.textContent).toBe('[Welcome]')
    expect(document.querySelector('input')?.placeholder).toBe('[Search products]')
    expect(document.querySelector('img')?.alt).toBe('[A red bicycle]')
    expect(document.querySelector('button')?.getAttribute('aria-label')).toBe('[Close dialog]')
    expect([...document.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      '[Spain]',
      '[France]',
    ])
  })

  it('translates a closed dropdown nobody has opened yet', async () => {
    page(`
      <nav>
        <button>Products</button>
        <ul style="display:none"><li>Laptops</li><li>Phones</li></ul>
      </nav>`)

    const { provider, sent } = fakeProvider()
    await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    expect(document.querySelectorAll('li')[0]?.textContent).toBe('[Laptops]')
    expect(sent()).toContain('Phones')
  })

  it('translates a submenu injected after the first pass', async () => {
    page('<nav><button>More</button></nav>')
    const { provider } = fakeProvider()
    const instance = await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    // Exactly what a dropdown does when the user clicks it.
    const submenu = document.createElement('ul')
    submenu.innerHTML = '<li>Settings</li><li>Sign out</li>'
    document.querySelector('nav')?.append(submenu)

    await settle()
    await instance.whenIdle()

    expect([...document.querySelectorAll('li')].map((l) => l.textContent)).toEqual([
      '[Settings]',
      '[Sign out]',
    ])
  })

  it('sends a sentence as one string instead of three fragments', async () => {
    page('<p>Only <b>signed-in</b> users can post</p>')
    const { provider, sent } = fakeProvider((text) => text.toUpperCase())
    await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    expect(sent()).toEqual(['Only <0>signed-in</0> users can post'])
    expect(document.querySelector('p')?.textContent).toBe('ONLY SIGNED-IN USERS CAN POST')
    expect(document.querySelector('b')?.textContent).toBe('SIGNED-IN')
  })

  it('falls back to per-node when a provider mangles the placeholders', async () => {
    page('<p>Only <b>signed-in</b> users can post</p>')
    // Drops the placeholders entirely, which is a real machine-translation
    // failure mode. Markup must survive it.
    const { provider } = fakeProvider((text) => text.replace(/<\/?\d+\/?>/g, ''))
    await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    expect(document.querySelector('b')).not.toBeNull()
    expect(document.querySelector('p')?.textContent).toContain('signed-in')
  })

  it('leaves the page in its source language when every provider fails', async () => {
    page('<h1>Welcome</h1>')
    const onError = vi.fn()
    const failing = custom(async () => {
      throw new Error('provider down')
    })

    await start({
      to: 'es',
      from: 'en',
      providers: [failing],
      cache: 'memory',
      onError,
      debug: false,
    })

    expect(document.querySelector('h1')?.textContent).toBe('Welcome')
    expect(onError).toHaveBeenCalled()
  })
})

describe('weave, cost control', () => {
  it('asks for each distinct string once, however often it appears', async () => {
    page(`
      <nav><a>Home</a><a>About</a></nav>
      <div class="mobile"><a>Home</a><a>About</a></div>
      <footer><a>Home</a></footer>`)

    const { provider, sent } = fakeProvider()
    await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    expect(sent().filter((t) => t === 'Home')).toHaveLength(1)
    expect(document.querySelectorAll('a')).toHaveLength(5)
  })

  it('costs nothing when a dictionary already covers the page', async () => {
    page('<h1>Welcome</h1><p>Sign in to continue</p>')
    const { provider, calls } = fakeProvider()

    await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      dictionaries: {
        es: { Welcome: 'Bienvenido', 'Sign in to continue': 'Inicia sesión para continuar' },
      },
    })

    expect(calls).toHaveLength(0)
    expect(document.querySelector('h1')?.textContent).toBe('Bienvenido')
    expect(document.querySelector('p')?.textContent).toBe('Inicia sesión para continuar')
  })

  it('applies dictionary text synchronously, before anything can paint', async () => {
    page('<h1>Welcome</h1>')
    const { provider } = fakeProvider()

    // No await between construction and the assertion: this is the no-flash path.
    const instance = createWeaver({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      dictionaries: { es: { Welcome: 'Bienvenido' } },
    })
    live = instance
    await instance.start()

    expect(document.querySelector('h1')?.textContent).toBe('Bienvenido')
  })

  it('reports what it spent and what it saved', async () => {
    page('<h1>Welcome</h1><p>Welcome</p>')
    const { provider } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    const stats = instance.stats()
    expect(stats.chars).toBe('Welcome'.length)
    expect(stats.requests).toBe(1)
    expect(stats.translated).toBe(2)
    expect(stats.charsSaved).toBeGreaterThan(0)
    expect(stats.errors).toBe(0)
  })

  it('exports what it learned as a dictionary', async () => {
    page('<h1>Welcome</h1>')
    const { provider } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    expect(Object.values(instance.export())).toEqual(['[Welcome]'])
  })
})

describe('weave, loop safety', () => {
  it('does not spin when onProgress writes into the translated page', async () => {
    // Found by running the demo: the stats readout lived inside the translated
    // root, so translating it fired onProgress, which rewrote it, which
    // translated it again, an unbounded loop that hung the browser tab.
    page('<h1>Welcome</h1><span id="readout"></span>')
    const { provider, calls } = fakeProvider()
    let progressCalls = 0

    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      debug: false,
      onProgress: (s) => {
        progressCalls++
        const out = document.getElementById('readout')
        if (out) out.textContent = `translated ${s.translated} of ${s.discovered} units`
      },
    })

    await settle()
    await instance.whenIdle()

    expect(progressCalls).toBeLessThan(40)
    expect(calls.length).toBeLessThan(40)
  })

  it('coalesces progress reporting instead of firing per unit', async () => {
    page('<p>One</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p>')
    const { provider } = fakeProvider()
    let progressCalls = 0

    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      onProgress: () => progressCalls++,
    })
    await instance.whenIdle()
    await settle()

    // Five units, but progress is batched rather than reported five times.
    expect(progressCalls).toBeGreaterThan(0)
    expect(progressCalls).toBeLessThan(5)
  })

  it('gives up on a node that will not sit still', async () => {
    page('<h1>Welcome</h1><span id="tick">Loading now</span>')
    const { provider } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      debug: false,
    })

    const tick = document.getElementById('tick') as HTMLElement
    for (let i = 0; i < 60; i++) {
      tick.textContent = `Updated ${i} times now`
      await settle()
    }
    await instance.whenIdle()

    // Far fewer requests than changes: the rate limiter stopped paying for a
    // node whose text nobody reads twice.
    expect(instance.stats().requests).toBeLessThan(30)
  })
})

describe('weave, human control over the machine', () => {
  it('lets an override beat the provider', async () => {
    page('<button>Sign in</button><button>Cancel</button>')
    const { provider, sent } = fakeProvider()

    await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      overrides: { es: { 'Sign in': 'Iniciar sesión' } },
    })

    expect(document.querySelectorAll('button')[0]?.textContent).toBe('Iniciar sesión')
    expect(document.querySelectorAll('button')[1]?.textContent).toBe('[Cancel]')
    expect(sent()).not.toContain('Sign in')
  })

  it('keeps glossary terms untouched', async () => {
    page('<span>Acme</span><span>Products</span>')
    const { provider, sent } = fakeProvider()

    await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      glossary: { Acme: 'Acme' },
    })

    expect(document.querySelectorAll('span')[0]?.textContent).toBe('Acme')
    expect(sent()).not.toContain('Acme')
  })

  it('honours translate="no" and the ignore list', async () => {
    page('<p translate="no">Acme Inc</p><pre>npm install</pre><div class="raw">Keep</div><p>Go</p>')
    const { provider, sent } = fakeProvider()

    await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
      ignore: ['.raw'],
    })

    expect(sent()).toEqual(['Go'])
  })
})

describe('weave, switching language', () => {
  it('switches and restores nothing stale', async () => {
    page('<h1>Welcome</h1>')
    const { provider } = fakeProvider((text) => `[${text}]`)
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    await instance.setLanguage('fr')
    await instance.whenIdle()

    expect(instance.language).toBe('fr')
    expect(document.documentElement.lang).toBe('fr')
    expect(document.querySelector('h1')?.textContent).toBe('[Welcome]')
  })

  it('returns to the source language cleanly', async () => {
    page('<h1>Welcome</h1>')
    const { provider } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    await instance.setLanguage('en')

    expect(document.querySelector('h1')?.textContent).toBe('Welcome')
  })

  it('flips the page to right-to-left for Arabic', async () => {
    page('<h1>Welcome</h1>')
    const { provider } = fakeProvider(() => 'مرحبا')
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    expect(document.documentElement.dir).toBe('ltr')

    await instance.setLanguage('ar')
    await instance.whenIdle()

    // Translating the words but leaving dir=ltr gives an unreadable layout.
    expect(document.documentElement.dir).toBe('rtl')
    expect(document.querySelector('h1')?.textContent).toBe('مرحبا')
  })

  it('remembers the visitor choice', async () => {
    page('<h1>Welcome</h1>')
    const { provider } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    await instance.setLanguage('fr')
    expect(localStorage.getItem('lingoweave:language')).toBe('fr')
  })

  it('does nothing when the target matches the source', async () => {
    page('<h1>Welcome</h1>')
    const { provider, calls } = fakeProvider()
    await start({ to: 'en', from: 'en', providers: [provider], cache: 'memory' })

    expect(calls).toHaveLength(0)
    expect(document.querySelector('h1')?.textContent).toBe('Welcome')
  })
})

describe('weave, surviving framework re-renders', () => {
  it('re-applies from cache with no extra provider call', async () => {
    page('<h1>Welcome</h1>')
    const { provider, calls } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    expect(calls).toHaveLength(1)

    // React re-renders and writes its own string straight back.
    const node = (document.querySelector('h1') as HTMLElement).firstChild as Text
    node.nodeValue = 'Welcome'
    await settle()
    await instance.whenIdle()

    expect(document.querySelector('h1')?.textContent).toBe('[Welcome]')
    // The whole point: recovery is free.
    expect(calls).toHaveLength(1)
  })

  it('recovers a re-rendered sentence block', async () => {
    page('<p>Only <b>signed-in</b> users can post</p>')
    const { provider } = fakeProvider((text) => text.toUpperCase())
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    const first = (document.querySelector('p') as HTMLElement).firstChild as Text
    first.nodeValue = 'Only '
    await settle()
    await instance.whenIdle()

    expect(document.querySelector('p')?.textContent).toBe('ONLY SIGNED-IN USERS CAN POST')
  })

  it('translates genuinely new text after a re-render', async () => {
    page('<h1>Welcome</h1>')
    const { provider, sent } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    const node = (document.querySelector('h1') as HTMLElement).firstChild as Text
    node.nodeValue = 'Goodbye'
    await settle()
    await instance.whenIdle()

    expect(sent()).toContain('Goodbye')
    expect(document.querySelector('h1')?.textContent).toBe('[Goodbye]')
  })
})

describe('weave, shadow DOM', () => {
  it('translates inside an open shadow root', async () => {
    page('<my-card></my-card>')
    const host = document.body.firstElementChild as HTMLElement
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>Inside shadow</p><button aria-label="Close">x</button>'

    const { provider } = fakeProvider()
    await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    expect(shadow.querySelector('p')?.textContent).toBe('[Inside shadow]')
    expect(shadow.querySelector('button')?.getAttribute('aria-label')).toBe('[Close]')
  })

  it('translates content added to a shadow root later', async () => {
    page('<my-card></my-card>')
    const host = document.body.firstElementChild as HTMLElement
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>First</p>'

    const { provider } = fakeProvider()
    const instance = await start({ to: 'es', from: 'en', providers: [provider], cache: 'memory' })

    const added = document.createElement('p')
    added.textContent = 'Second'
    shadow.append(added)
    await settle()
    await instance.whenIdle()

    expect(added.textContent).toBe('[Second]')
  })
})

describe('weave, teardown', () => {
  it('puts every original string back', async () => {
    page('<h1>Welcome</h1><input placeholder="Search">')
    const { provider } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    expect(document.querySelector('h1')?.textContent).toBe('[Welcome]')

    await instance.destroy()
    live = null

    expect(document.querySelector('h1')?.textContent).toBe('Welcome')
    expect(document.querySelector('input')?.placeholder).toBe('Search')
    expect(document.documentElement.lang).toBe('en')
  })

  it('stops translating new content after teardown', async () => {
    page('<h1>Welcome</h1>')
    const { provider, calls } = fakeProvider()
    const instance = await start({
      to: 'es',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })

    await instance.destroy()
    live = null
    const before = calls.length

    const added = document.createElement('p')
    added.textContent = 'Added later'
    document.body.append(added)
    await settle()

    expect(calls).toHaveLength(before)
    expect(added.textContent).toBe('Added later')
  })
})

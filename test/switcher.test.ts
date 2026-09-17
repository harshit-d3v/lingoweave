import { beforeAll, describe, expect, it, vi } from 'vitest'
import { defineSwitcher, LingoSwitcher } from '../src/switcher.js'

describe('lingo-switcher', () => {
  beforeAll(() => defineSwitcher())

  it('renders one option per language, current one selected', () => {
    document.documentElement.lang = 'es'
    document.body.innerHTML = '<lingo-switcher languages="en, es,ja"></lingo-switcher>'
    const el = document.querySelector('lingo-switcher') as LingoSwitcher
    const options = [...el.shadowRoot!.querySelectorAll('option')]
    expect(options.map((o) => o.value)).toEqual(['en', 'es', 'ja'])
    expect(options.map((o) => o.textContent)).toEqual(['English', 'Español', '日本語'])
    expect(el.value).toBe('es')
    expect(el.getAttribute('translate')).toBe('no')
  })

  it('dispatches lingo-change and calls the weaver', async () => {
    document.body.innerHTML = '<lingo-switcher languages="en,fr"></lingo-switcher>'
    const el = document.querySelector('lingo-switcher') as LingoSwitcher
    const setLanguage = vi.fn(async () => {})
    el.weaver = { setLanguage, language: 'en' } as never
    const seen: string[] = []
    document.addEventListener('lingo-change', (e) => seen.push((e as CustomEvent).detail.language))

    const select = el.shadowRoot!.querySelector('select')!
    select.value = 'fr'
    select.dispatchEvent(new Event('change'))
    await Promise.resolve()

    expect(seen).toEqual(['fr'])
    expect(setLanguage).toHaveBeenCalledWith('fr')
  })

  it('skips the weaver when the event is cancelled', async () => {
    document.body.innerHTML = '<lingo-switcher languages="en,fr"></lingo-switcher>'
    const el = document.querySelector('lingo-switcher') as LingoSwitcher
    const setLanguage = vi.fn(async () => {})
    el.weaver = { setLanguage, language: 'en' } as never
    el.addEventListener('lingo-change', (e) => e.preventDefault())

    const select = el.shadowRoot!.querySelector('select')!
    select.value = 'fr'
    select.dispatchEvent(new Event('change'))
    await Promise.resolve()

    expect(setLanguage).not.toHaveBeenCalled()
  })
})

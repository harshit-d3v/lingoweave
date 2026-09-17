/**
 * `<lingo-switcher>`: a language dropdown that drives a {@link LingoWeave}.
 *
 * ```html
 * <lingo-switcher languages="en,es,ja"></lingo-switcher>
 * <script type="module">
 *   import { weave } from 'lingoweave'
 *   import 'lingoweave/switcher'
 *   document.querySelector('lingo-switcher').weaver = await weave({ to: 'auto' })
 * </script>
 * ```
 *
 * Picking a language dispatches a cancelable `lingo-change` event with
 * `detail.language`, then calls `weaver.setLanguage()` if a weaver is attached.
 */

import type { LingoWeave } from './core/engine.js'

const NAMES: Record<string, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  ar: 'العربية',
  hi: 'हिन्दी',
  ru: 'Русский',
}

export class LingoSwitcher extends HTMLElement {
  static observedAttributes = ['languages', 'value']

  weaver: LingoWeave | null = null
  private select: HTMLSelectElement

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<style>select{font:inherit}</style><select aria-label="Language"></select>'
    this.select = root.querySelector('select')!
    this.select.addEventListener('change', () => void this.choose(this.select.value))
  }

  connectedCallback(): void {
    this.setAttribute('translate', 'no')
    this.render()
  }

  attributeChangedCallback(): void {
    this.render()
  }

  get value(): string {
    return this.select.value
  }

  set value(code: string) {
    this.select.value = code
  }

  private render(): void {
    const codes = (this.getAttribute('languages') ?? Object.keys(NAMES).join(','))
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean)
    const current =
      this.getAttribute('value') ?? this.weaver?.language ?? document.documentElement.lang ?? codes[0]
    this.select.replaceChildren(
      ...codes.map((code) => {
        const option = document.createElement('option')
        option.value = code
        option.textContent = NAMES[code] ?? code
        option.selected = code === current
        return option
      }),
    )
  }

  private async choose(language: string): Promise<void> {
    const event = new CustomEvent('lingo-change', { detail: { language }, bubbles: true, cancelable: true })
    if (!this.dispatchEvent(event)) return
    await this.weaver?.setLanguage(language)
  }
}

export function defineSwitcher(tag = 'lingo-switcher'): void {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) {
    customElements.define(tag, LingoSwitcher)
  }
}

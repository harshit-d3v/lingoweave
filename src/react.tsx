/**
 * React bindings for lingoweave.
 *
 * ```tsx
 * import { LingoweaveProvider, useLingoweave } from 'lingoweave/react'
 *
 * function App() {
 *   return (
 *     <LingoweaveProvider to="es">
 *       <Page />
 *     </LingoweaveProvider>
 *   )
 * }
 *
 * function LanguagePicker() {
 *   const { language, setLanguage } = useLingoweave()
 *   return (
 *     <select value={language} onChange={(e) => setLanguage(e.target.value)}>
 *       <option value="en">English</option>
 *       <option value="es">Español</option>
 *     </select>
 *   )
 * }
 * ```
 *
 * lingoweave never replaces, wraps or moves a DOM node, so it does not trip
 * React's `removeChild` error the way `<font>`-based translators do. The
 * provider just owns the {@link LingoWeave} lifecycle: it starts on mount,
 * follows the `to` prop, and destroys on unmount.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createWeaver } from './index.js'
import type { LingoWeave } from './core/engine.js'
import type { LanguageCode, Stats, WeaveOptions } from './types.js'

export interface LingoweaveContextValue {
  /** The live instance, or `null` before it has started. */
  weaver: LingoWeave | null
  /** Current target language. Empty string until the weaver has started. */
  language: LanguageCode
  /** Resolved source language, or empty string before start. */
  sourceLanguage: LanguageCode
  /** `true` once the first translation pass has run. */
  ready: boolean
  /** Switch language, reusing everything already cached. */
  setLanguage: (to: LanguageCode) => Promise<void>
  /** Current cost and coverage, or `null` before start. */
  stats: () => Stats | null
}

const LingoweaveContext = createContext<LingoweaveContextValue | null>(null)

export interface LingoweaveProviderProps extends WeaveOptions {
  children?: ReactNode
  /**
   * Use an instance you started yourself instead of letting the provider own
   * one. A supplied weaver is never destroyed by the provider.
   */
  weaver?: LingoWeave
}

export function LingoweaveProvider(props: LingoweaveProviderProps): ReactNode {
  const { children, weaver: supplied, ...options } = props

  const [weaver, setWeaver] = useState<LingoWeave | null>(supplied ?? null)
  const [language, setLanguageState] = useState<LanguageCode>(
    supplied?.language ?? (options.to === 'auto' ? '' : options.to),
  )
  const [ready, setReady] = useState<boolean>(Boolean(supplied))

  // Latest options without re-running the start effect on every render.
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Start on mount. Runs only on the client, so it is SSR-safe: nothing here
  // touches the DOM during render.
  useEffect(() => {
    if (supplied) {
      setWeaver(supplied)
      setLanguageState(supplied.language)
      setReady(true)
      return
    }
    let active = true
    const instance = createWeaver(optionsRef.current)
    void instance.start().then(() => {
      if (!active) return
      setWeaver(instance)
      setLanguageState(instance.language)
      setReady(true)
    })
    return () => {
      active = false
      void instance.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplied])

  // Follow the `to` prop after the first pass.
  const to = options.to
  useEffect(() => {
    if (!weaver || to === 'auto' || to === weaver.language) return
    void weaver.setLanguage(to).then(() => setLanguageState(weaver.language))
  }, [weaver, to])

  const value: LingoweaveContextValue = {
    weaver,
    language,
    sourceLanguage: weaver?.sourceLanguage ?? '',
    ready,
    setLanguage: async (next: LanguageCode) => {
      if (!weaver) return
      await weaver.setLanguage(next)
      setLanguageState(weaver.language)
    },
    stats: () => weaver?.stats() ?? null,
  }

  return (
    <LingoweaveContext.Provider value={value}>
      {children}
    </LingoweaveContext.Provider>
  )
}

/** Read the lingoweave context. Throws if used outside a provider. */
export function useLingoweave(): LingoweaveContextValue {
  const value = useContext(LingoweaveContext)
  if (!value) {
    throw new Error('useLingoweave must be used inside a <LingoweaveProvider>')
  }
  return value
}

/** The raw {@link LingoWeave} instance, or `null` before it has started. */
export function useWeaver(): LingoWeave | null {
  return useLingoweave().weaver
}

export interface LanguageSwitcherProps {
  /** Language codes to offer. Values double as labels when no label is given. */
  languages: Array<LanguageCode | { code: LanguageCode; label: string }>
  className?: string
}

/**
 * A plain `<select>` wired to the provider. Marked `translate="no"` so its own
 * options are not translated.
 */
export function LanguageSwitcher(props: LanguageSwitcherProps): ReactNode {
  const { language, setLanguage } = useLingoweave()
  const options = props.languages.map((entry) =>
    typeof entry === 'string' ? { code: entry, label: entry } : entry,
  )
  return (
    <select
      translate="no"
      className={props.className}
      value={language}
      onChange={(event) => void setLanguage(event.target.value)}
      aria-label="Language"
    >
      {options.map((option) => (
        <option key={option.code} value={option.code}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

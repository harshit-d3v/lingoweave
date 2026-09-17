import { LingoWeave } from './core/engine.js'
import type { LanguageCode, WeaveOptions } from './types.js'

/**
 * Translate the whole page, and keep it translated.
 *
 * ```ts
 * import { weave } from 'lingoweave'
 *
 * await weave({ to: 'es' })
 * ```
 *
 * That covers text, `placeholder`, `alt`, `aria-label`, `<option>`, the tab
 * title, Open Graph descriptions, SVG labels, closed dropdowns, unopened modals,
 * and anything a framework renders later. Node identity is never disturbed, so
 * React and friends keep working.
 *
 * With no `providers` set it uses the browser's on-device translator where that
 * exists, and a keyless endpoint on localhost so the first run works with no
 * account. In production, configure a provider, see `lingoweave/providers`.
 */
export async function weave(options: WeaveOptions): Promise<LingoWeave> {
  const instance = new LingoWeave(options)
  return instance.start()
}

/**
 * Build an instance without starting it.
 *
 * Use this when you need to hold a reference before translation begins, for
 * example to render a language switcher that is already wired up.
 */
export function createWeaver(options: WeaveOptions): LingoWeave {
  return new LingoWeave(options)
}

export { LingoWeave }

export { directionFor, isRtl } from './core/rtl.js'

export type {
  AttributeUnit,
  BlockUnit,
  CacheMode,
  CloakMode,
  LanguageCode,
  Provider,
  Stats,
  TextUnit,
  TranslationUnit,
  UnitKind,
  WeaveOptions,
} from './types.js'

export type { LanguageCode as Language }

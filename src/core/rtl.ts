/**
 * Right-to-left language handling.
 *
 * Translating the words but leaving `dir="ltr"` produces a page that is
 * technically correct and unreadable: punctuation lands on the wrong side,
 * mixed Latin and Arabic runs reorder wrongly, and every margin sits on the
 * wrong edge. Nobody else does this automatically, and it is one line of DOM.
 */

/** Language subtags written right-to-left, by ISO 639-1 and 639-2 code. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  'ar', // Arabic
  'arc', // Aramaic
  'ckb', // Central Kurdish
  'dv', // Divehi
  'fa', // Persian
  'ha', // Hausa (Ajami script)
  'he', // Hebrew
  'khw', // Khowar
  'ks', // Kashmiri
  'ku', // Kurdish
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'ur', // Urdu
  'yi', // Yiddish
])

/** Whether a BCP-47 tag is written right-to-left. */
export function isRtl(language: string): boolean {
  const [primary] = language.toLowerCase().split('-')
  return primary !== undefined && RTL_LANGUAGES.has(primary)
}

/** `'rtl'` or `'ltr'` for a language tag. */
export function directionFor(language: string): 'rtl' | 'ltr' {
  return isRtl(language) ? 'rtl' : 'ltr'
}

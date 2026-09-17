/**
 * The registry of everything on a page that carries human-readable text.
 *
 * "Translate the whole site" fails in practice not because text nodes are hard
 * but because the long tail gets missed: the search box placeholder, the icon
 * button's `aria-label`, the `<option>` list, the tab title, the Open Graph
 * description that shows up when someone shares the page. This module is the
 * single list of what counts, so nothing is forgotten in one code path and
 * handled in another.
 */

/** Attributes translated on any element that has them. */
export const DEFAULT_ATTRIBUTES: readonly string[] = [
  'title',
  'alt',
  'placeholder',
  'label',
  'aria-label',
  'aria-placeholder',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-keyshortcuts',
]

/**
 * `<meta>` names and properties worth translating. Everything else in `<head>`
 * is machine-facing, translating `viewport` or `charset` would break the page.
 */
const TRANSLATABLE_META = new Set([
  'description',
  'keywords',
  'application-name',
  'apple-mobile-web-app-title',
  'og:title',
  'og:description',
  'og:site_name',
  'og:image:alt',
  'twitter:title',
  'twitter:description',
  'twitter:image:alt',
])

/** `value` is a label on these input types and user data on every other one. */
const VALUE_INPUT_TYPES = new Set(['button', 'submit', 'reset'])

/**
 * Elements whose *contents* are notation or machine input rather than prose.
 *
 * Their own attributes are still translated, a `<textarea placeholder="Write a
 * review">` needs that placeholder even though its text content is the user's
 * own draft, and an `<iframe title="Payment form">` needs its title. Content and
 * attributes are two separate decisions, and conflating them is how the long
 * tail goes missing.
 *
 * `TEMPLATE` is inert: its contents get translated when they are cloned into the
 * document and the observer picks them up.
 */
export const SKIP_CONTENT_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'TEXTAREA',
  'MATH',
  'CANVAS',
  'AUDIO',
  'VIDEO',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG-STYLE',
])

/**
 * Inline elements, used to decide whether a block's children form one sentence.
 * Kept as a static set rather than reading `getComputedStyle`, which would cost
 * a layout flush per element on the hot path.
 */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'BR',
  'CITE',
  'CODE',
  'DATA',
  'DEL',
  'DFN',
  'EM',
  'I',
  'INS',
  'KBD',
  'MARK',
  'Q',
  'RP',
  'RT',
  'RUBY',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'VAR',
  'WBR',
  'IMG',
  'PICTURE',
  'BUTTON',
  'LABEL',
  'SELECT',
  'INPUT',
])

/**
 * Which attributes on this specific element should be translated.
 *
 * `extra` is appended rather than replacing the defaults, so a caller adding
 * `data-tooltip` for their tooltip library does not silently lose `aria-label`.
 */
export function translatableAttributes(element: Element, extra: readonly string[] = []): string[] {
  const found: string[] = []
  const tag = element.tagName.toUpperCase()

  for (const name of DEFAULT_ATTRIBUTES) {
    if (element.hasAttribute(name)) found.push(name)
  }
  for (const name of extra) {
    if (!found.includes(name) && element.hasAttribute(name)) found.push(name)
  }

  if (tag === 'INPUT') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase()
    if (VALUE_INPUT_TYPES.has(type) && element.hasAttribute('value')) found.push('value')
  }

  if (tag === 'META' && element.hasAttribute('content')) {
    const key = (element.getAttribute('name') ?? element.getAttribute('property') ?? '')
      .toLowerCase()
    if (TRANSLATABLE_META.has(key)) found.push('content')
  }

  return found
}

/**
 * Whether to stop descending into this element. Its own attributes should still
 * be read before the walk turns back.
 */
export function skipsContent(element: Element): boolean {
  return SKIP_CONTENT_TAGS.has(element.tagName.toUpperCase())
}

/**
 * Inline elements that hold no text of their own. They still need a placeholder
 * so a translation can move them within the sentence, `<br>` and `<img>` land
 * in different positions in different languages.
 */
export const VOID_INLINE_TAGS: ReadonlySet<string> = new Set([
  'BR',
  'WBR',
  'IMG',
  'INPUT',
  'PICTURE',
])

export function isInlineTag(element: Element): boolean {
  return INLINE_TAGS.has(element.tagName.toUpperCase())
}

export function isVoidInlineTag(element: Element): boolean {
  return VOID_INLINE_TAGS.has(element.tagName.toUpperCase())
}

/** Collapse runs of whitespace the way HTML rendering already does. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ')
}

/**
 * Text worth paying for.
 *
 * Requires at least one Unicode letter, which drops the enormous tail of
 * bullets, arrows, dashes, currency symbols, counts and timestamps that a
 * naive walker would happily bill you for and often mangle.
 */
export function isTranslatableText(text: string): boolean {
  return /\p{L}/u.test(text)
}

/** Split a raw text node value into its whitespace shell and its content. */
export function splitWhitespace(raw: string): {
  prefix: string
  core: string
  suffix: string
} {
  const start = raw.length - raw.trimStart().length
  const end = raw.trimEnd().length
  return {
    prefix: raw.slice(0, start),
    core: raw.slice(start, end),
    suffix: raw.slice(end),
  }
}

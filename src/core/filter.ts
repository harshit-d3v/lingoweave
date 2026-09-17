import { isTranslatableText, skipsContent, splitWhitespace } from './surface.js'

export interface FilterOptions {
  /** CSS selectors whose subtrees are left alone. */
  ignore?: readonly string[]
  /** Called when a supplied selector is invalid. */
  onWarning?: (message: string) => void
}

/**
 * Decides what the scanner is allowed to touch.
 *
 * Deliberately does **not** skip hidden elements. A closed dropdown, a collapsed
 * submenu and an unopened modal are all `display: none` at first paint, and they
 * are exactly the content people complain never gets translated. Skipping them
 * would be cheaper and wrong.
 */
export class TranslationFilter {
  private readonly ignoreSelector: string | null

  constructor(private readonly options: FilterOptions = {}) {
    this.ignoreSelector = compileSelector(options.ignore, options.onWarning)
  }

  /**
   * Whether to ignore this element completely, attributes included.
   *
   * Everything here is an explicit "leave this alone" from the page author, so
   * unlike {@link skipsChildren} it also suppresses attribute translation.
   */
  skipsSubtree(element: Element): boolean {
    // The standard opt-out, honoured by browsers and every major MT vendor.
    if (element.getAttribute('translate') === 'no') return true

    // Google's long-standing convention, which plenty of sites already use.
    if (element.classList?.contains('notranslate')) return true

    if (element.hasAttribute('data-lw-ignore')) return true

    // Editable regions hold the user's own words, mid-composition.
    const editable = element.getAttribute('contenteditable')
    if (editable !== null && editable !== 'false') return true

    if (this.ignoreSelector !== null) {
      try {
        if (element.matches(this.ignoreSelector)) return true
      } catch {
        /* already warned at construction */
      }
    }

    return false
  }

  /**
   * Whether to stop descending, having already read this element's attributes.
   * Tag-based: `<code>`, `<textarea>`, `<script>` and friends.
   */
  skipsChildren(element: Element): boolean {
    return skipsContent(element)
  }

  /** Whether a text node carries prose worth sending to a provider. */
  acceptsText(node: Text): boolean {
    const raw = node.nodeValue
    if (raw === null || raw.length === 0) return false
    const { core } = splitWhitespace(raw)
    if (core.length === 0) return false
    return isTranslatableText(core)
  }

  /** Whether an attribute value is worth sending. */
  acceptsAttribute(value: string): boolean {
    return value.trim().length > 0 && isTranslatableText(value)
  }
}

function compileSelector(
  selectors: readonly string[] | undefined,
  onWarning?: (message: string) => void,
): string | null {
  if (!selectors || selectors.length === 0) return null

  const valid: string[] = []
  for (const selector of selectors) {
    try {
      // Cheapest way to validate without a live element.
      document.createDocumentFragment().querySelector(selector)
      valid.push(selector)
    } catch {
      onWarning?.(`lingoweave: ignoring invalid selector ${JSON.stringify(selector)}`)
    }
  }

  return valid.length > 0 ? valid.join(',') : null
}

/**
 * A BCP-47 language tag, e.g. `'en'`, `'es'`, `'pt-BR'`, `'ar'`.
 */
export type LanguageCode = string

/**
 * A translation backend. Everything is a provider, the browser's on-device
 * model, a cloud API, a self-hosted LibreTranslate, or an arbitrary function.
 *
 * `translate` receives a batch and MUST return one result per input, in the
 * same order. Throwing tells the chain to fall through to the next provider.
 */
export interface Provider {
  /** Stable id, used in logs and stats. */
  readonly id: string

  /**
   * Whether this provider can currently serve the given language pair.
   * Checked once per language change, so it may be expensive (e.g. probing
   * `Translator.availability()`).
   */
  available(from: LanguageCode, to: LanguageCode): Promise<boolean>

  translate(texts: string[], from: LanguageCode, to: LanguageCode): Promise<string[]>

  /**
   * Cost in USD per million characters, used by {@link Stats.estimatedCost}.
   * `0` for on-device and self-hosted providers.
   */
  readonly costPerMillionChars?: number

  /** Max characters the provider accepts in one request. Default 5000. */
  readonly maxBatchChars?: number

  /** Max separate strings the provider accepts in one request. Default 100. */
  readonly maxBatchSize?: number
}

/** What kind of thing a {@link TranslationUnit} points at. */
export type UnitKind = 'text' | 'attribute' | 'block'

/**
 * A bare text node.
 *
 * `source` is trimmed and {@link prefix}/{@link suffix} hold the original
 * surrounding whitespace. Translating `'\n      Save\n    '` verbatim wastes
 * characters and comes back with the indentation collapsed, which silently
 * removes the space between inline elements.
 */
export interface TextUnit {
  kind: 'text'
  node: Text
  source: string
  prefix: string
  suffix: string
}

/** A translatable attribute on an element, e.g. `placeholder` or `aria-label`. */
export interface AttributeUnit {
  kind: 'attribute'
  element: Element
  attribute: string
  source: string
}

/**
 * A block-level element whose inline children were merged into one sentence
 * so the machine translator sees whole grammar rather than fragments.
 *
 * `source` carries numbered placeholders for inline markup:
 * `'Hello <0>world</0>, welcome'`
 */
export interface BlockUnit {
  kind: 'block'
  element: Element
  /** Leaf text nodes in document order, matching the placeholder layout. */
  nodes: Text[]
  /** Placeholder path per node, parallel to {@link nodes}. */
  paths: string[]
  /**
   * How many placeholders at this node's own level come before it, parallel to
   * {@link nodes}. Together with {@link paths} this pins a node to a position
   * in the sentence rather than just to an inline container, so a translation
   * that moves an inline element to the front still reads in the right order.
   */
  slots: number[]
  /**
   * Each node's own original text, trimmed, parallel to {@link nodes}. Recorded
   * here so a re-render can still be recognised after the block was rewritten.
   */
  sources: string[]
  /**
   * Each node's untrimmed original value, parallel to {@link nodes}.
   *
   * Needed because restoring a block from the trimmed text alone deletes the
   * spaces around inline elements, `Only <b>signed-in</b> users` comes back as
   * `Only<b>signed-in</b>users`. That corrupts the page on teardown and on every
   * language switch, and each switch compounds it.
   */
  raws: string[]
  source: string
}

export type TranslationUnit = TextUnit | AttributeUnit | BlockUnit

/** How aggressively to hide un-translated text during the first pass. */
export type CloakMode = 'none' | 'blur' | 'hide'

/** Where translations are persisted between visits. */
export type CacheMode = 'memory' | 'indexeddb' | false

export interface WeaveOptions {
  /**
   * Target language. `'auto'` resolves from `navigator.languages`, falling
   * back to {@link from} when the visitor already speaks the source language.
   */
  to: LanguageCode | 'auto'

  /** Source language. `'auto'` reads `<html lang>`, then sniffs the page. */
  from?: LanguageCode | 'auto'

  /**
   * `'auto'` builds the default chain: on-device browser translator first,
   * then a free public endpoint **on localhost only**, then nothing.
   * Pass an array to take control.
   */
  providers?: Provider[] | 'auto'

  /** Root to translate. Defaults to `document.documentElement`. */
  root?: Element | Document | ShadowRoot

  cache?: CacheMode

  /**
   * Pre-translated strings, keyed by language. Produced by
   * `npx lingoweave extract`. Seeded entries cost nothing and apply
   * synchronously, which is what removes the un-translated flash.
   */
  dictionaries?: Partial<Record<LanguageCode, Record<string, string>>>

  /** Translate what is on screen first. Strongly recommended. */
  lazy?: boolean

  /** Walk into open shadow roots. Default `true`. */
  shadowDom?: boolean

  /**
   * Also register roots created with `mode: 'closed'`. Requires
   * `lingoweave/preload` to run before any component calls `attachShadow`.
   */
  closedShadowDom?: boolean

  /** Walk into same-origin iframes. Default `false`. */
  iframes?: boolean

  /** Extra attributes to translate, added to the defaults. */
  attributes?: string[]

  /** CSS selectors whose subtrees are left alone. */
  ignore?: string[]

  /**
   * Terms that must survive untranslated, brand names, product names.
   * Keys are matched case-sensitively as whole words.
   */
  glossary?: Record<string, string>

  /** Hand-written translations that beat the machine, keyed by language. */
  overrides?: Partial<Record<LanguageCode, Record<string, string>>>

  /** Flip `dir` and `<html lang>` for RTL languages. Default `true`. */
  rtl?: boolean

  cloak?: CloakMode

  /** Milliseconds before {@link cloak} gives up and reveals the page anyway. */
  cloakTimeout?: number

  /** Persist the visitor's language choice. Default `true`. */
  persistChoice?: boolean

  onProgress?: (stats: Stats) => void

  onError?: (error: Error, context: { provider?: string; texts?: string[] }) => void

  /** Log every decision to the console, and expose the debug overlay. */
  debug?: boolean
}

export interface Stats {
  /** Characters actually sent to a provider, what you get billed for. */
  chars: number
  /** Characters served from cache, dictionary or override instead. */
  charsSaved: number
  /** Provider requests made. */
  requests: number
  /** Units discovered in the DOM. */
  discovered: number
  /** Units translated so far. */
  translated: number
  /** Units still queued. */
  pending: number
  cacheHits: number
  cacheMisses: number
  /** `cacheHits / (cacheHits + cacheMisses)`, or 0 before any lookup. */
  cacheHitRate: number
  /** USD, from each provider's `costPerMillionChars`. */
  estimatedCost: number
  errors: number
}

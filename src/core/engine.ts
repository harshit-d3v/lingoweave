import { defaultChain } from '../providers/chain.js'
import { detectLanguageOnDevice } from '../providers/chrome-builtin.js'
import { chain } from '../providers/chain.js'
import type {
  AttributeUnit,
  BlockUnit,
  LanguageCode,
  Provider,
  Stats,
  TextUnit,
  TranslationUnit,
  WeaveOptions,
} from '../types.js'
import { Applier } from './applier.js'
import { TranslationCache } from './cache.js'
import { TranslationFilter } from './filter.js'
import { DomObserver } from './observer.js'
import { TranslationQueue } from './queue.js'
import { cacheKey } from './hash.js'
import { isSkippedContext, scan } from './scanner.js'
import { redistribute } from './segmenter.js'
import { isRtl } from './rtl.js'

const CHOICE_KEY = 'lingoweave:language'

/** Loop breaker: translations allowed per node per window before backing off. */
const CHURN_LIMIT = 12
const CHURN_WINDOW_MS = 1000

/**
 * Orchestrates a translated page.
 *
 * The ordering here is what produces a page that does not flicker: every unit is
 * checked against the cache *synchronously* first, and anything already known is
 * written in the same task. Only genuine misses reach the queue. On a repeat
 * visit that means the whole page is translated before the browser paints, with
 * no network involved at all.
 */
export class LingoWeave {
  private readonly applier = new Applier()
  private readonly filter: TranslationFilter
  private readonly cache: TranslationCache
  private readonly observer: DomObserver
  private readonly queue: TranslationQueue
  private readonly provider: Provider
  private readonly observedRoots = new WeakSet<Node>()

  private readonly options: WeaveOptions
  private readonly root: Node

  private source: LanguageCode = 'en'
  private target: LanguageCode = 'en'
  private started = false
  private destroyed = false

  private discovered = 0
  private translated = 0
  private charsSaved = 0
  private errors = 0
  private progressScheduled = false
  /** Sources already sent this session, for accurate savings accounting. */
  private requestedSources = new Set<string>()
  /** How often each node's content has churned, for the loop breaker. */
  private readonly churn = new WeakMap<Node, { count: number; since: number }>()
  private churnWarned = false

  constructor(options: WeaveOptions) {
    this.options = options
    this.root = options.root ?? document.documentElement

    const warn = (message: string): void => {
      if (options.debug !== false) console.warn(message)
    }

    this.filter = new TranslationFilter({
      ignore: options.ignore,
      onWarning: warn,
    })

    this.cache = new TranslationCache(options.cache ?? 'indexeddb')

    this.provider =
      options.providers === undefined || options.providers === 'auto'
        ? defaultChain({ onWarning: warn })
        : chain(options.providers, { onWarning: warn })

    this.queue = new TranslationQueue({
      translate: (texts) => this.provider.translate(texts, this.source, this.target),
      maxBatchChars: this.provider.maxBatchChars,
      maxBatchSize: this.provider.maxBatchSize,
      onError: (error, texts) => {
        this.errors++
        options.onError?.(error, { provider: this.provider.id, texts })
      },
    })

    this.observer = new DomObserver(
      this.applier,
      {
        onNewContent: (nodes) => this.handleNewContent(nodes),
        onTextReset: (node, source) => this.handleTextReset(node, source),
        onAttributeReset: (element, attribute, source) =>
          this.handleAttributeReset(element, attribute, source),
      },
      { attributes: options.attributes },
    )
  }

  get language(): LanguageCode {
    return this.target
  }

  get sourceLanguage(): LanguageCode {
    return this.source
  }

  /** Resolve languages, seed the cache, translate what is there, then watch. */
  async start(): Promise<this> {
    if (this.started) return this
    this.started = true

    this.source = await this.resolveSource()
    this.target = this.resolveTarget(this.source)

    await this.cache.open()
    this.seedDictionary(this.target)

    if (this.target === this.source) {
      // Nothing to do, but stay mounted so setLanguage() still works.
      this.applyDocumentLanguage()
      return this
    }

    this.applyDocumentLanguage()
    this.translateTree(this.root, true)
    this.observeTree(this.root)

    return this
  }

  /** Switch language, reusing everything already cached. */
  async setLanguage(to: LanguageCode): Promise<void> {
    if (this.destroyed || to === this.target) return

    // Restoring rewrites hundreds of nodes. With the observer live, each of
    // those writes reads as brand-new content, so every text node gets queued
    // individually, and those per-node requests race the whole-sentence blocks
    // this pass is about to build, and win. Pausing drops the records, which is
    // right: the entire tree is re-translated on the next line anyway.
    this.observer.pause()
    try {
      this.applier.restore()
      this.target = to
      // Savings accounting is per language: the same strings must be paid for
      // again in the new one, unless the cache already has them.
      this.requestedSources = new Set()
      this.seedDictionary(to)
      this.persistChoice(to)
      this.applyDocumentLanguage()

      if (to !== this.source) this.translateTree(this.root, true)
    } finally {
      this.observer.resume()
    }
  }

  stats(): Stats {
    const hits = this.cache.hits
    const misses = this.cache.misses
    const lookups = hits + misses

    return {
      chars: this.queue.chars,
      charsSaved: this.charsSaved,
      requests: this.queue.requests,
      discovered: this.discovered,
      translated: this.translated,
      pending: this.queue.pending + this.queue.inFlight,
      cacheHits: hits,
      cacheMisses: misses,
      cacheHitRate: lookups === 0 ? 0 : hits / lookups,
      estimatedCost: (this.queue.chars / 1_000_000) * (this.provider.costPerMillionChars ?? 0),
      errors: this.errors + this.queue.errors,
    }
  }

  /** Everything learned at runtime, ready to commit as a dictionary file. */
  export(): Record<string, string> {
    return this.cache.export()
  }

  /**
   * Resolve once every queued translation has been applied.
   *
   * Useful for prerendering, for screenshot tests, and for knowing when
   * `export()` holds the full picture.
   */
  async whenIdle(): Promise<void> {
    // New content can be discovered while draining, a translated block that a
    // framework re-renders, for instance, so keep going until it settles.
    for (let pass = 0; pass < 10; pass++) {
      this.observer.flush()
      await this.queue.flush()
      if (this.queue.idle) break
    }
  }

  /** Force a re-scan, e.g. after replacing a widget's contents yourself. */
  retranslate(root: Node = this.root): void {
    this.translateTree(root, true)
  }

  pause(): void {
    this.observer.pause()
  }

  resume(): void {
    this.observer.resume()
    this.translateTree(this.root, false)
  }

  /** Put the original text back and release everything. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true

    this.observer.disconnect()
    this.queue.destroy()
    this.applier.restore()
    await this.cache.flush()
    this.cache.close()

    document.documentElement.lang = this.source
    document.documentElement.removeAttribute('dir')
  }

  // ---------------------------------------------------------------- internals

  private translateTree(root: Node, priority: boolean, live = false): void {
    if (this.destroyed || this.target === this.source) return

    const result = scan(root, this.filter, {
      attributes: this.options.attributes,
      shadowDom: this.options.shadowDom !== false,
    })

    this.discovered += result.units.length
    for (const unit of result.units) this.translateUnit(unit, priority, live)

    for (const shadow of result.shadowRoots) {
      this.translateTree(shadow, priority, live)
      this.observeTree(shadow)
    }
  }

  private observeTree(root: Node): void {
    if (this.observedRoots.has(root)) return
    this.observedRoots.add(root)
    this.observer.observe(root)
  }

  private translateUnit(unit: TranslationUnit, priority: boolean, live = false): void {
    const source = unit.source

    // Only observer-driven work can loop; the first pass is bounded by the page.
    if (live && this.tooVolatile(unit)) return

    const known = this.lookup(source)
    if (known !== undefined) {
      // Synchronous path: nothing is queued, nothing flickers, nothing is billed.
      this.charsSaved += source.length
      this.write(unit, known, live)
      return
    }

    // A repeat that the queue will de-duplicate still avoids a charge, so it
    // belongs in charsSaved, otherwise the saving from a nav label appearing in
    // a desktop menu, a mobile menu and a footer looks like nothing.
    if (this.requestedSources.has(source)) this.charsSaved += source.length
    else this.requestedSources.add(source)

    void this.queue
      .request(source, priority)
      .then((result) => {
        if (this.destroyed) return
        this.cache.set(cacheKey(source, this.target), result)
        this.write(unit, result, live)
      })
      .catch(() => {
        // Already reported through onError; leaving the source text visible is
        // the correct outcome for a failed translation.
      })
  }

  /**
   * Refuse to keep translating a node whose content will not sit still.
   *
   * Two things land here. A live region, a counter, a timer, a progress
   * readout, would otherwise be re-translated on every tick, burning requests
   * on text nobody reads twice. And more importantly it breaks feedback loops:
   * if application code writes to the DOM in reaction to translated text, or in
   * an `onProgress` handler, each write triggers a translation which triggers
   * another write. Without a limiter that never terminates.
   *
   * The bound is a rate, not a total, so a node that legitimately changes now
   * and then keeps being translated for as long as the page lives.
   */
  private tooVolatile(unit: TranslationUnit): boolean {
    // Keyed on the parent, not the text node: assigning to `textContent`
    // replaces the node outright, so a per-node counter would reset on every
    // write and never notice the churn it exists to catch.
    const key: Node =
      unit.kind === 'text' ? (unit.node.parentNode ?? unit.node) : unit.element

    const now = Date.now()
    const record = this.churn.get(key)

    if (!record || now - record.since > CHURN_WINDOW_MS) {
      this.churn.set(key, { count: 1, since: now })
      return false
    }

    record.count++
    if (record.count <= CHURN_LIMIT) return false

    if (!this.churnWarned) {
      this.churnWarned = true
      if (this.options.debug !== false) {
        console.warn(
          'lingoweave: a node is changing too fast to translate and is being left alone. ' +
            'If this is your own UI, a counter, a stats readout, an onProgress handler writing ' +
            'to the page, mark it translate="no" or move it outside the translated root.',
        )
      }
    }
    return true
  }

  /**
   * Report progress at most once per microtask.
   *
   * Called per unit it would fire hundreds of times during the first pass, and
   * any handler that touches the DOM would recurse straight back into the engine.
   */
  private notifyProgress(): void {
    if (!this.options.onProgress || this.progressScheduled) return
    this.progressScheduled = true
    queueMicrotask(() => {
      this.progressScheduled = false
      if (!this.destroyed) this.options.onProgress?.(this.stats())
    })
  }

  /** Overrides beat the machine; the cache beats the network. All synchronous. */
  private lookup(source: string): string | undefined {
    const override = this.options.overrides?.[this.target]?.[source]
    if (override !== undefined) return override

    const glossary = this.options.glossary?.[source]
    if (glossary !== undefined) return glossary

    return this.cache.get(cacheKey(source, this.target))
  }

  private write(unit: TranslationUnit, translated: string, live = false): void {
    switch (unit.kind) {
      case 'text':
        this.applier.applyText(unit, translated)
        break

      case 'attribute':
        this.applier.applyAttribute(unit, translated)
        break

      case 'block': {
        const texts = redistribute(unit, translated)
        if (texts === null) {
          // The reply mangled the placeholders. Rebuilding markup from it would
          // corrupt the DOM, so this block falls back to per-node translation.
          this.fallbackToNodes(unit, live)
          return
        }
        this.applier.applyBlock(unit, texts)
        break
      }
    }

    this.translated++
    this.notifyProgress()
  }

  /**
   * Translate a block's nodes one at a time.
   *
   * Quality drops, that is the cost of a provider that would not respect the
   * placeholders, but the markup survives, which matters more.
   */
  private fallbackToNodes(unit: BlockUnit, live: boolean): void {
    unit.nodes.forEach((node, index) => {
      const raw = node.nodeValue ?? ''
      const source = unit.sources[index] ?? ''
      if (source.length === 0) return

      const start = raw.indexOf(source)
      const textUnit: TextUnit = {
        kind: 'text',
        node,
        source,
        prefix: start > 0 ? raw.slice(0, start) : '',
        suffix: start >= 0 ? raw.slice(start + source.length) : '',
      }
      this.translateUnit(textUnit, true, live)
    })
  }

  private handleNewContent(nodes: Node[]): void {
    if (this.destroyed || this.target === this.source) return

    for (const node of nodes) {
      // A node appended inside <code> or a translate="no" subtree arrives with
      // no ancestor context, so the skip rules are re-checked upwards.
      if (isSkippedContext(node, this.filter)) continue
      this.translateTree(node, true, true)
    }
  }

  /**
   * A framework wrote the source text back over a translation.
   *
   * The answer is already known, so it is re-applied in this same task: no
   * network request, no flicker, no second charge. A node that came from a block
   * needs the whole sentence re-derived, because its own share is meaningless
   * on its own.
   */
  private handleTextReset(node: Text, source: string): void {
    const state = this.applier.textStateOf(node)

    if (state?.block) {
      this.translateTree(state.block, true, true)
      return
    }

    const known = this.lookup(source)
    if (known !== undefined) {
      this.charsSaved += source.length
      this.applier.reapplyText(node, known)
      return
    }

    this.translateTree(node, true, true)
  }

  private handleAttributeReset(element: Element, attribute: string, source: string): void {
    const known = this.lookup(source)
    if (known === undefined) {
      this.translateTree(element, true, true)
      return
    }

    this.charsSaved += source.length
    const unit: AttributeUnit = { kind: 'attribute', element, attribute, source }
    this.applier.applyAttribute(unit, known)
  }

  private seedDictionary(to: LanguageCode): void {
    const dictionary = this.options.dictionaries?.[to]
    if (!dictionary) return

    // Dictionary files are keyed by source string for readability and diffing;
    // the cache is keyed by hash, so translate the keys on the way in.
    const seeded: Record<string, string> = {}
    for (const [source, translation] of Object.entries(dictionary)) {
      seeded[cacheKey(source, to)] = translation
    }
    this.cache.seed(seeded)
  }

  private async resolveSource(): Promise<LanguageCode> {
    const configured = this.options.from
    if (configured && configured !== 'auto') return configured

    const declared = document.documentElement.getAttribute('lang')
    if (declared) return normalize(declared)

    const sample = (document.body?.textContent ?? '').trim().slice(0, 400)
    if (sample.length > 20) {
      const detected = await detectLanguageOnDevice(sample)
      if (detected) return normalize(detected)
    }

    return 'en'
  }

  private resolveTarget(source: LanguageCode): LanguageCode {
    if (this.options.to !== 'auto') return this.options.to

    if (this.options.persistChoice !== false) {
      const stored = readStoredChoice()
      if (stored) return stored
    }

    // First language the visitor actually asked for that is not what we already
    // serve. Falling back to the source means "no translation needed".
    for (const candidate of navigator.languages ?? []) {
      if (normalize(candidate) !== source) return normalize(candidate)
    }
    return source
  }

  private applyDocumentLanguage(): void {
    const root = document.documentElement
    root.lang = this.target

    if (this.options.rtl === false) return
    // Without this, Arabic and Hebrew render left-to-right: correct words,
    // unreadable layout.
    root.dir = isRtl(this.target) ? 'rtl' : 'ltr'
  }

  private persistChoice(to: LanguageCode): void {
    if (this.options.persistChoice === false) return
    try {
      localStorage.setItem(CHOICE_KEY, to)
    } catch {
      /* storage disabled; the choice simply will not survive a reload */
    }
  }
}

function readStoredChoice(): LanguageCode | null {
  try {
    return localStorage.getItem(CHOICE_KEY)
  } catch {
    return null
  }
}

/** `en-US` and `EN` both mean `en` for provider purposes. */
function normalize(tag: string): LanguageCode {
  return tag.toLowerCase().split('-')[0] ?? tag.toLowerCase()
}

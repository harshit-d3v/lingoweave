import type { Applier } from './applier.js'
import { DEFAULT_ATTRIBUTES, splitWhitespace } from './surface.js'

/** Attributes worth watching, the translatable set plus the two conditionals. */
export const OBSERVED_ATTRIBUTES: readonly string[] = [
  ...DEFAULT_ATTRIBUTES,
  'value',
  'content',
]

export interface ObserverCallbacks {
  /** Content that has never been seen and needs translating. */
  onNewContent: (nodes: Node[]) => void

  /**
   * A framework wrote the source text back over our translation. The engine
   * should re-apply from cache, synchronously, so nothing flickers.
   */
  onTextReset: (node: Text, source: string) => void

  onAttributeReset: (element: Element, attribute: string, source: string) => void
}

export interface ObserverOptions {
  attributes?: readonly string[]
}

/**
 * Watches every observed root and keeps translations applied over time.
 *
 * Two jobs, and the second is the one nobody else does.
 *
 * **Catching new content.** Dropdown items, submenu panels, modal bodies, toast
 * messages, infinite-scroll rows and route changes all arrive after the first
 * pass. Without this they stay in the source language, which is the single most
 * common complaint about every existing translator.
 *
 * **Surviving re-renders.** A framework that re-renders a translated node writes
 * the original string straight back over it. Naive translators either give up
 * (text reverts and stays reverted) or re-translate over the network (flicker,
 * and a bill). Because {@link Applier} recorded both the source and exactly what
 * it wrote, three cases can be told apart:
 *
 * - the value is ours → our own echo, ignore it, which is what stops the
 *   translate-observe-translate loop other libraries fall into
 * - the value is the recorded source → a re-render, re-apply from cache
 * - anything else → genuinely new text, translate it
 */
export class DomObserver {
  private observer: MutationObserver | null = null
  private readonly roots = new Set<Node>()
  private readonly watchedAttributes: string[]
  private paused = false

  constructor(
    private readonly applier: Applier,
    private readonly callbacks: ObserverCallbacks,
    options: ObserverOptions = {},
  ) {
    this.watchedAttributes = [
      ...new Set([...OBSERVED_ATTRIBUTES, ...(options.attributes ?? [])]),
    ]
  }

  get rootCount(): number {
    return this.roots.size
  }

  /** Start watching a root. Each shadow root and iframe document needs its own. */
  observe(root: Node): void {
    if (this.roots.has(root)) return
    this.roots.add(root)
    if (!this.paused) this.ensureObserver().observe(root, this.config())
  }

  unobserve(root: Node): void {
    if (!this.roots.delete(root)) return
    // MutationObserver cannot detach one target, so rebuild from what is left.
    this.rebind()
  }

  /** Stop reacting. Pending records are dropped rather than queued up. */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.observer?.takeRecords()
    this.observer?.disconnect()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.rebind()
  }

  disconnect(): void {
    this.observer?.takeRecords()
    this.observer?.disconnect()
    this.observer = null
    this.roots.clear()
  }

  /** Process anything already pending, without waiting for the microtask. */
  flush(): void {
    const records = this.observer?.takeRecords()
    if (records && records.length > 0) this.handle(records)
  }

  private ensureObserver(): MutationObserver {
    this.observer ??= new MutationObserver((records) => this.handle(records))
    return this.observer
  }

  private rebind(): void {
    this.observer?.takeRecords()
    this.observer?.disconnect()
    if (this.paused) return
    const observer = this.ensureObserver()
    for (const root of this.roots) observer.observe(root, this.config())
  }

  private config(): MutationObserverInit {
    return {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      // Filtering here rather than in the callback keeps the browser from
      // manufacturing a record for every class and style change on the page.
      attributeFilter: this.watchedAttributes,
    }
  }

  private handle(records: MutationRecord[]): void {
    if (this.paused) return

    const added: Node[] = []

    for (const record of records) {
      switch (record.type) {
        case 'childList':
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 || node.nodeType === 3) added.push(node)
          }
          break

        case 'characterData':
          this.handleTextChange(record.target as Text, added)
          break

        case 'attributes':
          this.handleAttributeChange(record, added)
          break
      }
    }

    if (added.length > 0) this.callbacks.onNewContent(dropNested(added))
  }

  private handleTextChange(node: Text, added: Node[]): void {
    const current = node.nodeValue

    // Our own write coming back. Ignoring it is what breaks the feedback loop.
    if (this.applier.wroteText(node, current)) return

    const state = this.applier.textStateOf(node)
    if (state) {
      const { core } = splitWhitespace(current ?? '')
      if (core === state.source) {
        this.callbacks.onTextReset(node, state.source)
        return
      }
      // Genuinely different text now lives here; the old record is stale.
      this.applier.forget(node)
    }

    added.push(node)
  }

  private handleAttributeChange(record: MutationRecord, added: Node[]): void {
    const element = record.target as Element
    const attribute = record.attributeName
    if (attribute === null) return

    const current = element.getAttribute(attribute)
    if (this.applier.wroteAttribute(element, attribute, current)) return

    const state = this.applier.attributeStateOf(element, attribute)
    if (state && current?.trim() === state.source) {
      this.callbacks.onAttributeReset(element, attribute, state.source)
      return
    }

    added.push(element)
  }
}

/**
 * Drop nodes already covered by another node in the batch.
 *
 * A route change can report a container plus a hundred of its descendants;
 * scanning the container alone covers all of them. Skipped above a threshold
 * where the quadratic check would cost more than the duplicate scans.
 */
function dropNested(nodes: Node[]): Node[] {
  const unique = [...new Set(nodes)]
  if (unique.length > 40) return unique

  return unique.filter(
    (node) =>
      !unique.some(
        (other) =>
          other !== node &&
          other.nodeType === 1 &&
          (other as Element).contains(node),
      ),
  )
}

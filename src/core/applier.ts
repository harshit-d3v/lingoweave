import type { AttributeUnit, BlockUnit, TextUnit } from '../types.js'
import { splitWhitespace } from './surface.js'

export interface TextState {
  /** Trimmed original, as sent to the provider. */
  source: string
  prefix: string
  suffix: string
  /** The exact `nodeValue` we last wrote. Used as the recursion guard. */
  written: string
  /**
   * Set when this node's text came from a block segment. A re-render here has
   * to be recovered by re-translating the whole block, because this node holds
   * only a share of one sentence and its share alone is meaningless.
   */
  block?: Element
}

export interface AttributeState {
  source: string
  written: string
}

/**
 * Writes translations back into the DOM without disturbing its shape.
 *
 * This is the part that stops the crash every other DOM translator causes.
 * Google Translate replaces a text node with a `<font>` wrapper containing a new
 * text node. React kept a reference to the original node, so the next time it
 * tries `parent.removeChild(textNode)` or `parent.insertBefore(x, textNode)` the
 * node is no longer a child of that parent and the render throws
 * `Failed to execute 'removeChild' on 'Node'`. That is facebook/react#11538,
 * open since 2017 and still unfixed.
 *
 * So: never replace, never wrap, never insert. Only ever assign to `nodeValue`
 * and `setAttribute`. Node identity survives, every framework's stored
 * references stay valid, and reconciliation carries on none the wiser.
 *
 * Every write is recorded so the observer can tell three cases apart: our own
 * write echoing back (ignore it), a framework re-rendering the same source text
 * (re-apply from cache, no network, no flicker), and genuinely new content
 * (translate it).
 */
export class Applier {
  private readonly textStates = new WeakMap<Text, TextState>()
  private readonly attributeStates = new WeakMap<Element, Map<string, AttributeState>>()

  /**
   * Weak handles on everything touched, so `restore()` can undo the work
   * without pinning removed nodes in memory. An SPA that renders and discards
   * thousands of nodes would otherwise leak every one of them.
   */
  private readonly tracked = new Set<WeakRef<Node>>()
  /** One ref per node, so repeated writes don't pile up duplicates. */
  private readonly refs = new WeakMap<Node, WeakRef<Node>>()
  private readonly collected =
    typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry<WeakRef<Node>>((ref) => this.tracked.delete(ref))
      : null

  applied = 0

  /**
   * Write a translation into a text node.
   *
   * The original surrounding whitespace is restored around the translated core,
   * because a provider given `'\n   Read more\n  '` returns `'Leer más'` with the
   * indentation gone, which deletes the space between adjacent inline elements
   * and jams words together.
   */
  applyText(unit: TextUnit, translated: string): void {
    const written = unit.prefix + translated + unit.suffix
    const state: TextState = {
      source: unit.source,
      prefix: unit.prefix,
      suffix: unit.suffix,
      written,
    }

    this.textStates.set(unit.node, state)
    this.track(unit.node)

    if (unit.node.nodeValue !== written) {
      unit.node.nodeValue = written
      this.applied++
    }
  }

  /**
   * Re-apply a known translation to a node a framework just reset.
   *
   * Kept separate from {@link applyText} because there is no unit to rebuild , 
   * the recorded state already holds the whitespace shell.
   */
  reapplyText(node: Text, translated: string): void {
    const previous = this.textStates.get(node)
    if (!previous) return

    // A node from a block holds a share of a sentence that already carries its
    // own spacing; re-adding the original shell would insert stray spaces.
    const written = previous.block
      ? translated
      : previous.prefix + translated + previous.suffix
    this.textStates.set(node, { ...previous, written })

    if (node.nodeValue !== written) {
      node.nodeValue = written
      this.applied++
    }
  }

  /**
   * Write a translated block back across the nodes it came from.
   *
   * `texts` comes from {@link redistribute}, which has already decided which
   * share of the sentence belongs to which node. Some nodes legitimately receive
   * an empty string: when a translation merges a run, the words move into a
   * neighbouring node rather than disappearing.
   *
   * Whitespace is not restored here the way it is for standalone text nodes , 
   * the translated sentence carries its own spacing, and the block's own leading
   * and trailing whitespace renders as nothing at a block boundary anyway.
   */
  applyBlock(unit: BlockUnit, texts: ReadonlyMap<Text, string>): void {
    unit.nodes.forEach((node, index) => {
      const translated = texts.get(node)
      if (translated === undefined) return

      // The written value is the translated share alone, the sentence carries
      // its own spacing. But prefix and suffix still record the original
      // whitespace, because restore() has to put the page back exactly, spaces
      // around inline elements included.
      const { prefix, core, suffix } = splitWhitespace(unit.raws[index] ?? '')

      this.textStates.set(node, {
        source: core || (unit.sources[index] ?? ''),
        prefix,
        suffix,
        written: translated,
        block: unit.element,
      })
      this.track(node)

      if (node.nodeValue !== translated) {
        node.nodeValue = translated
        this.applied++
      }
    })
  }

  applyAttribute(unit: AttributeUnit, translated: string): void {
    this.recordAttribute(unit.element, unit.attribute, {
      source: unit.source,
      written: translated,
    })
    this.track(unit.element)

    if (unit.element.getAttribute(unit.attribute) !== translated) {
      unit.element.setAttribute(unit.attribute, translated)
      this.applied++
    }
  }

  /** Whether this exact value is one we wrote, the recursion guard. */
  wroteText(node: Text, value: string | null): boolean {
    const state = this.textStates.get(node)
    return state !== undefined && state.written === value
  }

  wroteAttribute(element: Element, attribute: string, value: string | null): boolean {
    const state = this.attributeStates.get(element)?.get(attribute)
    return state !== undefined && state.written === value
  }

  textStateOf(node: Text): TextState | undefined {
    return this.textStates.get(node)
  }

  attributeStateOf(element: Element, attribute: string): AttributeState | undefined {
    return this.attributeStates.get(element)?.get(attribute)
  }

  /** Forget a node so the next scan treats it as fresh content. */
  forget(node: Node): void {
    if (node.nodeType === 3) this.textStates.delete(node as Text)
    else if (node.nodeType === 1) this.attributeStates.delete(node as Element)
  }

  /** Put every original string back, then drop all state. */
  restore(): void {
    for (const ref of this.tracked) {
      const node = ref.deref()
      if (!node) {
        this.tracked.delete(ref)
        continue
      }

      if (node.nodeType === 3) {
        const text = node as Text
        const state = this.textStates.get(text)
        if (state) text.nodeValue = state.prefix + state.source + state.suffix
        this.textStates.delete(text)
      } else if (node.nodeType === 1) {
        const element = node as Element
        const states = this.attributeStates.get(element)
        if (states) {
          for (const [attribute, state] of states) {
            element.setAttribute(attribute, state.source)
          }
        }
        this.attributeStates.delete(element)
      }

      // Allow a later re-weave to track this node again.
      this.refs.delete(node)
      this.collected?.unregister(ref)
    }

    this.tracked.clear()
    this.applied = 0
  }

  private recordAttribute(element: Element, attribute: string, state: AttributeState): void {
    let states = this.attributeStates.get(element)
    if (!states) {
      states = new Map()
      this.attributeStates.set(element, states)
    }
    states.set(attribute, state)
  }

  private track(node: Node): void {
    if (this.refs.has(node)) return
    const ref = new WeakRef(node)
    this.refs.set(node, ref)
    this.tracked.add(ref)
    this.collected?.register(node, ref, ref)
  }
}

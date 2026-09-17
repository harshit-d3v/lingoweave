import type { AttributeUnit, TextUnit, TranslationUnit } from '../types.js'
import type { TranslationFilter } from './filter.js'
import { serializeBlock } from './segmenter.js'
import { splitWhitespace, translatableAttributes } from './surface.js'

export interface ScanOptions {
  /** Extra attribute names, appended to the built-in list. */
  attributes?: readonly string[]
  /** Collect open shadow roots encountered on the way. Default `true`. */
  shadowDom?: boolean
  /**
   * Merge a block's inline children into one sentence before translating.
   * Default `true`; turning it off translates every text node separately, which
   * is cheaper to reason about but noticeably worse in inflected languages.
   */
  segment?: boolean
}

export interface ScanResult {
  units: TranslationUnit[]
  /**
   * Open shadow roots found while walking. The caller scans and observes each
   * one separately, a shadow root is its own tree with its own mutations.
   */
  shadowRoots: ShadowRoot[]
}

/**
 * Collect every translatable thing under `root`, in document order.
 *
 * Hand-rolled iterative walk rather than `TreeWalker`, for two reasons that
 * both matter here. `TreeWalker` cannot cross a shadow boundary at all, and its
 * filter has no way to say "read this element's attributes but do not descend
 * into it", which is exactly what `<textarea placeholder="…">` needs.
 *
 * Document order is preserved so the queue's viewport priority lines up with
 * what the visitor actually sees first.
 */
export function scan(
  root: Node,
  filter: TranslationFilter,
  options: ScanOptions = {},
): ScanResult {
  const units: TranslationUnit[] = []
  const shadowRoots: ShadowRoot[] = []
  const extraAttributes = options.attributes ?? []
  const collectShadow = options.shadowDom !== false
  const useSegments = options.segment !== false

  /** Text nodes already covered by a block segment, so not emitted alone. */
  let segmentedNodes: Set<Text> | null = null

  // The observer hands us bare text nodes when a framework appends one.
  if (isText(root)) {
    const unit = toTextUnit(root, filter)
    return { units: unit ? [unit] : [], shadowRoots }
  }

  const stack: Node[] = []
  pushChildren(stack, resolveStart(root))

  // The root element's own attributes are never reached by a child walk.
  if (isElement(root) && !filter.skipsSubtree(root)) {
    collectAttributes(root, filter, extraAttributes, units)
    if (collectShadow) collectShadowRoot(root, shadowRoots)
  }

  while (stack.length > 0) {
    const node = stack.pop() as Node

    if (isText(node)) {
      // Already folded into a block segment by an ancestor, which was visited
      // first because the walk is depth-first from the top.
      if (segmentedNodes?.has(node)) continue
      const unit = toTextUnit(node, filter)
      if (unit) units.push(unit)
      continue
    }

    if (!isElement(node)) continue
    if (filter.skipsSubtree(node)) continue

    collectAttributes(node, filter, extraAttributes, units)
    if (collectShadow) collectShadowRoot(node, shadowRoots)

    if (filter.skipsChildren(node)) continue

    // A block whose children are all inline is translated as one sentence.
    // Its descendants still need visiting for attributes and shadow roots, so
    // the walk continues either way, only the text handling differs.
    if (useSegments) {
      const block = serializeBlock(node, filter)
      if (block) {
        units.push(block)
        segmentedNodes ??= new Set()
        for (const text of block.nodes) segmentedNodes.add(text)
      }
    }

    pushChildren(stack, node)
  }

  return { units, shadowRoots }
}

/**
 * Whether any ancestor has opted this node out.
 *
 * Needed on the observer path: a node appended inside `<code>` or inside a
 * `translate="no"` subtree arrives as its own mutation record, with no ancestor
 * context, so the skip rules have to be re-checked upwards. Stops at a shadow
 * boundary, since each root is scanned on its own terms.
 */
export function isSkippedContext(node: Node, filter: TranslationFilter): boolean {
  let current = node.parentNode
  while (current) {
    if (isElement(current)) {
      if (filter.skipsSubtree(current) || filter.skipsChildren(current)) return true
    } else if (current.nodeType === 11 || current.nodeType === 9) {
      // ShadowRoot or Document, nothing above this is ours to inspect.
      return false
    }
    current = current.parentNode
  }
  return false
}

function resolveStart(root: Node): Node {
  // Starting at `documentElement` rather than the document keeps `<head>` in
  // scope, which is where `<title>` and the Open Graph descriptions live.
  if (isDocument(root)) return root.documentElement ?? root
  return root
}

/** Reverse-push so the stack yields children in document order. */
function pushChildren(stack: Node[], parent: Node): void {
  const children = parent.childNodes
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]
    if (child) stack.push(child)
  }
}

function toTextUnit(node: Text, filter: TranslationFilter): TextUnit | null {
  if (!filter.acceptsText(node)) return null
  const { prefix, core, suffix } = splitWhitespace(node.nodeValue ?? '')
  return { kind: 'text', node, source: core, prefix, suffix }
}

function collectAttributes(
  element: Element,
  filter: TranslationFilter,
  extra: readonly string[],
  into: TranslationUnit[],
): void {
  for (const attribute of translatableAttributes(element, extra)) {
    const value = element.getAttribute(attribute)
    if (value === null || !filter.acceptsAttribute(value)) continue
    const unit: AttributeUnit = {
      kind: 'attribute',
      element,
      attribute,
      source: value.trim(),
    }
    into.push(unit)
  }
}

function collectShadowRoot(element: Element, into: ShadowRoot[]): void {
  const shadow = element.shadowRoot
  if (shadow) into.push(shadow)
}

function isElement(node: unknown): node is Element {
  return isNode(node) && node.nodeType === 1
}

function isText(node: unknown): node is Text {
  return isNode(node) && node.nodeType === 3
}

function isDocument(node: unknown): node is Document {
  return isNode(node) && node.nodeType === 9
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'nodeType' in value
}

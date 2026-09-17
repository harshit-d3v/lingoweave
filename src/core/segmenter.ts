import type { BlockUnit } from '../types.js'
import type { TranslationFilter } from './filter.js'
import {
  collapseWhitespace,
  isInlineTag,
  isVoidInlineTag,
} from './surface.js'

/** Longest source string handed to a provider before it gets split. */
export const MAX_SEGMENT_CHARS = 5000

interface Chunk {
  node: Text
  /** Dot-joined placeholder indices enclosing this chunk: `''`, `'0'`, `'0.1'`. */
  path: string
  /** Placeholders at this level that come before this chunk. */
  slot: number
}

/**
 * Merges a block's inline children into one translatable sentence.
 *
 * Translating text nodes one at a time is the quiet quality killer in every
 * DOM translator. `<p>Only <b>logged-in</b> users can post</p>` is three nodes,
 * so a naive implementation sends three requests, `"Only"`, `"logged-in"`,
 * `"users can post"`, and gets back three fragments translated with no
 * knowledge of each other. Gender, case, and word order are all decided per
 * fragment, and in inflected languages the result is wrong rather than merely
 * clumsy.
 *
 * So the block is serialized into a single string with numbered placeholders
 * standing in for the inline markup:
 *
 * ```text
 * Only <0>logged-in</0> users can post
 * ```
 *
 * The provider sees a whole sentence, and the reply is taken apart and written
 * back to the original nodes, which keeps {@link Applier}'s guarantee that no
 * node is ever replaced.
 *
 * Machine translators do sometimes mangle placeholders. Every failure mode is
 * treated as "fall back to per-node translation" rather than something to
 * patch up, because a slightly clumsy translation beats corrupted markup.
 */

/**
 * Try to serialize `element` as one segment.
 *
 * Returns `null` when the element is not a simple block, a non-inline child
 * means the caller should descend and consider those children separately, or
 * when there is nothing to gain, which is the common single-text-node case.
 */
export function serializeBlock(
  element: Element,
  filter: TranslationFilter,
): BlockUnit | null {
  const chunks: Chunk[] = []
  let source = ''
  let nextIndex = 0
  let bailed = false

  const path: number[] = []

  const visit = (parent: Node): void => {
    if (bailed) return

    // Per-level, so a chunk's slot counts only the placeholders beside it.
    let placeholdersBefore = 0

    for (const node of parent.childNodes) {
      if (bailed) return

      if (node.nodeType === 3) {
        const text = node as Text
        const raw = text.nodeValue ?? ''
        // Whitespace-only nodes are not translated, but their space still has
        // to appear in the sentence or words either side would run together.
        source += collapseWhitespace(raw)
        if (filter.acceptsText(text)) {
          chunks.push({ node: text, path: path.join('.'), slot: placeholdersBefore })
        }
        continue
      }

      if (node.nodeType !== 1) continue
      const child = node as Element

      // An opted-out or non-descendable element cannot be folded into a
      // sentence, so the whole block falls back to per-node handling.
      if (filter.skipsSubtree(child) || filter.skipsChildren(child)) {
        bailed = true
        return
      }

      if (!isInlineTag(child)) {
        bailed = true
        return
      }

      const index = nextIndex++
      if (isVoidInlineTag(child) || child.childNodes.length === 0) {
        source += `<${index}/>`
        placeholdersBefore++
        continue
      }

      source += `<${index}>`
      path.push(index)
      visit(child)
      path.pop()
      source += `</${index}>`
      placeholdersBefore++
    }
  }

  visit(element)

  if (bailed) return null

  // One chunk means there is no sentence to hold together; placeholders would
  // only add cost and risk. The caller emits a plain text unit instead.
  if (chunks.length < 2) return null

  const trimmed = source.trim()
  if (trimmed.length === 0) return null

  return {
    kind: 'block',
    element,
    nodes: chunks.map((chunk) => chunk.node),
    paths: chunks.map((chunk) => chunk.path),
    slots: chunks.map((chunk) => chunk.slot),
    sources: chunks.map((chunk) => (chunk.node.nodeValue ?? '').trim()),
    raws: chunks.map((chunk) => chunk.node.nodeValue ?? ''),
    source: trimmed,
  }
}

interface ParsedChunk {
  path: string
  slot: number
  text: string
}

/**
 * Take a translated segment apart.
 *
 * Returns `null` on any structural problem: an unknown placeholder index, a
 * mismatched or unbalanced tag, or a placeholder that went missing. All of them
 * mean the reply cannot be trusted to rebuild the markup.
 */
export function parseSegment(
  translated: string,
  expectedIndices: ReadonlySet<number>,
): ParsedChunk[] | null {
  const pattern = /<(\/)?(\d+)(\/)?>/g
  const chunks: ParsedChunk[] = []
  const stack: number[] = []
  const opened = new Set<number>()
  /** Placeholders seen so far at each depth, indexed by depth. */
  const slots: number[] = [0]

  let cursor = 0
  let match: RegExpExecArray | null

  const pushText = (text: string): void => {
    if (text.length === 0) return
    chunks.push({ path: stack.join('.'), slot: slots[stack.length] ?? 0, text })
  }

  while ((match = pattern.exec(translated)) !== null) {
    const [tag, closing, digits, selfClosing] = match
    const index = Number(digits)

    if (!expectedIndices.has(index)) return null

    pushText(translated.slice(cursor, match.index))
    cursor = match.index + tag.length

    if (selfClosing) {
      if (opened.has(index)) return null
      opened.add(index)
      slots[stack.length] = (slots[stack.length] ?? 0) + 1
      continue
    }

    if (closing) {
      if (stack.pop() !== index) return null
      continue
    }

    if (opened.has(index)) return null
    opened.add(index)
    // Count this placeholder at the current level, then descend into a fresh
    // count for the level inside it.
    slots[stack.length] = (slots[stack.length] ?? 0) + 1
    stack.push(index)
    slots[stack.length] = 0
  }

  pushText(translated.slice(cursor))

  if (stack.length > 0) return null
  if (opened.size !== expectedIndices.size) return null

  return chunks
}

/**
 * Work out what each original text node should now say.
 *
 * Returns `null` when the reply cannot be mapped back, which tells the engine
 * to translate this block's nodes individually instead.
 */
export function redistribute(
  unit: BlockUnit,
  translated: string,
): Map<Text, string> | null {
  const expected = collectIndices(unit.source)
  const parsed = parseSegment(translated, expected)
  if (parsed === null) return null

  // Position key: which inline container, and where within it. Matching on both
  // is what keeps word order right when a translation moves an inline element.
  const originalKeys = unit.nodes.map((_, i) => `${unit.paths[i]}#${unit.slots[i]}`)

  const byKey = new Map<string, string[]>()
  for (const chunk of parsed) {
    const key = `${chunk.path}#${chunk.slot}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(chunk.text)
    else byKey.set(key, [chunk.text])
  }

  // Text may only land in a position that existed in the original.
  for (const key of byKey.keys()) {
    if (!originalKeys.includes(key)) return null
  }

  const result = new Map<Text, string>()

  for (const key of new Set(originalKeys)) {
    const nodes = unit.nodes.filter((_, i) => originalKeys[i] === key)
    const texts = byKey.get(key) ?? []

    if (texts.length === nodes.length) {
      nodes.forEach((node, i) => result.set(node, texts[i] as string))
      continue
    }

    // Counts differ because the translation merged or split this run. Give it
    // all to the first node in the position and blank the rest: no text is
    // lost, and the surrounding markup stays exactly where it was.
    nodes.forEach((node, i) => result.set(node, i === 0 ? texts.join('') : ''))
  }

  return result
}

/** Placeholder indices present in a serialized source string. */
export function collectIndices(source: string): Set<number> {
  const indices = new Set<number>()
  for (const match of source.matchAll(/<(?:\/)?(\d+)(?:\/)?>/g)) {
    indices.add(Number(match[1]))
  }
  return indices
}

/**
 * Split an over-long segment at sentence boundaries.
 *
 * `Intl.Segmenter` knows where sentences end in scripts that do not use spaces
 * or full stops, which a regex does not. Falls back to whole-string when the
 * API is missing or no boundary is close enough to help.
 */
export function splitLongSource(
  source: string,
  locale: string,
  limit = MAX_SEGMENT_CHARS,
): string[] {
  if (source.length <= limit) return [source]
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return chunkByLength(source, limit)
  }

  let sentences: string[]
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' })
    sentences = [...segmenter.segment(source)].map((s) => s.segment)
  } catch {
    return chunkByLength(source, limit)
  }

  const parts: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length > limit) {
      parts.push(current)
      current = ''
    }
    current += sentence
  }
  if (current.length > 0) parts.push(current)

  // A single sentence longer than the limit still has to be broken somewhere.
  return parts.flatMap((part) => (part.length > limit ? chunkByLength(part, limit) : part))
}

function chunkByLength(source: string, limit: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < source.length; i += limit) parts.push(source.slice(i, i + limit))
  return parts
}

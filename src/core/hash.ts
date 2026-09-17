/**
 * Stable, fast, non-cryptographic string hash (cyrb53).
 *
 * Used for cache keys and dictionary keys, so the output must never change
 * between releases, a different hash silently invalidates every visitor's
 * stored cache and every committed dictionary file. Treat this function as
 * frozen.
 *
 * Two independent 32-bit lanes are combined into ~53 bits, which keeps
 * collisions negligible for the tens of thousands of strings a site has.
 */
export function hash(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Cache key for a source string in a target language.
 *
 * The provider is deliberately absent: swapping DeepL for the on-device model
 * should reuse everything already translated rather than re-paying for it.
 * Length is mixed in as cheap extra collision insurance.
 */
export function cacheKey(source: string, to: string): string {
  return `${to}:${hash(source)}${source.length.toString(36)}`
}

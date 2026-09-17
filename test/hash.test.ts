import { describe, expect, it } from 'vitest'
import { cacheKey, hash } from '../src/core/hash.js'

describe('hash', () => {
  it('is deterministic', () => {
    expect(hash('Sign in')).toBe(hash('Sign in'))
  })

  it('separates strings that differ only slightly', () => {
    const seen = new Set(
      ['Sign in', 'Sign In', 'Sign up', 'sign in', 'Sign in ', ''].map(hash),
    )
    expect(seen.size).toBe(6)
  })

  it('handles non-latin scripts and emoji', () => {
    for (const text of ['مرحبا بالعالم', '你好世界', 'नमस्ते दुनिया', '🌍 hello']) {
      expect(hash(text)).toMatch(/^[0-9a-z]+$/)
      expect(hash(text)).toBe(hash(text))
    }
  })

  it('spreads a large corpus without collisions', () => {
    const hashes = new Set<string>()
    for (let i = 0; i < 20_000; i++) hashes.add(hash(`String number ${i}`))
    expect(hashes.size).toBe(20_000)
  })

  // Frozen on purpose. Changing these values invalidates every visitor's
  // stored cache and every committed dictionary file, so this test must fail
  // loudly if the algorithm is ever touched.
  it('produces stable values across releases', () => {
    expect({
      empty: hash(''),
      hello: hash('Hello'),
      sentence: hash('Hello <0>world</0>, welcome'),
      arabic: hash('مرحبا'),
    }).toMatchInlineSnapshot(`
      {
        "arabic": "1dma6pgmwbp",
        "empty": "wvjl67o803",
        "hello": "1bxbhegfcxe",
        "sentence": "25da6rqzj1l",
      }
    `)
  })
})

describe('cacheKey', () => {
  it('namespaces by target language', () => {
    expect(cacheKey('Hello', 'es')).not.toBe(cacheKey('Hello', 'fr'))
    expect(cacheKey('Hello', 'es')).toContain('es:')
  })

  it('ignores the provider so switching providers reuses the cache', () => {
    // There is no provider parameter by design; this documents the intent.
    expect(cacheKey('Hello', 'es')).toBe(cacheKey('Hello', 'es'))
  })

  it('mixes in length as extra collision insurance', () => {
    expect(cacheKey('Hello', 'es')).not.toBe(cacheKey('Hello!', 'es'))
  })
})

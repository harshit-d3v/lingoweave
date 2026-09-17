import { beforeEach, describe, expect, it } from 'vitest'
import { TranslationCache } from '../src/core/cache.js'

describe('TranslationCache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores and reads back synchronously', () => {
    const cache = new TranslationCache('memory')
    cache.set('es:abc', 'Hola')
    // Synchronous reads are the whole point, they let the engine apply a
    // known translation in the same frame the node is discovered.
    expect(cache.get('es:abc')).toBe('Hola')
    expect(cache.has('es:abc')).toBe(true)
    expect(cache.size).toBe(1)
  })

  it('returns undefined for a miss', () => {
    const cache = new TranslationCache('memory')
    expect(cache.get('es:nope')).toBeUndefined()
  })

  it('counts hits and misses', () => {
    const cache = new TranslationCache('memory')
    cache.set('es:a', 'Hola')
    cache.get('es:a')
    cache.get('es:a')
    cache.get('es:b')
    expect(cache.hits).toBe(2)
    expect(cache.misses).toBe(1)
  })

  it('serves seeded dictionary entries', () => {
    const cache = new TranslationCache('memory')
    cache.seed({ 'es:greeting': 'Hola', 'es:farewell': 'Adiós' })
    expect(cache.get('es:greeting')).toBe('Hola')
    expect(cache.size).toBe(2)
  })

  it('excludes seeded entries from export so dictionaries do not duplicate', () => {
    const cache = new TranslationCache('memory')
    cache.seed({ 'es:seeded': 'Hola' })
    cache.set('es:learned', 'Adiós')

    expect(cache.export()).toEqual({ 'es:learned': 'Adiós' })
  })

  it('lets a runtime write shadow a seeded entry in memory', () => {
    const cache = new TranslationCache('memory')
    cache.seed({ 'es:a': 'Hola' })
    cache.set('es:a', 'Buenas')
    expect(cache.get('es:a')).toBe('Buenas')
  })

  it('clears everything including counters', async () => {
    const cache = new TranslationCache('memory')
    cache.set('es:a', 'Hola')
    cache.seed({ 'es:b': 'Adiós' })
    cache.get('es:a')

    await cache.clear()

    expect(cache.size).toBe(0)
    expect(cache.hits).toBe(0)
    expect(cache.misses).toBe(0)
    expect(cache.export()).toEqual({})
  })

  it('never persists in memory mode', async () => {
    const cache = new TranslationCache('memory')
    cache.set('es:a', 'Hola')
    await cache.flush()
    expect(localStorage.getItem('lingoweave:cache')).toBeNull()
  })

  it('never persists when caching is disabled', async () => {
    const cache = new TranslationCache(false)
    cache.set('es:a', 'Hola')
    await cache.flush()
    expect(cache.get('es:a')).toBe('Hola')
    expect(localStorage.getItem('lingoweave:cache')).toBeNull()
  })

  describe('without IndexedDB', () => {
    // happy-dom has no IndexedDB, which exercises the localStorage fallback
    // that real private-browsing sessions hit.
    it('opens without throwing and falls back to localStorage', async () => {
      const cache = new TranslationCache('indexeddb')
      await expect(cache.open()).resolves.toBeUndefined()

      cache.set('es:a', 'Hola')
      await cache.flush()

      const raw = localStorage.getItem('lingoweave:cache')
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw as string)).toEqual({ 'es:a': 'Hola' })
    })

    it('reloads persisted entries on the next visit', async () => {
      const first = new TranslationCache('indexeddb')
      await first.open()
      first.set('es:a', 'Hola')
      await first.flush()

      const second = new TranslationCache('indexeddb')
      await second.open()
      expect(second.get('es:a')).toBe('Hola')
    })

    it('lets dictionary seeds win over stale storage', async () => {
      const first = new TranslationCache('indexeddb')
      await first.open()
      first.set('es:a', 'stale')
      await first.flush()

      const second = new TranslationCache('indexeddb')
      second.seed({ 'es:a': 'fresh' })
      await second.open()

      expect(second.get('es:a')).toBe('fresh')
    })
  })

  it('survives a corrupt localStorage payload', async () => {
    localStorage.setItem('lingoweave:cache', '{not json')
    const cache = new TranslationCache('indexeddb')
    await expect(cache.open()).resolves.toBeUndefined()
    expect(cache.size).toBe(0)
  })
})

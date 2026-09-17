import { describe, expect, it, vi } from 'vitest'
import { TranslationQueue } from '../src/core/queue.js'

/** Echoes an uppercase translation and records every batch it was given. */
function recorder(transform: (text: string) => string = (t) => t.toUpperCase()) {
  const batches: string[][] = []
  const translate = vi.fn(async (texts: string[]) => {
    batches.push([...texts])
    return texts.map(transform)
  })
  return { batches, translate }
}

describe('TranslationQueue', () => {
  it('translates a single string', async () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate })

    const result = queue.request('Hello')
    await queue.flush()

    await expect(result).resolves.toBe('HELLO')
  })

  it('collects concurrent requests into one batch', async () => {
    const { batches, translate } = recorder()
    const queue = new TranslationQueue({ translate })

    const all = Promise.all([
      queue.request('one'),
      queue.request('two'),
      queue.request('three'),
    ])
    await queue.flush()

    await expect(all).resolves.toEqual(['ONE', 'TWO', 'THREE'])
    expect(translate).toHaveBeenCalledTimes(1)
    expect(batches[0]).toEqual(['one', 'two', 'three'])
  })

  it('de-duplicates identical strings so repeats are billed once', async () => {
    const { batches, translate } = recorder()
    const queue = new TranslationQueue({ translate })

    // "Home" in a desktop nav, a mobile nav and a footer is one string.
    const all = Promise.all([
      queue.request('Home'),
      queue.request('Home'),
      queue.request('Home'),
      queue.request('About'),
    ])
    await queue.flush()

    await expect(all).resolves.toEqual(['HOME', 'HOME', 'HOME', 'ABOUT'])
    expect(batches[0]).toEqual(['Home', 'About'])
    expect(queue.chars).toBe('Home'.length + 'About'.length)
  })

  it('returns the same promise for a string already in flight', () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate })
    expect(queue.request('Hello')).toBe(queue.request('Hello'))
  })

  it('re-requests a string once its previous request settled', async () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate })

    const first = queue.request('Hello')
    await queue.flush()
    await first

    const second = queue.request('Hello')
    await queue.flush()

    await expect(second).resolves.toBe('HELLO')
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('splits on maxBatchSize', async () => {
    const { batches, translate } = recorder()
    const queue = new TranslationQueue({ translate, maxBatchSize: 2, concurrency: 1 })

    const all = Promise.all(['a', 'b', 'c', 'd', 'e'].map((t) => queue.request(t)))
    await queue.flush()

    await expect(all).resolves.toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1])
  })

  it('splits on maxBatchChars', async () => {
    const { batches, translate } = recorder()
    const queue = new TranslationQueue({ translate, maxBatchChars: 10, concurrency: 1 })

    const all = Promise.all([
      queue.request('12345'),
      queue.request('12345'.repeat(1)),
      queue.request('abcdefgh'),
    ])
    await queue.flush()

    await expect(all).resolves.toHaveLength(3)
    expect(batches.every((b) => b.join('').length <= 10 || b.length === 1)).toBe(true)
  })

  it('never drops a string longer than maxBatchChars', async () => {
    const { batches, translate } = recorder()
    const queue = new TranslationQueue({ translate, maxBatchChars: 5 })

    const long = 'x'.repeat(500)
    const result = queue.request(long)
    await queue.flush()

    await expect(result).resolves.toBe(long.toUpperCase())
    expect(batches[0]).toEqual([long])
  })

  it('sends viewport-priority text ahead of the rest', async () => {
    const { batches, translate } = recorder()
    const queue = new TranslationQueue({ translate, concurrency: 1, maxBatchSize: 1 })

    const belowFold = queue.request('below the fold')
    const onScreen = queue.request('on screen', true)
    await queue.flush()

    await expect(Promise.all([belowFold, onScreen])).resolves.toHaveLength(2)
    expect(batches[0]).toEqual(['on screen'])
  })

  it('respects the concurrency limit', async () => {
    let active = 0
    let peak = 0
    const translate = vi.fn(async (texts: string[]) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return texts
    })
    const queue = new TranslationQueue({ translate, concurrency: 2, maxBatchSize: 1 })

    const all = Promise.all(
      Array.from({ length: 6 }, (_, i) => queue.request(`text ${i}`)),
    )
    await queue.flush()
    await all

    expect(peak).toBeLessThanOrEqual(2)
    expect(translate).toHaveBeenCalledTimes(6)
  })

  it('retries a failing batch and then succeeds', async () => {
    let attempts = 0
    const translate = vi.fn(async (texts: string[]) => {
      attempts++
      if (attempts === 1) throw new Error('429 Too Many Requests')
      return texts.map((t) => t.toUpperCase())
    })
    const queue = new TranslationQueue({ translate, retries: 2 })

    const result = queue.request('Hello')
    await queue.flush()

    await expect(result).resolves.toBe('HELLO')
    expect(attempts).toBe(2)
  })

  it('rejects and reports after exhausting retries', async () => {
    const translate = vi.fn(async () => {
      throw new Error('provider down')
    })
    const onError = vi.fn()
    const queue = new TranslationQueue({ translate, retries: 1, onError })

    const result = queue.request('Hello')
    await queue.flush()

    await expect(result).rejects.toThrow('provider down')
    expect(translate).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[1]).toEqual(['Hello'])
    expect(queue.errors).toBe(1)
  })

  it('rejects when a provider returns the wrong number of results', async () => {
    const translate = vi.fn(async () => ['only one'])
    const queue = new TranslationQueue({ translate, retries: 0 })

    const a = queue.request('one')
    const b = queue.request('two')
    await queue.flush()

    await expect(a).rejects.toThrow(/2 inputs/)
    await expect(b).rejects.toThrow(/2 inputs/)
  })

  it('tracks characters and requests for the cost meter', async () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate, maxBatchSize: 1, concurrency: 1 })

    const all = Promise.all([queue.request('abc'), queue.request('de')])
    await queue.flush()
    await all

    expect(queue.chars).toBe(5)
    expect(queue.requests).toBe(2)
  })

  it('reports idle state', async () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate })

    expect(queue.idle).toBe(true)
    const result = queue.request('Hello')
    expect(queue.idle).toBe(false)
    expect(queue.pending).toBe(1)

    await queue.flush()
    await result
    expect(queue.idle).toBe(true)
  })

  it('resolves flush immediately when nothing is queued', async () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate })
    await expect(queue.flush()).resolves.toBeUndefined()
    expect(translate).not.toHaveBeenCalled()
  })

  it('dispatches on its own without flush being called', async () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate, debounce: 1 })

    const result = queue.request('Hello')
    await expect(result).resolves.toBe('HELLO')
  })

  it('rejects queued work on destroy', async () => {
    const { translate } = recorder()
    const queue = new TranslationQueue({ translate })

    const result = queue.request('Hello')
    queue.destroy()

    await expect(result).rejects.toThrow('destroyed')
    expect(translate).not.toHaveBeenCalled()
  })
})

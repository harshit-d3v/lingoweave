export interface QueueOptions {
  /** Sends one batch. Must return one result per input, in order. */
  translate: (texts: string[]) => Promise<string[]>
  maxBatchChars?: number
  maxBatchSize?: number
  /** Batches in flight at once. */
  concurrency?: number
  /** Retry attempts after the first failure. */
  retries?: number
  /** How long to collect strings before dispatching a normal-priority batch. */
  debounce?: number
  onError?: (error: Error, texts: string[]) => void
}

interface Job {
  text: string
  resolve: (translated: string) => void
  reject: (error: Error) => void
}

const noop = (): void => {}

/**
 * Batches, de-duplicates and rate-limits work heading for a provider.
 *
 * Three things earn their keep here:
 *
 * - **De-duplication.** A nav label repeated in a desktop menu, a mobile menu
 *   and a footer is one billed string, not three. Repeats that arrive while a
 *   request is in flight share its promise.
 * - **Priority.** Text in the viewport jumps ahead of text below the fold, so
 *   what the visitor is looking at settles first.
 * - **Backoff.** Free and shared endpoints answer 429 under load. Retrying with
 *   jitter turns a burst failure into a slow success instead of blank text.
 */
export class TranslationQueue {
  private readonly high: Job[] = []
  private readonly normal: Job[] = []
  private readonly inFlightByText = new Map<string, Promise<string>>()
  private readonly idleWaiters: Array<() => void> = []

  private active = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  private readonly maxBatchChars: number
  private readonly maxBatchSize: number
  private readonly concurrency: number
  private readonly retries: number
  private readonly debounce: number

  /** Characters handed to the provider, the billable number. */
  chars = 0
  requests = 0
  errors = 0

  constructor(private readonly options: QueueOptions) {
    this.maxBatchChars = options.maxBatchChars ?? 5000
    this.maxBatchSize = options.maxBatchSize ?? 100
    this.concurrency = options.concurrency ?? 4
    this.retries = options.retries ?? 2
    this.debounce = options.debounce ?? 12
  }

  get pending(): number {
    return this.high.length + this.normal.length
  }

  get inFlight(): number {
    return this.active
  }

  get idle(): boolean {
    return this.active === 0 && this.pending === 0
  }

  /**
   * Queue a string. Identical strings already queued or in flight return the
   * same promise, so callers never need to de-duplicate themselves.
   */
  request(text: string, priority = false): Promise<string> {
    const existing = this.inFlightByText.get(text)
    if (existing) return existing

    if (this.destroyed) return Promise.reject(new Error('lingoweave: queue destroyed'))

    const promise = new Promise<string>((resolve, reject) => {
      const job: Job = { text, resolve, reject }
      if (priority) this.high.push(job)
      else this.normal.push(job)
    })

    this.inFlightByText.set(text, promise)
    // Settle the bookkeeping either way, and swallow here so an ignored
    // rejection upstream never surfaces as an unhandled rejection.
    void promise.then(
      () => this.inFlightByText.delete(text),
      () => this.inFlightByText.delete(text),
    )

    this.schedule(priority)
    return promise
  }

  /** Dispatch everything queued and resolve once the queue is empty. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pump()
    if (this.idle) return
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  destroy(): void {
    this.destroyed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const abandoned = [...this.high, ...this.normal]
    this.high.length = 0
    this.normal.length = 0
    const error = new Error('lingoweave: queue destroyed')
    for (const job of abandoned) job.reject(error)
    this.releaseIdleWaiters()
  }

  private schedule(priority: boolean): void {
    // Priority work should not sit behind the collection window.
    if (priority) {
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
      queueMicrotask(() => this.pump())
      return
    }

    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, this.debounce)
  }

  private pump(): void {
    if (this.destroyed) return

    while (this.active < this.concurrency && this.pending > 0) {
      const batch = this.takeBatch()
      if (batch.length === 0) break

      this.active++
      void this.run(batch).then(
        () => this.onBatchSettled(),
        () => this.onBatchSettled(),
      )
    }

    if (this.idle) this.releaseIdleWaiters()
  }

  private onBatchSettled(): void {
    this.active--
    if (this.destroyed) return
    if (this.pending > 0) this.pump()
    else if (this.idle) this.releaseIdleWaiters()
  }

  private releaseIdleWaiters(): void {
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** Drain priority work first, then top the batch up with normal work. */
  private takeBatch(): Job[] {
    const batch: Job[] = []
    let chars = 0

    for (const source of [this.high, this.normal]) {
      while (source.length > 0) {
        const next = source[0] as Job
        const wouldExceed =
          batch.length >= this.maxBatchSize ||
          (batch.length > 0 && chars + next.text.length > this.maxBatchChars)
        if (wouldExceed) return batch

        source.shift()
        batch.push(next)
        chars += next.text.length
      }
    }

    return batch
  }

  private async run(batch: Job[]): Promise<void> {
    const texts = batch.map((job) => job.text)
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(attempt))
      if (this.destroyed) break

      try {
        this.requests++
        this.chars += texts.reduce((sum, text) => sum + text.length, 0)

        const results = await this.options.translate(texts)

        if (results.length !== texts.length) {
          throw new Error(
            `lingoweave: provider returned ${results.length} results for ${texts.length} inputs`,
          )
        }

        batch.forEach((job, index) => job.resolve(results[index] as string))
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }

    const error = lastError ?? new Error('lingoweave: translation failed')
    this.errors++
    this.options.onError?.(error, texts)
    for (const job of batch) job.reject(error)
  }
}

/** Exponential backoff with jitter, so retries from many tabs don't align. */
function backoffDelay(attempt: number): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 4000)
  return base + Math.random() * base * 0.3
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { noop }

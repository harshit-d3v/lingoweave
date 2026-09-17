import type { CacheMode } from '../types.js'

const DB_NAME = 'lingoweave'
const DB_VERSION = 1
const STORE = 'translations'
const LS_KEY = 'lingoweave:cache'

/** localStorage is capped ~5 MB per origin; stay well under it. */
const LS_MAX_CHARS = 1_500_000

/**
 * Layered translation cache.
 *
 * The whole persisted cache is pulled into memory once by {@link open}, which
 * makes {@link get} synchronous. That matters more than it looks: a synchronous
 * lookup lets the engine apply known translations in the same frame the nodes
 * are discovered, so a returning visitor never sees a flash of the source
 * language. An async-only cache cannot do that.
 *
 * Read order is memory (which holds dictionary seeds, persisted entries and
 * this session's results). Writes land in memory immediately and are batched
 * out to IndexedDB, or localStorage where IndexedDB is unavailable, such as
 * some private-browsing modes.
 */
export class TranslationCache {
  private readonly entries = new Map<string, string>()
  /** Written since the last flush. */
  private readonly pending = new Map<string, string>()
  /** Seeded from dictionaries, never written back to storage. */
  private readonly seeded = new Set<string>()

  private db: IDBDatabase | null = null
  private useLocalStorage = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private opened = false

  hits = 0
  misses = 0

  constructor(private readonly mode: CacheMode = 'indexeddb') {}

  get size(): number {
    return this.entries.size
  }

  /**
   * Load persisted entries into memory. Safe to call more than once, and safe
   * to skip entirely, the cache degrades to memory-only rather than failing.
   */
  async open(): Promise<void> {
    if (this.opened || this.mode !== 'indexeddb') {
      this.opened = true
      return
    }
    this.opened = true

    try {
      this.db = await openDatabase()
      const stored = await readAll(this.db)
      for (const [key, value] of stored) {
        // Dictionary seeds are authoritative; don't let stale storage win.
        if (!this.seeded.has(key)) this.entries.set(key, value)
      }
    } catch {
      this.db = null
      this.readLocalStorage()
    }
  }

  /** Synchronous by design, see the class note. */
  get(key: string): string | undefined {
    const found = this.entries.get(key)
    if (found === undefined) this.misses++
    else this.hits++
    return found
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  set(key: string, value: string): void {
    this.entries.set(key, value)
    if (this.mode === false || this.mode === 'memory') return
    this.pending.set(key, value)
    this.scheduleFlush()
  }

  /**
   * Install pre-translated strings from a dictionary file. These cost nothing,
   * apply synchronously, and are never persisted, the dictionary on disk is
   * already the source of truth.
   */
  seed(dictionary: Record<string, string>): void {
    for (const key of Object.keys(dictionary)) {
      const value = dictionary[key]
      if (value === undefined) continue
      this.entries.set(key, value)
      this.seeded.add(key)
    }
  }

  /** Everything learned at runtime, ready to be committed as a dictionary. */
  export(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of this.entries) {
      if (!this.seeded.has(key)) out[key] = value
    }
    return out
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 1000)
  }

  /** Push pending writes to storage. Never rejects. */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.size === 0) return

    const batch = [...this.pending]
    this.pending.clear()

    try {
      if (this.db) await writeAll(this.db, batch)
      else if (this.useLocalStorage) this.writeLocalStorage()
    } catch {
      // Storage is a nicety. Losing a write costs one re-translation later.
    }
  }

  async clear(): Promise<void> {
    this.entries.clear()
    this.pending.clear()
    this.seeded.clear()
    this.hits = 0
    this.misses = 0
    try {
      if (this.db) await clearStore(this.db)
      if (this.useLocalStorage) localStorage.removeItem(LS_KEY)
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.db?.close()
    this.db = null
  }

  private readLocalStorage(): void {
    try {
      const raw = localStorage.getItem(LS_KEY)
      this.useLocalStorage = true
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, string>
      for (const key of Object.keys(parsed)) {
        const value = parsed[key]
        if (value !== undefined && !this.seeded.has(key)) this.entries.set(key, value)
      }
    } catch {
      this.useLocalStorage = false
    }
  }

  private writeLocalStorage(): void {
    // Insertion order gives us a cheap FIFO trim when we approach the quota.
    let payload = this.export()
    let serialized = JSON.stringify(payload)

    if (serialized.length > LS_MAX_CHARS) {
      const keys = Object.keys(payload)
      const keep = keys.slice(Math.floor(keys.length / 2))
      payload = Object.fromEntries(keep.map((k) => [k, payload[k] as string]))
      serialized = JSON.stringify(payload)
    }

    try {
      localStorage.setItem(LS_KEY, serialized)
    } catch {
      // Quota exceeded even after trimming, give up on persistence.
      this.useLocalStorage = false
    }
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
    request.onblocked = () => reject(new Error('indexedDB blocked'))
  })
}

function readAll(db: IDBDatabase): Promise<Array<[string, string]>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const out: Array<[string, string]> = []
    const cursor = store.openCursor()

    cursor.onsuccess = () => {
      const c = cursor.result
      if (!c) {
        resolve(out)
        return
      }
      if (typeof c.key === 'string' && typeof c.value === 'string') {
        out.push([c.key, c.value])
      }
      c.continue()
    }
    cursor.onerror = () => reject(cursor.error ?? new Error('indexedDB read failed'))
  })
}

function writeAll(db: IDBDatabase, batch: Array<[string, string]>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const [key, value] of batch) store.put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'))
  })
}

function clearStore(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB clear failed'))
  })
}

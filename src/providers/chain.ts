import type { LanguageCode, Provider } from '../types.js'
import { chromeBuiltIn, hasChromeBuiltIn } from './chrome-builtin.js'

/**
 * Whether this looks like a development machine.
 *
 * Used to decide if the free public endpoint is allowed. Deliberately
 * conservative: anything it cannot positively identify as local is treated as
 * production, because the failure mode of guessing wrong is a real site quietly
 * depending on an endpoint that will rate-limit it.
 */
export function isDevHost(hostname = globalThis.location?.hostname ?? ''): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    hostname === '' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.test') ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
}

export interface FreeDevOptions {
  /** Override the endpoint, e.g. to point at a LibreTranslate instance. */
  endpoint?: string
  /** Allow this in production too. Not recommended, see the warning below. */
  allowInProduction?: boolean
  onWarning?: (message: string) => void
}

/**
 * A keyless public endpoint, for development only.
 *
 * This exists so that `npm install lingoweave` followed by one line of setup
 * visibly works on any browser, immediately, with no account. That first-run
 * experience is the whole point of the library, and on Safari, Firefox and every
 * mobile browser the on-device translator is not there to provide it.
 *
 * It refuses to run on a non-local hostname. Unofficial endpoints answer 429
 * under load and can change without notice, so a real site depending on one
 * would break in front of its visitors and put the terms-of-service risk on the
 * site owner. In production the chain warns and leaves the page in its source
 * language instead, a page in the wrong language is recoverable, a page of
 * failed requests is not.
 */
export function freeDev(options: FreeDevOptions = {}): Provider {
  const endpoint = options.endpoint ?? 'https://translate.googleapis.com/translate_a/single'
  let warned = false

  return {
    id: 'free-dev',
    costPerMillionChars: 0,
    // One string per request: this endpoint has no batch form, and keeping
    // requests small makes rate limiting less likely to bite.
    maxBatchSize: 1,
    maxBatchChars: 1800,

    async available() {
      if (options.allowInProduction || isDevHost()) return true
      if (!warned) {
        warned = true
        options.onWarning?.(
          'lingoweave: the keyless dev endpoint is disabled outside localhost, so ' +
            'this page will stay in its source language. Configure a provider for ' +
            'production, see https://www.npmjs.com/package/lingoweave#providers',
        )
      }
      return false
    },

    async translate(texts, from, to) {
      const out: string[] = []

      for (const text of texts) {
        const url = new URL(endpoint)
        url.searchParams.set('client', 'gtx')
        url.searchParams.set('sl', from === 'auto' ? 'auto' : from)
        url.searchParams.set('tl', to)
        url.searchParams.set('dt', 't')
        url.searchParams.set('q', text)

        const response = await fetch(url.toString())
        if (!response.ok) {
          throw new Error(`lingoweave: dev endpoint returned ${response.status}`)
        }

        // Shape: [[[translated, original, ...], ...], ...]
        const payload = (await response.json()) as unknown
        out.push(joinSegments(payload) ?? text)
      }

      return out
    },
  }
}

function joinSegments(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null
  const segments = payload[0]
  if (!Array.isArray(segments)) return null

  let joined = ''
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === 'string') joined += segment[0]
  }
  return joined.length > 0 ? joined : null
}

export interface ChainOptions {
  onWarning?: (message: string) => void
  onFallback?: (from: string, to: string, error: Error) => void
}

/**
 * Try each provider in order until one answers.
 *
 * Availability is resolved once per language pair and remembered, so the probe
 * cost, which for the on-device translator can mean a model download check , 
 * is paid once rather than per batch.
 *
 * A provider that throws mid-session is skipped for the rest of the session.
 * Being handed a 429 or an expired key means the next batch will fail the same
 * way, and retrying it ahead of a working provider would just stall the page.
 */
export function chain(providers: Provider[], options: ChainOptions = {}): Provider {
  const resolved = new Map<string, Promise<Provider[]>>()
  const broken = new Set<string>()

  const usableFor = (from: LanguageCode, to: LanguageCode): Promise<Provider[]> => {
    const key = `${from}->${to}`
    let existing = resolved.get(key)
    if (!existing) {
      existing = (async () => {
        const usable: Provider[] = []
        for (const provider of providers) {
          try {
            if (await provider.available(from, to)) usable.push(provider)
          } catch {
            // An unavailable provider is not an error worth surfacing.
          }
        }
        return usable
      })()
      resolved.set(key, existing)
    }
    return existing
  }

  return {
    id: 'chain',
    maxBatchSize: Math.min(...providers.map((p) => p.maxBatchSize ?? 100)),
    maxBatchChars: Math.min(...providers.map((p) => p.maxBatchChars ?? 5000)),

    get costPerMillionChars() {
      return providers.find((p) => !broken.has(p.id))?.costPerMillionChars ?? 0
    },

    async available(from, to) {
      const usable = await usableFor(from, to)
      return usable.some((provider) => !broken.has(provider.id))
    },

    async translate(texts, from, to) {
      const usable = await usableFor(from, to)
      const candidates = usable.filter((provider) => !broken.has(provider.id))

      if (candidates.length === 0) {
        options.onWarning?.(
          `lingoweave: no translation provider available for ${from} → ${to}. ` +
            'The page stays in its source language.',
        )
        throw new Error(`lingoweave: no provider available for ${from} → ${to}`)
      }

      let lastError: Error | null = null

      for (const provider of candidates) {
        try {
          return await provider.translate(texts, from, to)
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          broken.add(provider.id)
          options.onFallback?.(provider.id, to, lastError)
        }
      }

      throw lastError ?? new Error('lingoweave: every provider failed')
    },
  }
}

/**
 * The default chain, used when no providers are configured.
 *
 * On-device first: free, private, offline-capable. Then the dev-only keyless
 * endpoint, which refuses to run anywhere but localhost. In production with
 * nothing configured this chain has no members, warns once, and leaves the page
 * alone, which is the honest outcome, not a silent failure.
 */
export function defaultChain(options: ChainOptions = {}): Provider {
  const providers: Provider[] = []
  if (hasChromeBuiltIn()) providers.push(chromeBuiltIn())
  providers.push(freeDev({ onWarning: options.onWarning }))
  return chain(providers, options)
}

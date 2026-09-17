import type { LanguageCode, Provider } from '../types.js'

/**
 * Chrome's built-in on-device Translator API, shipped from Chrome 138.
 *
 * This is the reason lingoweave can work with no signup, no key and no bill.
 * The model runs inside the browser: nothing leaves the device, it keeps working
 * offline once the language pack is downloaded, and it costs nothing however
 * much text a site has.
 *
 * The honest limits: desktop Chromium only, no Safari, no Firefox, and no
 * mobile, and the first use of a language pair downloads a model, which takes a
 * few seconds. So this is the first link in a chain, never the only one. See
 * {@link chain} for how the fallbacks are ordered.
 */

/** Shape of the global the browser exposes. Not yet in TypeScript's DOM lib. */
interface TranslatorFactory {
  availability(options: {
    sourceLanguage: string
    targetLanguage: string
  }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>

  create(options: {
    sourceLanguage: string
    targetLanguage: string
    monitor?: (monitor: EventTarget) => void
  }): Promise<TranslatorInstance>
}

interface TranslatorInstance {
  translate(text: string): Promise<string>
  destroy?: () => void
}

export interface ChromeBuiltInOptions {
  /**
   * Download a language pack if it is not present yet. Default `true`.
   * Set `false` to use only pairs already installed, which keeps the first
   * paint fast at the cost of falling through to the next provider more often.
   */
  download?: boolean
  onDownloadProgress?: (loaded: number) => void
}

function factory(): TranslatorFactory | null {
  const candidate = (globalThis as { Translator?: unknown }).Translator
  if (!candidate || typeof candidate !== 'object') return null
  const maybe = candidate as Partial<TranslatorFactory>
  if (typeof maybe.availability !== 'function' || typeof maybe.create !== 'function') {
    return null
  }
  return candidate as TranslatorFactory
}

/** Whether this browser exposes the on-device translator at all. */
export function hasChromeBuiltIn(): boolean {
  return factory() !== null
}

export function chromeBuiltIn(options: ChromeBuiltInOptions = {}): Provider {
  const allowDownload = options.download !== false

  // Instances are per language pair and expensive to build, so they are reused
  // for as long as the page keeps the same target language.
  const instances = new Map<string, Promise<TranslatorInstance>>()

  const instanceFor = (
    from: LanguageCode,
    to: LanguageCode,
  ): Promise<TranslatorInstance> => {
    const key = `${from}->${to}`
    let existing = instances.get(key)
    if (!existing) {
      const api = factory()
      if (!api) return Promise.reject(new Error('lingoweave: Translator API unavailable'))

      existing = api.create({
        sourceLanguage: from,
        targetLanguage: to,
        monitor: options.onDownloadProgress
          ? (monitor) => {
              monitor.addEventListener('downloadprogress', (event) => {
                const loaded = (event as Event & { loaded?: number }).loaded
                if (typeof loaded === 'number') options.onDownloadProgress?.(loaded)
              })
            }
          : undefined,
      })

      // A failed create must not be cached, or the pair is dead for the session.
      existing.catch(() => instances.delete(key))
      instances.set(key, existing)
    }
    return existing
  }

  return {
    id: 'chrome-builtin',
    costPerMillionChars: 0,
    // On-device translation is per string; batching buys nothing, and a big
    // batch would only delay the first visible result.
    maxBatchSize: 1,

    async available(from, to) {
      const api = factory()
      if (!api) return false
      if (from === to) return false

      try {
        const state = await api.availability({ sourceLanguage: from, targetLanguage: to })
        if (state === 'available') return true
        return allowDownload && (state === 'downloadable' || state === 'downloading')
      } catch {
        return false
      }
    },

    async translate(texts, from, to) {
      const instance = await instanceFor(from, to)
      const out: string[] = []
      for (const text of texts) out.push(await instance.translate(text))
      return out
    },
  }
}

/**
 * Chrome's on-device language detector, used to work out the page's source
 * language when `<html lang>` is missing or wrong.
 */
export async function detectLanguageOnDevice(sample: string): Promise<string | null> {
  const candidate = (globalThis as { LanguageDetector?: unknown }).LanguageDetector
  if (!candidate || typeof candidate !== 'object') return null

  const api = candidate as {
    availability?: () => Promise<string>
    create?: () => Promise<{
      detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>
    }>
  }
  if (typeof api.create !== 'function') return null

  try {
    const detector = await api.create()
    const results = await detector.detect(sample)
    const best = results[0]
    // Below this the guess is noise, and guessing wrong is worse than not
    // guessing: it would translate from the wrong language.
    return best && best.confidence > 0.5 ? best.detectedLanguage : null
  } catch {
    return null
  }
}

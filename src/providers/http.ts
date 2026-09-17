import type { Provider } from '../types.js'

/**
 * Cloud translation providers.
 *
 * ## About API keys in a browser
 *
 * Anything passed as `key` here ships to every visitor and is readable in
 * DevTools. There is no way around that: it is client-side code. Treat a key
 * used this way as public.
 *
 * That is fine for a metered key you have restricted by HTTP referrer, and for
 * self-hosted LibreTranslate where there is nothing to steal. It is not fine for
 * an unrestricted paid key.
 *
 * The safe pattern is to point `endpoint` at a small route on your own server
 * that holds the real key and forwards the request. Every provider below accepts
 * `endpoint` for exactly this, and {@link proxy} wires up the common case in one
 * line.
 */

export interface HttpProviderOptions {
  /** Replace the upstream URL, normally your own proxy route. */
  endpoint?: string
  /** Extra headers, e.g. a session cookie or CSRF token for your proxy. */
  headers?: Record<string, string>
  /** Passed to `fetch`. Default `'omit'`, so cookies are not sent upstream. */
  credentials?: RequestCredentials
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  credentials: RequestCredentials = 'omit',
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    credentials,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `lingoweave: ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }

  return response.json()
}

/**
 * Google Translate v2.
 *
 * Note the HTML unescaping: this API returns `&#39;` for an apostrophe even when
 * `format: 'text'` is requested, so replies would otherwise show entity codes on
 * the page.
 */
export function google(
  options: HttpProviderOptions & { key?: string } = {},
): Provider {
  const endpoint = options.endpoint ?? 'https://translation.googleapis.com/language/translate/v2'

  return {
    id: 'google',
    costPerMillionChars: 20,
    maxBatchChars: 5000,
    maxBatchSize: 100,

    async available() {
      return Boolean(options.key) || Boolean(options.endpoint)
    },

    async translate(texts, from, to) {
      const url = options.key ? `${endpoint}?key=${encodeURIComponent(options.key)}` : endpoint
      const payload = await postJson(
        url,
        { q: texts, target: to, source: from === 'auto' ? undefined : from, format: 'text' },
        options.headers ?? {},
        options.credentials,
      )

      const translations = (payload as {
        data?: { translations?: Array<{ translatedText?: string }> }
      }).data?.translations

      if (!translations) throw new Error('lingoweave: unexpected Google response')
      return translations.map((t) => decodeHtmlEntities(t.translatedText ?? ''))
    },
  }
}

/** DeepL. Highest quality of the cloud options for European languages. */
export function deepl(
  options: HttpProviderOptions & { key?: string; free?: boolean; formality?: 'default' | 'less' | 'more' } = {},
): Provider {
  const host = options.free === false ? 'https://api.deepl.com' : 'https://api-free.deepl.com'
  const endpoint = options.endpoint ?? `${host}/v2/translate`

  return {
    id: 'deepl',
    costPerMillionChars: 25,
    maxBatchChars: 5000,
    maxBatchSize: 50,

    async available() {
      return Boolean(options.key) || Boolean(options.endpoint)
    },

    async translate(texts, from, to) {
      const headers: Record<string, string> = { ...options.headers }
      if (options.key) headers.authorization = `DeepL-Auth-Key ${options.key}`

      const payload = await postJson(
        endpoint,
        {
          text: texts,
          target_lang: to.toUpperCase(),
          source_lang: from === 'auto' ? undefined : from.toUpperCase(),
          formality: options.formality,
        },
        headers,
        options.credentials,
      )

      const translations = (payload as { translations?: Array<{ text?: string }> }).translations
      if (!translations) throw new Error('lingoweave: unexpected DeepL response')
      return translations.map((t) => t.text ?? '')
    },
  }
}

/**
 * Microsoft Translator. The cheapest managed option, and its free tier , 
 * 2 million characters a month, permanently, covers a lot of real sites.
 */
export function microsoft(
  options: HttpProviderOptions & { key?: string; region?: string } = {},
): Provider {
  const endpoint =
    options.endpoint ?? 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0'

  return {
    id: 'microsoft',
    costPerMillionChars: 10,
    maxBatchChars: 10_000,
    maxBatchSize: 100,

    async available() {
      return Boolean(options.key) || Boolean(options.endpoint)
    },

    async translate(texts, from, to) {
      const headers: Record<string, string> = { ...options.headers }
      if (options.key) headers['ocp-apim-subscription-key'] = options.key
      if (options.region) headers['ocp-apim-subscription-region'] = options.region

      const url = new URL(endpoint)
      url.searchParams.set('to', to)
      if (from !== 'auto') url.searchParams.set('from', from)

      const payload = await postJson(
        url.toString(),
        texts.map((text) => ({ Text: text })),
        headers,
        options.credentials,
      )

      const results = payload as Array<{ translations?: Array<{ text?: string }> }>
      if (!Array.isArray(results)) throw new Error('lingoweave: unexpected Microsoft response')
      return results.map((r) => r.translations?.[0]?.text ?? '')
    },
  }
}

/**
 * LibreTranslate, self-hosted or a public instance.
 *
 * The right choice when text must not leave your infrastructure, or when volume
 * makes per-character pricing untenable.
 */
export function libretranslate(
  options: HttpProviderOptions & { url?: string; key?: string } = {},
): Provider {
  const endpoint = options.endpoint ?? `${options.url ?? 'http://localhost:5000'}/translate`

  return {
    id: 'libretranslate',
    costPerMillionChars: 0,
    maxBatchChars: 5000,
    maxBatchSize: 50,

    async available() {
      return true
    },

    async translate(texts, from, to) {
      const payload = await postJson(
        endpoint,
        {
          q: texts,
          source: from === 'auto' ? 'auto' : from,
          target: to,
          format: 'text',
          api_key: options.key,
        },
        options.headers ?? {},
        options.credentials,
      )

      const result = (payload as { translatedText?: string | string[] }).translatedText
      if (Array.isArray(result)) return result
      // A single-item request comes back unwrapped.
      if (typeof result === 'string' && texts.length === 1) return [result]
      throw new Error('lingoweave: unexpected LibreTranslate response')
    },
  }
}

/**
 * Any OpenAI-compatible chat endpoint, including Anthropic-compatible gateways.
 *
 * Worth the extra latency when tone matters: `instructions` can hold brand
 * voice, formality, or "keep these product names in English", which no
 * conventional translation API accepts.
 */
export function llm(
  options: HttpProviderOptions & {
    key?: string
    model?: string
    /** Extra guidance appended to the system prompt. */
    instructions?: string
  } = {},
): Provider {
  const endpoint = options.endpoint ?? 'https://api.openai.com/v1/chat/completions'
  const model = options.model ?? 'gpt-4o-mini'

  return {
    id: 'llm',
    costPerMillionChars: 1,
    maxBatchChars: 4000,
    maxBatchSize: 40,

    async available() {
      return Boolean(options.key) || Boolean(options.endpoint)
    },

    async translate(texts, from, to) {
      const headers: Record<string, string> = { ...options.headers }
      if (options.key) headers.authorization = `Bearer ${options.key}`

      const system = [
        `Translate each string from ${from === 'auto' ? 'its source language' : from} to ${to}.`,
        'Return ONLY a JSON array of strings, the same length and order as the input.',
        'Preserve placeholders like <0>, </0> and <0/> exactly as they appear.',
        'Do not add explanation, notes or extra punctuation.',
        options.instructions ?? '',
      ]
        .filter(Boolean)
        .join(' ')

      const payload = await postJson(
        endpoint,
        {
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(texts) },
          ],
        },
        headers,
        options.credentials,
      )

      const content = (payload as {
        choices?: Array<{ message?: { content?: string } }>
      }).choices?.[0]?.message?.content

      if (typeof content !== 'string') throw new Error('lingoweave: unexpected LLM response')

      const parsed = JSON.parse(stripCodeFence(content)) as unknown
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
        throw new Error('lingoweave: LLM did not return an array of strings')
      }
      return parsed as string[]
    },
  }
}

/**
 * Your own server route, holding the real key.
 *
 * The recommended production setup. Expects `POST { texts, from, to }` and a
 * reply of `{ translations: string[] }` in the same order.
 */
export function proxy(url: string, options: HttpProviderOptions = {}): Provider {
  return {
    id: 'proxy',
    costPerMillionChars: 0,
    maxBatchChars: 8000,
    maxBatchSize: 100,

    async available() {
      return true
    },

    async translate(texts, from, to) {
      const payload = await postJson(
        url,
        { texts, from, to },
        options.headers ?? {},
        options.credentials ?? 'same-origin',
      )

      const translations = (payload as { translations?: unknown }).translations
      if (!Array.isArray(translations) || translations.some((t) => typeof t !== 'string')) {
        throw new Error('lingoweave: proxy must return { translations: string[] }')
      }
      return translations as string[]
    },
  }
}

/** Wrap any async function as a provider. The escape hatch for anything else. */
export function custom(
  translate: (texts: string[], from: string, to: string) => Promise<string[]>,
  meta: { id?: string; costPerMillionChars?: number; maxBatchSize?: number } = {},
): Provider {
  return {
    id: meta.id ?? 'custom',
    costPerMillionChars: meta.costPerMillionChars ?? 0,
    maxBatchSize: meta.maxBatchSize,
    async available() {
      return true
    },
    translate,
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
}

/** Google returns entity-encoded text even in text mode. */
function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(
    /&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g,
    (match) => ENTITIES[match] ?? match,
  )
}

/** Models like wrapping JSON in ```json fences however firmly you ask them not to. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

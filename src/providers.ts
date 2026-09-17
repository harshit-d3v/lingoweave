/**
 * Translation backends.
 *
 * Ordered here roughly the way you should reach for them:
 *
 * - {@link chromeBuiltIn}: free, on-device, private, offline. Desktop Chromium only.
 * - {@link proxy}: your own server route. The right production default, because
 *   it is the only option that keeps a paid key off the client.
 * - {@link microsoft}: cheapest managed API, 2M chars/month free permanently.
 * - {@link deepl}: best quality for European languages.
 * - {@link google}: widest language coverage.
 * - {@link libretranslate}: self-hosted, nothing leaves your infrastructure.
 * - {@link llm}: when tone, formality or brand voice matter.
 * - {@link custom}: anything else.
 * - {@link freeDev}: keyless, localhost only, so the first run works with no setup.
 *
 * Compose them with {@link chain}, which falls through on failure.
 */

export {
  chromeBuiltIn,
  detectLanguageOnDevice,
  hasChromeBuiltIn,
  type ChromeBuiltInOptions,
} from './providers/chrome-builtin.js'

export {
  custom,
  deepl,
  google,
  libretranslate,
  llm,
  microsoft,
  proxy,
  type HttpProviderOptions,
} from './providers/http.js'

export {
  chain,
  defaultChain,
  freeDev,
  isDevHost,
  type ChainOptions,
  type FreeDevOptions,
} from './providers/chain.js'

export type { LanguageCode, Provider } from './types.js'

# lingoweave

[![npm](https://img.shields.io/npm/v/lingoweave.svg)](https://www.npmjs.com/package/lingoweave)
[![bundle](https://img.shields.io/badge/core-8.2%20kB%20brotli-blue.svg)](https://www.npmjs.com/package/lingoweave)
[![types](https://img.shields.io/badge/types-included-blue.svg)](https://www.npmjs.com/package/lingoweave)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/lingoweave)
[![license](https://img.shields.io/npm/l/lingoweave.svg)](https://www.npmjs.com/package/lingoweave)

**Drop-in automatic translation for your whole website.** One line, and every string on the page is translated, including the ones every other library misses.

```bash
npm install lingoweave
```

```js
import { weave } from 'lingoweave'

await weave({ to: 'es' })
```

That's it. No account, no API key to get started, no JSON dictionaries to maintain, no wrapping your text in `<T>` components. Zero dependencies, 8.2 kB.

**Live demo:** [harshit-d3v.github.io/lingoweave](https://harshit-d3v.github.io/lingoweave/), every hard case on one page with a language switcher.

---

## What it actually translates

Not just text nodes. The long tail is where "translate my site" normally falls apart:

| | |
|---|---|
| Text | every text node, at any depth |
| **Closed dropdowns** | `display: none` content is translated *before* it's opened |
| **Submenus** | including nested, including injected on click |
| Modals & toasts | unopened dialogs, portals, notifications |
| Form labels | `placeholder`, `aria-label`, `aria-description`, `label` |
| Images | `alt`, `title` |
| Selects | `<option>`, `<optgroup label>` |
| Buttons | `value` on submit/reset/button inputs |
| Browser tab | `<title>` |
| Social previews | `description`, `og:*`, `twitter:*` |
| SVG | `<text>`, `<tspan>`, `<title>`, `<desc>` |
| **Shadow DOM** | open shadow roots, nested, each with its own observer |
| **Anything added later** | infinite scroll, route changes, async content |

And it deliberately leaves alone: `<code>`, `<pre>`, `<script>`, `<style>`, textarea contents, `contenteditable`, user-typed input values, machine-facing meta tags, `translate="no"`, `.notranslate`, and `[data-lw-ignore]`.

## Why this exists

Google discontinued its free Website Translator widget for commercial sites in 2019. Nothing open-source properly replaced it. The libraries that do exist share four problems.

### 1. They crash React

Google Translate and every wrapper-based translator replace a text node with a `<font>` element. React still holds a reference to the original node, so its next `parent.removeChild(node)` throws `Failed to execute 'removeChild' on 'Node'`. That's [facebook/react#11538](https://github.com/facebook/react/issues/11538), open since 2017.

lingoweave never replaces, wraps, or moves a node. It assigns to `nodeValue` and calls `setAttribute`, and nothing else. Node identity survives, so every framework's stored references stay valid.

### 2. They lose to re-renders

When a framework re-renders a translated node it writes the original string straight back. Naive translators either give up (text reverts permanently) or re-translate over the network (flicker, and another charge).

lingoweave records both the source and exactly what it wrote, so it tells three cases apart:

- **its own write echoing back** → ignore it. This is what stops the translate-observe-translate loop
- **a re-render** → re-apply from cache in the same task: no network, no flicker, no second charge
- **genuinely new text** → translate it

### 3. They can't see into Shadow DOM

`TreeWalker` doesn't cross shadow boundaries, [Firefox's own translator has this open](https://bugzilla.mozilla.org/show_bug.cgi?id=1841656), and Google Translate fails too. Every Lit / Ionic / web-component UI goes untranslated.

lingoweave walks each shadow root as its own tree, with its own observer.

### 4. They translate fragments, not sentences

`<p>Only <b>signed-in</b> users can post</p>` is three text nodes. Send three requests and you get three fragments translated with no knowledge of each other, gender, case and word order each decided blindly. In inflected languages the result is wrong, not merely clumsy.

lingoweave sends one string and puts the reply back:

```
sent:      Only <0>signed-in</0> users can post
ja reply:  <0>ログイン済み</0>のユーザーのみ投稿できます
rendered:  <b>ログイン済み</b>のユーザーのみ投稿できます
```

Note the bold moved to the front, Japanese word order differs, and it still reads correctly, because each node is pinned to a *position in the sentence*, not just to an inline container. If a provider mangles the placeholders, it falls back to per-node rather than corrupting your markup.

## Providers

Zero config uses **Chrome's built-in on-device translator** (Chrome 138+): free, private, works offline, costs nothing at any volume. On other browsers a keyless endpoint covers **localhost only**, so your first run works immediately.

In production with no provider configured it warns once and leaves the page in its source language, rather than quietly depending on an endpoint that will rate-limit you in front of real users.

To be clear about that keyless endpoint: it is Google's undocumented web translation endpoint, it only runs on localhost, and it can stop working any day. It exists so the first `weave()` shows something. Do not build on it.

```js
import { weave } from 'lingoweave'
import { chromeBuiltIn, proxy } from 'lingoweave/providers'

await weave({
  to: 'auto',                  // from navigator.languages
  providers: [
    chromeBuiltIn(),           // free, on-device, offline
    proxy('/api/translate'),   // your server; your key stays secret
  ],
})
```

| Provider | Notes |
|---|---|
| `chromeBuiltIn()` | Free, on-device, offline, private. Desktop Chromium only |
| `proxy(url)` | Your own route. **The right production default** |
| `microsoft({ key })` | Cheapest managed API, 2M chars/month free, permanently |
| `deepl({ key })` | Best quality for European languages |
| `google({ key })` | Widest language coverage |
| `libretranslate({ url })` | Self-hosted; nothing leaves your infrastructure |
| `llm({ key, instructions })` | Any OpenAI-compatible endpoint, for tone and brand voice |
| `custom(fn)` | Anything else |
| `chain([...])` | Compose with fallback |

> ### A key in client-side code is public
>
> Anything you pass as `key` ships to every visitor and is readable in DevTools. There is no way around that, it's client-side code.
>
> That's fine for a referrer-restricted key, or self-hosted LibreTranslate where there's nothing to steal. It is **not** fine for an unrestricted paid key. Use `proxy('/api/translate')` and keep the real key on your server. Every provider also accepts `endpoint` for this.
>
> Your proxy route receives `POST { texts, from, to }` and returns `{ translations: string[] }` in the same order.

## Cost control

- **Deduplication**: a nav label in a desktop menu, a mobile menu and a footer is one billed string
- **Persistent cache**: IndexedDB, loaded into memory up front so lookups are *synchronous*. A returning visitor's page is translated before first paint, with zero network requests
- **Dictionaries**: commit translations to JSON and pay nothing, ever
- **A cost meter**: characters sent, characters saved, cache hit rate, estimated USD

```js
const weaver = await weave({
  to: 'es',
  dictionaries: { es: await import('./locales/es.json') },  // 0 API calls
})

weaver.stats()
// { chars: 0, charsSaved: 4210, requests: 0, cacheHitRate: 1, estimatedCost: 0, ... }

weaver.export()   // runtime translations, ready to commit as a dictionary
```

## Human control over the machine

```js
await weave({
  to: 'es',
  overrides: { es: { 'Sign in': 'Iniciar sesión' } },  // beats the machine
  glossary: { Acme: 'Acme' },                          // never translated
  ignore: ['.chart-labels', '#code-sample'],
})
```

For a brand name *inside* a sentence, use the standard `translate="no"`, lingoweave honours it and falls back to per-node so the term survives intact.

## Scripts and writing systems

Switching to Arabic, Hebrew, Persian or Urdu sets `dir="rtl"` and `<html lang>` automatically. Translating the words but leaving the layout LTR gives you correct text that's unreadable.

CJK is a first-class case, not an afterthought. Japanese and Chinese have no spaces between words, so a sentence rebuilt from fragments must not invent any. Sentences end in `。`, which a regex looking for `.` never finds, `Intl.Segmenter` does. Full-width digits and CJK punctuation (`。` `、` `・` `￥1,200`) are skipped as non-prose, while a lone kanji like `円` is not.

## Language switcher

A dropdown that drives the weaver, shipped as a custom element. It is in the `<script>` build already; npm users import it once.

```html
<lingo-switcher languages="en,es,ja"></lingo-switcher>
```

```js
import { weave } from 'lingoweave'
import 'lingoweave/switcher'

const switcher = document.querySelector('lingo-switcher')
switcher.weaver = await weave({ to: 'auto' })
```

Picking a language fires a cancelable `lingo-change` event with `detail.language`, then calls `weaver.setLanguage()`. Picking the source language puts the original text back. Call `preventDefault()` on the event to handle the switch yourself.

## How it compares

| | Open source | Keeps node identity (React safe) | Shadow DOM | Free provider |
|---|---|---|---|---|
| Google Website Translator | no, discontinued 2019 | no | no | was |
| Weglot, Localize | no, paid SaaS | no | partial | no |
| translate.js | yes | no, replaces nodes | no | author-hosted |
| lingoweave | yes | yes | yes | Chrome on-device |

## API

```js
const weaver = await weave({ to: 'es' })

await weaver.setLanguage('ar')   // reuses everything already cached
weaver.stats()                   // cost and coverage
weaver.export()                  // runtime translations as a dictionary
await weaver.whenIdle()          // resolves once the page has settled
weaver.retranslate(element)      // force a re-scan
weaver.pause(); weaver.resume()
await weaver.destroy()           // puts every original string back
```

`createWeaver(options)` builds an instance without starting it, for when you need the reference first.

<details>
<summary><b>All options</b></summary>

| Option | Default | |
|---|---|---|
| `to` | *required* | target language, or `'auto'` for `navigator.languages` |
| `from` | `'auto'` | source; auto reads `<html lang>`, then detects on-device |
| `providers` | `'auto'` | provider array, or the default chain |
| `root` | `documentElement` | subtree to translate |
| `cache` | `'indexeddb'` | `'memory'`, `'indexeddb'` or `false` |
| `dictionaries` | none | pre-translated strings, per language |
| `shadowDom` | `true` | walk into open shadow roots |
| `attributes` | none | extra attributes, **added to** the defaults |
| `ignore` | none | CSS selectors to skip |
| `glossary` | none | terms never translated |
| `overrides` | none | hand-written translations that win |
| `rtl` | `true` | flip `dir` for RTL languages |
| `persistChoice` | `true` | remember the visitor's language |
| `onProgress` | none | coalesced progress callback |
| `onError` | none | `(error, { provider, texts })` |
| `debug` | `false` | log decisions to the console |

**`onProgress` and the DOM.** If your handler writes into the translated page, that write is new content, which fires progress again. lingoweave rate-limits this rather than hanging, but mark such elements `translate="no"` or keep them outside `root`.

</details>

## Plain HTML, no build step

Works on any site, including the ones the discontinued Google widget left with nothing.

```html
<script src="https://unpkg.com/lingoweave@0.2.0/dist/lingoweave.global.js"
        integrity="sha384-huw65kP6knFeZdAqWtW4ASI07EiA7q0F7DhqxyWG9N967QqjRPSXabQlKduWyFW6"
        crossorigin="anonymous"></script>
<script>lingoweave.weave({ to: 'es' })</script>
```

Copy that as-is, the hash is real and verified against what unpkg serves.

The `integrity` attribute is what makes this safe to paste into a production page. Without it the browser runs whatever the CDN hands over; with it, a substituted file is refused and the page breaks loudly instead of leaking quietly. That also means the version must be pinned: `@latest` and SRI cannot coexist, because the file changes underneath the hash.

To verify it yourself, or after any version bump:

```bash
curl -s https://unpkg.com/lingoweave@0.2.0/dist/lingoweave.global.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

`npm install` users need none of this, npm already verifies the tarball hash from your lockfile.

Everything is exposed on `window.lingoweave`: `weave`, `createWeaver`, `providers`, `isRtl`, `LingoSwitcher`, and `<lingo-switcher>` is registered for you.

## Honest limitations

- **SEO**: this is client-side, so crawlers mostly index your source language. Server-rendered translated HTML is the only real fix; `export()` is the building block for it
- **On-device is desktop Chromium only**: no Safari, no Firefox, no mobile. Configure a provider for production
- `<canvas>` text, cross-origin iframes, closed shadow roots, and CSS `::before`/`::after` content are not translated
- Machine translation is machine translation. Use `overrides` for the strings that matter

## Status

v0.2.0: core plus `<lingo-switcher>`. **197 unit tests** in happy-dom and a Playwright run in real Chromium against the [demo page](https://harshit-d3v.github.io/lingoweave/) on every push: closed dropdown, nested submenu, unopened modal, shadow root, attributes, injected content, `ar` flipping to RTL, and `en` restoring the original text. Zero dependencies, 8.2 kB brotlied, typechecked with TypeScript 7.

Next: a React adapter, closed-shadow-root support via a preload script, same-origin iframes, viewport-priority lazy mode, and a CLI that extracts dictionaries from a running site.

## License

MIT

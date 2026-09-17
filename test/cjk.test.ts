import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranslationFilter } from '../src/core/filter.js'
import { isRtl } from '../src/core/rtl.js'
import { scan } from '../src/core/scanner.js'
import {
  redistribute,
  serializeBlock,
  splitLongSource,
} from '../src/core/segmenter.js'
import { isTranslatableText } from '../src/core/surface.js'
import { weave } from '../src/index.js'
import type { LingoWeave } from '../src/core/engine.js'
import { custom } from '../src/providers/http.js'
import type { BlockUnit, TextUnit } from '../src/types.js'

/**
 * Japanese, Korean and Chinese break assumptions that Latin-script testing
 * never exercises: Japanese and Chinese put no spaces between words, sentences
 * end in `。` rather than `.`, and the scripts live in Unicode categories a
 * naive `[a-z]` filter would discard entirely.
 */

const filter = new TranslationFilter()

let live: LingoWeave | null = null

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  document.documentElement.lang = 'en'
})

afterEach(async () => {
  await live?.destroy()
  live = null
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('CJK, recognising the text at all', () => {
  it('accepts Japanese in all three scripts', () => {
    expect(isTranslatableText('こんにちは')).toBe(true) // hiragana
    expect(isTranslatableText('コンピュータ')).toBe(true) // katakana
    expect(isTranslatableText('日本語')).toBe(true) // kanji
    expect(isTranslatableText('お問い合わせ')).toBe(true) // mixed
  })

  it('accepts Korean hangul, syllables and jamo', () => {
    expect(isTranslatableText('안녕하세요')).toBe(true)
    expect(isTranslatableText('로그인')).toBe(true)
    expect(isTranslatableText('제품')).toBe(true)
  })

  it('still rejects CJK punctuation and full-width digits', () => {
    // These are the CJK equivalents of the bullets and counts that make up most
    // of a page by node count and none of it by meaning.
    expect(isTranslatableText('。')).toBe(false)
    expect(isTranslatableText('、')).toBe(false)
    expect(isTranslatableText('・')).toBe(false)
    expect(isTranslatableText('１２３')).toBe(false) // full-width digits
    expect(isTranslatableText('（）')).toBe(false)
    expect(isTranslatableText('￥１，２００')).toBe(false)
  })

  it('finds Japanese and Korean text in the DOM', () => {
    document.body.innerHTML = '<h1>ようこそ</h1><p>제품 목록</p><span>・</span>'
    const sources = scan(document.body, filter).units.map((u) => u.source)
    expect(sources).toEqual(['ようこそ', '제품 목록'])
  })

  it('translates Japanese attributes', () => {
    document.body.innerHTML = '<input placeholder="商品を検索"><img alt="赤い自転車" src="x">'
    const sources = scan(document.body, filter).units.map((u) => u.source)
    expect(sources).toEqual(['商品を検索', '赤い自転車'])
  })

  it('does not treat Japanese or Korean as right-to-left', () => {
    for (const lang of ['ja', 'ja-JP', 'ko', 'ko-KR', 'zh', 'zh-Hant']) {
      expect(isRtl(lang)).toBe(false)
    }
  })
})

describe('CJK, sentences without spaces', () => {
  it('splits Japanese at the ideographic full stop', () => {
    const source = '最初の文です。次の文です。三番目の文です。'
    const parts = splitLongSource(source, 'ja', 20)

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(source)
    // A regex on "." would never find these boundaries.
    for (const part of parts) expect(part).toMatch(/。$/)
  })

  it('splits Korean at its full stop', () => {
    const source = '첫 번째 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다.'
    const parts = splitLongSource(source, 'ko', 25)

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(source)
  })

  it('never drops a character when splitting Japanese', () => {
    const source = '日本語のテキストです。'.repeat(60)
    expect(splitLongSource(source, 'ja', 100).join('')).toBe(source)
  })

  it('breaks a single unbroken Japanese run that exceeds the limit', () => {
    // No punctuation at all, which is entirely normal for a Japanese heading.
    const source = 'あ'.repeat(300)
    const parts = splitLongSource(source, 'ja', 50)

    expect(parts.every((p) => p.length <= 50)).toBe(true)
    expect(parts.join('')).toBe(source)
  })
})

describe('CJK, inline markup inside a sentence', () => {
  it('redistributes a Japanese reply that has no spaces between chunks', () => {
    document.body.innerHTML = '<p>Only <b>signed-in</b> users can post</p>'
    const unit = serializeBlock(document.body.firstElementChild as Element, filter) as BlockUnit

    // Japanese word order differs and there are no spaces to lean on.
    const result = redistribute(unit, '<0>ログイン済み</0>のユーザーのみ投稿できます') as Map<
      Text,
      string
    >

    expect(result.get(unit.nodes[1] as Text)).toBe('ログイン済み')
    expect(result.get(unit.nodes[2] as Text)).toBe('のユーザーのみ投稿できます')
    expect(document.querySelector('b')).not.toBeNull()
  })

  it('keeps a Japanese source sentence intact through a block', () => {
    document.body.innerHTML = '<p>ログイン<b>済み</b>のユーザーのみ</p>'
    const unit = serializeBlock(document.body.firstElementChild as Element, filter) as BlockUnit

    expect(unit.source).toBe('ログイン<0>済み</0>のユーザーのみ')
    expect(unit.sources).toEqual(['ログイン', '済み', 'のユーザーのみ'])
  })

  it('does not invent a space between Japanese chunks', () => {
    document.body.innerHTML = '<p><span>日本語</span><span>のページ</span></p>'
    const unit = serializeBlock(document.body.firstElementChild as Element, filter) as BlockUnit

    // No whitespace text node between the spans, so none appears in the source.
    expect(unit.source).toBe('<0>日本語</0><1>のページ</1>')
  })
})

describe('CJK, end to end', () => {
  async function translateTo(lang: string, html: string, render: (t: string) => string) {
    document.body.innerHTML = html
    const calls: string[][] = []
    const provider = custom(async (texts) => {
      calls.push([...texts])
      return texts.map(render)
    })

    const instance = await weave({
      to: lang,
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })
    live = instance
    await instance.whenIdle()
    await settle()
    return { instance, calls }
  }

  it('translates a page into Japanese', async () => {
    const dictionary: Record<string, string> = {
      Welcome: 'ようこそ',
      'Search products': '商品を検索',
      Spain: 'スペイン',
      'Sign out': 'ログアウト',
    }

    const { instance } = await translateTo(
      'ja',
      `<h1>Welcome</h1>
       <input placeholder="Search products">
       <select><option>Spain</option></select>
       <ul style="display:none"><li>Sign out</li></ul>`,
      (t) => dictionary[t] ?? t,
    )

    expect(document.querySelector('h1')?.textContent).toBe('ようこそ')
    expect(document.querySelector('input')?.placeholder).toBe('商品を検索')
    expect(document.querySelector('option')?.textContent).toBe('スペイン')
    expect(document.querySelector('li')?.textContent).toBe('ログアウト')
    expect(document.documentElement.lang).toBe('ja')
    expect(document.documentElement.dir).toBe('ltr')
    expect(instance.stats().errors).toBe(0)
  })

  it('translates a page into Korean', async () => {
    const dictionary: Record<string, string> = {
      Welcome: '환영합니다',
      'Search products': '제품 검색',
      'Close dialog': '대화 상자 닫기',
    }

    await translateTo(
      'ko',
      `<h1>Welcome</h1>
       <input placeholder="Search products">
       <button aria-label="Close dialog"></button>`,
      (t) => dictionary[t] ?? t,
    )

    expect(document.querySelector('h1')?.textContent).toBe('환영합니다')
    expect(document.querySelector('input')?.placeholder).toBe('제품 검색')
    expect(document.querySelector('button')?.getAttribute('aria-label')).toBe('대화 상자 닫기')
    expect(document.documentElement.lang).toBe('ko')
  })

  it('keeps whitespace shape when writing Japanese into an indented node', async () => {
    await translateTo('ja', '<p>\n      Read more\n    </p>', () => '続きを読む')

    // The indentation is preserved around the translation rather than collapsed,
    // which is what stops adjacent inline text from jamming together.
    expect((document.querySelector('p') as HTMLElement).firstChild?.nodeValue).toBe(
      '\n      続きを読む\n    ',
    )
  })

  it('survives a re-render in Japanese without paying again', async () => {
    const { instance, calls } = await translateTo('ja', '<h1>Welcome</h1>', () => 'ようこそ')
    expect(calls).toHaveLength(1)

    const node = (document.querySelector('h1') as HTMLElement).firstChild as Text
    node.nodeValue = 'Welcome'
    await settle()
    await instance.whenIdle()

    expect(document.querySelector('h1')?.textContent).toBe('ようこそ')
    expect(calls).toHaveLength(1)
  })

  it('translates a Japanese sentence with inline markup end to end', async () => {
    await translateTo('ja', '<p>Only <b>signed-in</b> users can post</p>', (text) =>
      text === 'Only <0>signed-in</0> users can post'
        ? '<0>ログイン済み</0>のユーザーのみ投稿できます'
        : text,
    )

    expect(document.querySelector('p')?.textContent).toBe('ログイン済みのユーザーのみ投稿できます')
    expect(document.querySelector('b')?.textContent).toBe('ログイン済み')
  })

  it('handles a Japanese source page translated into English', async () => {
    document.documentElement.lang = 'ja'
    const dictionary: Record<string, string> = {
      ようこそ: 'Welcome',
      商品を検索: 'Search products',
    }

    document.body.innerHTML = '<h1>ようこそ</h1><input placeholder="商品を検索">'
    const provider = custom(async (texts) => texts.map((t) => dictionary[t] ?? t))

    const instance = await weave({
      to: 'en',
      from: 'auto',
      providers: [provider],
      cache: 'memory',
    })
    live = instance
    await instance.whenIdle()

    expect(instance.sourceLanguage).toBe('ja')
    expect(document.querySelector('h1')?.textContent).toBe('Welcome')
    expect(document.querySelector('input')?.placeholder).toBe('Search products')
  })

  it('switches ja to ko on a sentence block without corrupting it', async () => {
    // The bug this covers was only visible in the browser: after Japanese moved
    // the placeholder to the front, switching to Korean re-scanned a block whose
    // spaces had been eaten by restore(), so the source no longer matched and
    // the sentence silently degraded to per-node translation.
    document.body.innerHTML = '<p>Only <b>signed-in</b> users can post a review.</p>'
    const BLOCK = 'Only <0>signed-in</0> users can post a review.'
    const table: Record<string, Record<string, string>> = {
      ja: { [BLOCK]: '<0>ログイン済み</0>のユーザーのみレビューを投稿できます。' },
      ko: { [BLOCK]: '<0>로그인한</0> 사용자만 리뷰를 작성할 수 있습니다.' },
    }

    const seen: string[] = []
    const provider = custom(async (texts, _from, to) => {
      seen.push(...texts)
      return texts.map((t) => table[to]?.[t] ?? `MISS(${t})`)
    })

    const instance = await weave({
      to: 'ja',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })
    live = instance
    await instance.whenIdle()
    expect(document.querySelector('p')?.textContent).toBe(
      'ログイン済みのユーザーのみレビューを投稿できます。',
    )

    await instance.setLanguage('ko')
    await instance.whenIdle()

    expect(document.querySelector('p')?.textContent).toBe(
      '로그인한 사용자만 리뷰를 작성할 수 있습니다.',
    )
    expect(document.querySelector('b')?.textContent).toBe('로그인한')
    // Both passes asked for the same intact sentence, no drift, no fallback.
    expect(seen).toEqual([BLOCK, BLOCK])
  })

  it('switches between Japanese and Korean reusing the cache', async () => {
    const byLang: Record<string, string> = { ja: 'ようこそ', ko: '환영합니다' }
    document.body.innerHTML = '<h1>Welcome</h1>'

    let target = 'ja'
    const calls: string[][] = []
    const provider = custom(async (texts, _from, to) => {
      calls.push([...texts])
      target = to
      return texts.map(() => byLang[to] ?? '?')
    })

    const instance = await weave({
      to: 'ja',
      from: 'en',
      providers: [provider],
      cache: 'memory',
    })
    live = instance
    await instance.whenIdle()
    expect(document.querySelector('h1')?.textContent).toBe('ようこそ')

    await instance.setLanguage('ko')
    await instance.whenIdle()
    expect(document.querySelector('h1')?.textContent).toBe('환영합니다')
    expect(target).toBe('ko')

    // Back to Japanese: already known, so no third request.
    const before = calls.length
    await instance.setLanguage('ja')
    await instance.whenIdle()
    expect(document.querySelector('h1')?.textContent).toBe('ようこそ')
    expect(calls).toHaveLength(before)
  })
})

describe('CJK, text node scanning edge cases', () => {
  it('treats a lone Japanese character as translatable', () => {
    document.body.innerHTML = '<span>円</span>'
    const units = scan(document.body, filter).units as TextUnit[]
    expect(units[0]?.source).toBe('円')
  })

  it('skips a node holding only a Japanese currency amount', () => {
    document.body.innerHTML = '<span>￥1,200</span><span>税込</span>'
    const sources = scan(document.body, filter).units.map((u) => u.source)
    expect(sources).toEqual(['税込'])
  })

  it('keeps mixed Latin and Japanese together', () => {
    document.body.innerHTML = '<p>iPhone の在庫</p>'
    const sources = scan(document.body, filter).units.map((u) => u.source)
    expect(sources).toEqual(['iPhone の在庫'])
  })
})

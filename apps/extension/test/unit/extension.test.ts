// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { htmlToText } from '@supertext-review/shared'
import { MAX_TEXTS_PER_REQUEST, ReviewApi, ReviewApiError } from '../../src/lib/api'
import { collectBlocks, collectInvisible, OWN_UI } from '../../src/lib/collect'
import { parseReviewLink } from '../../src/lib/link'
import { counterpart, sideOf, startUrl } from '../../src/lib/urls'

const TOKEN = '12.' + 'A'.repeat(43)

describe('review links', () => {
  it('parses the proxy origin and token', () => {
    expect(parseReviewLink(` https://review.example.com/review#${TOKEN} `)).toEqual({ proxy: 'https://review.example.com', token: TOKEN })
    expect(parseReviewLink(`http://localhost:3000/review/#${TOKEN}`)).toEqual({ proxy: 'http://localhost:3000', token: TOKEN })
  })
  it('refuses anything else', () => {
    for (const bad of [`http://review.example.com/review#${TOKEN}`, `https://x.example/other#${TOKEN}`, 'https://x.example/review#nope', 'not a url', `javascript:alert(1)//review#${TOKEN}`]) {
      expect(parseReviewLink(bad)).toBeNull()
    }
  })
})

describe('language versions by path prefix', () => {
  const site = { origin: 'https://www.kunde.ch', sourcePrefix: '/de/', targetPrefix: '/fr/' }
  it('knows the side of a URL', () => {
    expect(sideOf('https://www.kunde.ch/de/produkte?x=1', site)).toBe('source')
    expect(sideOf('https://www.kunde.ch/fr', site)).toBe('translation')
    expect(sideOf('https://www.kunde.ch/it/', site)).toBeNull()
    expect(sideOf('https://evil.example/fr/', site)).toBeNull()
  })
  it('swaps the prefix, keeping path, query and hash', () => {
    expect(counterpart('https://www.kunde.ch/de/produkte/a?x=1#y', site)).toEqual({ side: 'translation', url: 'https://www.kunde.ch/fr/produkte/a?x=1#y' })
    expect(counterpart('https://www.kunde.ch/fr', site)).toEqual({ side: 'source', url: 'https://www.kunde.ch/de/' })
    expect(counterpart('https://www.kunde.ch/de/', { ...site, targetPrefix: null })).toBeNull()
    expect(startUrl(site, 'translation')).toBe('https://www.kunde.ch/fr/')
  })
  it('handles a root source prefix', () => {
    const root = { origin: 'https://a.example', sourcePrefix: '/', targetPrefix: '/en/' }
    expect(sideOf('https://a.example/en/x', root)).toBe('translation')
    expect(sideOf('https://a.example/x', root)).toBe('source')
    expect(counterpart('https://a.example/x', root)?.url).toBe('https://a.example/en/x')
  })
})

describe('reading the page', () => {
  it('reads each block like the proxy stores segments', () => {
    // What a plugin sent and Supertext answered:
    const ai = 'Lesen Sie zuerst <a href="https://example.ch/guide">die Anleitung</a>.'
    document.body.innerHTML = `
      <header><nav><a href="/">Start</a> <a href="/kontakt">Kontakt</a></nav></header>
      <main>
        <h1>Willkommen   im&nbsp;Shop</h1>
        <p>${ai}</p>
        <div>Intro <p>Absatz darin</p></div>
        <ul><li>Erstens<br>zweite Zeile</li></ul>
        <script>var x = "nicht lesen"</script>
        <div ${OWN_UI}>Eigene Oberfläche</div>
      </main>`
    const texts = collectBlocks(document).map((b) => b.text)
    expect(texts).toContain(htmlToText(ai))
    expect(texts).toContain('Willkommen im Shop')
    expect(texts).toContain('Intro')
    expect(texts).toContain('Absatz darin')
    expect(texts).toContain('Erstens zweite Zeile')
    expect(texts).toContain('Start Kontakt')
    expect(texts.join(' ')).not.toContain('nicht lesen')
    expect(texts.join(' ')).not.toContain('Eigene')
  })

  it('reads invisible texts: title, meta, attributes, JSON-LD', () => {
    document.head.innerHTML = `
      <title>Hotel  Alpenblick</title>
      <meta name="description" content="Ferien in den Bergen">
      <meta property="og:title" content="Alpenblick">
      <meta name="viewport" content="width=device-width">
      <script type="application/ld+json">{"@type":"Hotel","name":"Hotel Alpenblick","address":{"description":"Am See"},"url":"https://x"}</script>`
    document.body.innerHTML = `<img src="a.png" alt="Blick auf den See"><input placeholder="Suchen"><input type="submit" value="Senden"><a title="Mehr erfahren" aria-label="Mehr">x</a>`
    const found = collectInvisible(document).map((x) => `${x.where}: ${x.text}`)
    expect(found).toEqual(expect.arrayContaining([
      '<title>: Hotel Alpenblick',
      'meta description: Ferien in den Bergen',
      'meta og:title: Alpenblick',
      'img alt: Blick auf den See',
      'placeholder: Suchen',
      'button value: Senden',
      'title: Mehr erfahren',
      'aria-label: Mehr',
      'JSON-LD name: Hotel Alpenblick',
      'JSON-LD description: Am See',
    ]))
    expect(found.join('|')).not.toContain('width=device-width')
    expect(found.join('|')).not.toContain('https://x')
  })
})

describe('review API client', () => {
  it('sends the token, chunks large matches and keeps the order', async () => {
    const calls: { url: string; body: { texts: { text: string }[] }; auth: string }[] = []
    const fake = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      calls.push({ url, body, auth: (init?.headers as Record<string, string>).Authorization ?? "" })
      return new Response(JSON.stringify({ results: body.texts.map((t: { text: string }, index: number) => ({ index, segments: t.text === 'hit' ? [{ id: 1 }] : [] })) }))
    }
    const api = new ReviewApi({ proxy: 'https://p.example', token: TOKEN }, fake)
    const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST + 5 }, (_, i) => (i === MAX_TEXTS_PER_REQUEST + 2 ? 'hit' : `t${i}`))
    const r = await api.match('translation', texts)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://p.example/api/review/match')
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(r[MAX_TEXTS_PER_REQUEST + 2]).toEqual([{ id: 1 }])
    expect(r[0]).toEqual([])
  })

  it('turns error answers into codes', async () => {
    const api = new ReviewApi({ proxy: 'https://p.example', token: TOKEN }, async () => new Response('{"error":"link_expired"}', { status: 401 }))
    await expect(api.session()).rejects.toMatchObject({ code: 'link_expired', status: 401 })
    const down = new ReviewApi({ proxy: 'https://p.example', token: TOKEN }, async () => {
      throw new TypeError('offline')
    })
    await expect(down.session()).rejects.toBeInstanceOf(ReviewApiError)
  })
})

describe('UI languages', () => {
  // Paths, not URLs: happy-dom replaces the global URL, which node:fs doesn't take.
  const root = path.resolve(__dirname, '../..')
  const dir = path.join(root, 'static/_locales')
  const load = (l: string) => JSON.parse(readFileSync(path.join(dir, l, 'messages.json'), 'utf8')) as Record<string, { message: string; placeholders?: object }>
  const en = load('en')
  const langs = readdirSync(dir)

  it('has English, German, French and Italian', () => {
    expect(langs.sort()).toEqual(['de', 'en', 'fr', 'it'])
  })

  for (const l of ['de', 'fr', 'it']) {
    it(`${l} has the same keys, placeholders and URLs as English`, () => {
      const m = load(l)
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort())
      for (const [k, v] of Object.entries(en)) {
        const ph = (s: string) => (s.match(/\$[A-Z_]+\$/g) ?? []).sort()
        const urls = (s: string) => (s.match(/https?:\/\/\S+/g) ?? []).sort()
        expect(ph(m[k]!.message), k).toEqual(ph(v.message))
        expect(urls(m[k]!.message), k).toEqual(urls(v.message))
        expect(m[k]!.placeholders, k).toEqual(v.placeholders)
        expect(m[k]!.message.includes('Supertext'), k).toBe(v.message.includes('Supertext'))
      }
    })
  }

  it('every message the code uses exists', () => {
    const src = ['panel.ts'].map((f) => readFileSync(path.join(root, 'src', f), 'utf8')).join('\n')
    const used = [...src.matchAll(/\bt\('([A-Za-z]+)'/g)].map((m) => m[1]!)
    for (const key of used) expect(en[key], key).toBeDefined()
    const manifest = readFileSync(path.join(root, 'static/manifest.json'), 'utf8')
    for (const m of manifest.matchAll(/__MSG_([A-Za-z]+)__/g)) expect(en[m[1]!], m[1]).toBeDefined()
  })
})

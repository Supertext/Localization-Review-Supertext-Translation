// End to end: the built extension (npm run test:e2e builds it with --e2e) in Chromium, against
// the proxy's route handlers behind a local HTTP server, the Supertext stand-in and a two-language
// test site. Needs Postgres (TEST_DATABASE_URL, default postgres://postgres:postgres@127.0.0.1:5432/postgres)
// and Playwright's Chromium. Saves screenshots for the user guide in docs/images/ with SCREENSHOTS=1.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JavaScript (vendored from Supertext-API-SDK-and-Guide)
import { createStandIn } from '../../../proxy/test/stand-in/stand-in.mjs'
import { SupertextClient } from '../../../proxy/test/sdk/v1/index'

const here = path.dirname(fileURLToPath(import.meta.url))
const proxyDir = path.resolve(here, '../../../proxy')
const dist = path.resolve(here, '../../dist')
const docs = path.resolve(here, '../../../../docs/images')
const SERVER = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
const DB = 'review_test_extension'
const KEY = 'e2e-key-hotel-alpenblick'

let sql: postgres.Sql
let standIn: http.Server
let proxy: http.Server
let site: http.Server
let proxyUrl = ''
let siteUrl = ''
let link = ''
let context: BrowserContext
let panel: Page
let extensionId = ''

const listen = (server: http.Server) => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))

/** Serves the route handlers the extension and the plugins use. */
async function proxyServer(): Promise<http.Server> {
  const session = await import('../../../proxy/src/app/api/review/session/route')
  const match = await import('../../../proxy/src/app/api/review/match/route')
  const segment = await import('../../../proxy/src/app/api/review/segments/[id]/route')
  const approve = await import('../../../proxy/src/app/api/review/segments/[id]/approve/route')
  const comment = await import('../../../proxy/src/app/api/review/segments/[id]/comment/route')
  const file = await import('../../../proxy/src/app/v1/translate/ai/file/route')
  const one = await import('../../../proxy/src/app/v1/translate/ai/file/[id]/route')
  const status = await import('../../../proxy/src/app/v1/translate/ai/file/[id]/status/route')
  const translation = await import('../../../proxy/src/app/v1/translate/ai/file/[id]/translation/route')
  const features = await import('../../../proxy/src/app/v1/features/route')
  const params = (id: string) => ({ params: Promise.resolve({ id }) })
  const route = async (req: Request): Promise<Response> => {
    const p = new URL(req.url).pathname
    const m = req.method
    let x: RegExpMatchArray | null
    if (m === 'OPTIONS') return session.OPTIONS()
    if (p === '/v1/features') return features.GET(req)
    if (p === '/v1/translate/ai/file' && m === 'POST') return file.POST(req)
    if ((x = p.match(/^\/v1\/translate\/ai\/file\/([^/]+)\/status$/))) return status.GET(req, params(x[1]!))
    if ((x = p.match(/^\/v1\/translate\/ai\/file\/([^/]+)\/translation$/))) return translation.GET(req, params(x[1]!))
    if ((x = p.match(/^\/v1\/translate\/ai\/file\/([^/]+)$/)) && m === 'DELETE') return one.DELETE(req, params(x[1]!))
    if (p === '/api/review/session') return session.GET(req)
    if (p === '/api/review/match') return match.POST(req)
    if ((x = p.match(/^\/api\/review\/segments\/(\d+)$/))) return m === 'PUT' ? segment.PUT(req, params(x[1]!)) : segment.GET(req, params(x[1]!))
    if ((x = p.match(/^\/api\/review\/segments\/(\d+)\/approve$/))) return approve.POST(req, params(x[1]!))
    if ((x = p.match(/^\/api\/review\/segments\/(\d+)\/comment$/))) return comment.POST(req, params(x[1]!))
    return new Response('not found', { status: 404 })
  }
  return http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined
    const out = await route(new Request(`${proxyUrl}${req.url}`, { method: req.method, headers, body }))
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()))
    res.end(Buffer.from(await out.arrayBuffer()))
  })
}

function siteServer(): http.Server {
  return http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname
    const m = p.match(/^\/(en|de)\/?$/)
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/html' })
      return res.end('<!doctype html><title>404</title><p>Not found</p>')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(readFileSync(path.join(here, 'site', m[1]!, 'index.html')))
  })
}

async function seed(): Promise<void> {
  const client = new SupertextClient(KEY, { baseUrl: `${proxyUrl}/v1/`, pollIntervalMs: 0, userAgent: 'Typo3-Supertext-Translation/0.6.0' })
  await client.translateTexts(
    {
      title: 'Welcome to Hotel Alpenblick',
      intro: 'Book your room directly and get breakfast for free.',
      directions: { text: 'Read <a href="/en/directions">how to get here</a> by train or car.', html: true },
      checkin: 'Check-in from 3 pm, check-out until 11 am.',
      description: 'Holidays in the mountains, right by the lake',
    },
    'de-CH',
    { sourceLang: 'en' },
  )
  const { fingerprint } = await import('../../../proxy/src/lib/tenant')
  const store = await import('../../../proxy/src/lib/admin-store')
  const links = await import('../../../proxy/src/lib/review-links')
  const siteId = await store.createSite({ tenant: fingerprint(KEY), name: 'Hotel Alpenblick', origin: siteUrl, sourceLang: 'en', sourcePrefix: '/en/', targetPrefixes: { 'de-CH': '/de/' } })
  link = `${proxyUrl}/review#${links.tokenFor(await links.createLink(siteId, 'de-CH', 'customer', 'E2E', 30))}`
}

const tabByUrl = (url: string) => context.pages().find((p) => p.url().startsWith(url))

beforeAll(async () => {
  const admin = postgres(SERVER, { max: 1, onnotice: () => {} })
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
  await admin.end()
  process.env.DATABASE_URL = SERVER
  process.env.REVIEW_DB_NAME = DB
  execFileSync('node', ['scripts/migrate.mjs'], { cwd: proxyDir, env: process.env, stdio: 'pipe' })
  sql = postgres(`${SERVER.replace(/\/[^/]*$/, '')}/${DB}`, { max: 1, onnotice: () => {} })

  standIn = createStandIn({ samplesDir: path.join(here, 'samples') })
  process.env.SUPERTEXT_API_URL = `${await listen(standIn)}/v1/`
  proxy = await proxyServer()
  proxyUrl = await listen(proxy)
  site = siteServer()
  // localhost, not 127.0.0.1: the site and the proxy then have different origins, as in real life.
  siteUrl = (await listen(site)).replace('127.0.0.1', 'localhost')
  await seed()

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=de-CH', '--accept-lang=de-CH,de'],
    // Chromium on Linux takes its UI language (which chrome.i18n follows) from the environment.
    env: { ...process.env, LANGUAGE: 'de_CH:de', LANG: 'de_CH.UTF-8' },
    locale: 'de-CH',
  })
  let worker = context.serviceWorkers()[0]
  worker ??= await context.waitForEvent('serviceworker')
  extensionId = new URL(worker.url()).host

  // The reviewer has the translated page open; the panel works on that window.
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(`${siteUrl}/de/`)
  const windowId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/de/` }))[0]!.windowId, siteUrl)
  panel = await context.newPage()
  await panel.setViewportSize({ width: 400, height: 900 })
  await panel.goto(`chrome-extension://${extensionId}/panel.html?window=${windowId}`)
  // The panel page lives in the same window; the site's tab must stay the active one.
  await page.bringToFront()
})

afterAll(async () => {
  await context?.close()
  for (const s of [standIn, proxy, site]) await new Promise<void>((r) => (s ? s.close(() => r()) : r()))
  await sql?.end()
  const { db } = await import('../../../proxy/src/lib/db')
  await db().end()
})

describe('reviewing with the extension', () => {
  it('connects with a review link (UI in the browser language)', async () => {
    await panel.fill('#link', 'https://nope.example/other')
    await panel.click('button.primary')
    await expect.poll(() => panel.textContent('[role=alert]')).toContain('kein Prüflink')
    await panel.fill('#link', link)
    await panel.click('button.primary')
    await panel.waitForSelector('dl.facts')
    expect(await panel.textContent('dl.facts')).toContain('Hotel Alpenblick')
    expect(await panel.textContent('dl.facts')).toContain('en → de-CH')
    await panel.fill('#reviewer', 'Erika Muster')
    await panel.dispatchEvent('#reviewer', 'change')
  })

  it('opens the original beside the translation and matches both', async () => {
    await panel.click('text=Nebeneinander öffnen')
    await expect.poll(() => tabByUrl(`${siteUrl}/en/`)?.url() ?? '', { timeout: 20_000 }).toContain('/en/')
    await expect.poll(async () => (await panel.textContent('.tabs')) ?? '', { timeout: 20_000 }).toContain('Auf dieser Seite (4)')
    const de = tabByUrl(`${siteUrl}/de/`)!
    const en = tabByUrl(`${siteUrl}/en/`)!
    // The translated page marks matched, untranslated and other texts; the original only the matched ones.
    await expect.poll(() => de.evaluate(() => document.querySelector('h1')?.getAttribute('data-st-review'))).toBe('ai')
    expect(await de.evaluate(() => [...document.querySelectorAll('p')].at(-1)?.getAttribute('data-st-review'))).toBe('untranslated')
    expect(await de.evaluate(() => document.querySelector('nav')?.getAttribute('data-st-review'))).toBe('unmatched')
    const ids = await de.evaluate(() => document.querySelector('h1')?.getAttribute('data-st-review-seg'))
    expect(await en.evaluate(() => document.querySelector('h1')?.getAttribute('data-st-review-seg'))).toBe(ids)
    expect(await en.evaluate(() => document.querySelector('nav')?.hasAttribute('data-st-review'))).toBe(false)
    const split = await context.serviceWorkers()[0]!.evaluate(async () => (await chrome.tabs.query({})).map((t) => (t as { splitViewId?: number }).splitViewId ?? -1))
    console.log(`split view: ${split.some((s) => s >= 0) ? 'opened by the extension' : 'not available, hint shown'}`)
    // Chromium with the Split View API puts the two side by side; older builds show the shortcut hint.
    if (!split.some((s) => s >= 0)) expect(await panel.textContent('main')).toContain('Umschalt+Alt+N')
  })

  it('lists texts that weren’t matched, with the likely reason, and invisible texts', async () => {
    await panel.click('.tabs button:nth-child(2)')
    const unmatched = (await panel.textContent('.list')) ?? ''
    expect(unmatched).toContain('Check-in from 3 pm')
    expect(unmatched).toContain('Nicht übersetzt')
    expect(unmatched).toContain('Home · Rooms · Contact')
    if (process.env.SCREENSHOTS) await panel.screenshot({ path: path.join(docs, 'extension-unmatched.png') })
    await panel.click('.tabs button:nth-child(3)')
    const invisible = (await panel.textContent('.list')) ?? ''
    expect(invisible).toContain('meta description')
    expect(invisible).toContain('Ferien in den Bergen, direkt am See')
    expect(await panel.locator('.list button.item').count()).toBeGreaterThan(0) // the description is a known segment
    await panel.click('.tabs button:nth-child(1)')
    if (process.env.SCREENSHOTS) await panel.screenshot({ path: path.join(docs, 'extension-list.png') })
  })

  it('corrects a text from the list', async () => {
    await panel.click('.list button.item:has-text("Willkommen im Hotel Alpenblick")')
    await panel.waitForSelector('#translation')
    expect(await panel.textContent('.source')).toBe('Welcome to Hotel Alpenblick')
    await panel.fill('#translation', 'Herzlich willkommen im Hotel Alpenblick')
    await panel.fill('#comment', 'Etwas herzlicher')
    await panel.click('text=Korrektur speichern')
    await expect.poll(() => panel.textContent('[role=status]')).toContain('Gespeichert')
    expect(await panel.textContent('.history')).toContain('Korrektur von Erika Muster')
    const [row] = await sql`SELECT correction_html, status FROM segments WHERE source_html = 'Welcome to Hotel Alpenblick'`
    expect(row).toMatchObject({ correction_html: 'Herzlich willkommen im Hotel Alpenblick', status: 'corrected' })
    const de = tabByUrl(`${siteUrl}/de/`)!
    await expect.poll(() => de.evaluate(() => document.querySelector('h1')?.getAttribute('data-st-review'))).toBe('corrected')
    if (process.env.SCREENSHOTS) await panel.screenshot({ path: path.join(docs, 'extension-detail.png') })
    await panel.click('button.link:has-text("Zurück")')
  })

  it('selects a text by clicking it on the page, and refuses changed links', async () => {
    const de = tabByUrl(`${siteUrl}/de/`)!
    await de.bringToFront()
    // Review mode: the click selects the paragraph instead of following its link.
    await de.click('p a')
    expect(de.url()).toBe(`${siteUrl}/de/`)
    await panel.waitForSelector('#translation')
    expect(await panel.textContent('.source')).toContain('how to get here')
    expect(await panel.inputValue('#translation')).toContain('<a href="/de/directions">')
    if (process.env.SCREENSHOTS) await de.screenshot({ path: path.join(docs, 'extension-page.png'), clip: { x: 0, y: 0, width: 1280, height: 420 } })
    await panel.fill('#translation', 'Lesen Sie, <a href="https://evil.example">wie Sie zu uns kommen</a>.')
    await panel.click('text=Korrektur speichern')
    await expect.poll(() => panel.textContent('[role=alert]')).toContain('Formatierung oder Links')
    // The AI answer's own link (/de/…) is allowed.
    await panel.fill('#translation', 'So kommen Sie <a href="/de/directions">zu uns</a>: mit dem Zug oder dem Auto.')
    await panel.click('text=Korrektur speichern')
    await expect.poll(() => panel.textContent('[role=status]')).toContain('Gespeichert')
  })

  it('serves the corrections on the plugin’s next request', async () => {
    const client = new SupertextClient(KEY, { baseUrl: `${proxyUrl}/v1/`, pollIntervalMs: 0 })
    const out = await client.translateTexts(
      { title: 'Welcome to Hotel Alpenblick', directions: { text: 'Read <a href="/en/directions">how to get here</a> by train or car.', html: true } },
      'de-CH',
      { sourceLang: 'en' },
    )
    expect(out).toEqual({ title: 'Herzlich willkommen im Hotel Alpenblick', directions: 'So kommen Sie <a href="/de/directions">zu uns</a>: mit dem Zug oder dem Auto.' })
  })
})

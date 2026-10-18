// Takes the screenshots in docs/images/ from a running proxy with an empty database.
//
//   1. Start the Supertext stand-in with the docs samples:
//        PORT=8765 STAND_IN_SAMPLES=apps/proxy/scripts/docs-samples node apps/proxy/test/stand-in/stand-in.mjs
//   2. Start the proxy against a fresh database and the stand-in:
//        SUPERTEXT_API_URL=http://127.0.0.1:8765/v1/ REVIEW_DB_NAME=review_docs \
//        REVIEW_ADMIN_PASSWORD=… REVIEW_LINK_SECRET=… npm run dev
//   3. REVIEW_URL=http://127.0.0.1:3000 REVIEW_ADMIN_PASSWORD=… npm run docs:screenshots --workspace apps/proxy
//
// It translates an invented hotel website through the proxy (no customer data), labels the
// tenant, creates a review site and link through the UI, corrects one text through the review
// API and saves cropped 1× PNGs. The pages show the proxy's own address; set REVIEW_PUBLIC_URL
// on the proxy to show the production one instead.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = (process.env.REVIEW_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const PASSWORD = process.env.REVIEW_ADMIN_PASSWORD;
if (!PASSWORD) throw new Error('Set REVIEW_ADMIN_PASSWORD (the one the proxy runs with).');
const OUT = new URL('../../../docs/images/', import.meta.url);

const KEY = 'docs-key-hotel-alpenblick';
const UA = 'supertext-sdk-php/0.5.0 Typo3-Supertext-Translation/0.6.0';

/** Translates texts through the proxy the way the plugins do (SDK document, poll, download, delete). */
async function translate(texts, target, { html = false } = {}) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const doc =
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n' +
    texts.map((t, i) => `<div data-st-id="${i}">${html ? t : esc(t)}</div>\n`).join('') +
    '</body></html>\n';
  const headers = { Authorization: `Supertext-Auth-Key ${KEY}`, 'User-Agent': UA };
  const form = new FormData();
  form.set('target_lang', target);
  form.set('source_lang', 'en');
  form.set('file', new Blob([doc], { type: 'text/html' }), 'content.html');
  const up = await fetch(`${BASE}/v1/translate/ai/file`, { method: 'POST', headers, body: form });
  if (!up.ok) throw new Error(`upload: ${up.status} ${await up.text()}`);
  const { file_id: id } = await up.json();
  for (let i = 0; i < 20; i++) {
    const s = await (await fetch(`${BASE}/v1/translate/ai/file/${id}/status`, { headers })).json();
    if (s.status === 'done') break;
    if (s.status !== 'translating') throw new Error(`status ${s.status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const out = await (await fetch(`${BASE}/v1/translate/ai/file/${id}/translation`, { headers })).text();
  await fetch(`${BASE}/v1/translate/ai/file/${id}`, { method: 'DELETE', headers });
  return out;
}

await fetch(`${BASE}/v1/features`, { headers: { Authorization: `Supertext-Auth-Key ${KEY}`, 'User-Agent': UA } });

const PAGE = [
  'Welcome to Hotel Alpenblick',
  'Book your room directly and get breakfast for free.',
  'Our spa is open daily from 7 am to 9 pm.',
  'Free parking for hotel guests',
  'Check-in from 3 pm, check-out until 11 am.',
];
await translate(PAGE, 'de-CH');
await translate(['Read <a href="https://www.alpenblick.example.ch/en/directions">how to get here</a> by train or car.'], 'de-CH', { html: true });
await translate(PAGE.slice(0, 3), 'fr-CH');
// Repeat requests: answered from the memory.
await translate(PAGE.slice(0, 2), 'de-CH');

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const shot = async (name, locator) => {
  await (locator ?? page.locator('main')).screenshot({ path: new URL(name, OUT).pathname });
  console.log(`docs/images/${name}`);
};

await page.goto(`${BASE}/login`);
await page.fill('input[name=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(`${BASE}/`);

// Label the tenant.
await page.click('table a');
await page.fill('input[name=label]', 'Hotel Alpenblick (www.alpenblick.example.ch)');
await page.click('form button.primary');
await page.waitForLoadState('networkidle');
const tenantUrl = page.url();

// A review site and a link.
await page.goto(`${BASE}/sites`);
await page.selectOption('select[name=tenant]', { index: 1 });
await page.fill('input[name=name]', 'Hotel Alpenblick website');
await page.fill('input[name=origin]', 'https://www.alpenblick.example.ch');
await page.fill('input[name=source_lang]', 'en');
await page.fill('input[name=source_prefix]', '/en/');
await page.fill('textarea[name=target_prefixes]', 'de-CH /de/\nfr-CH /fr/');
await page.click('form button.primary');
await page.waitForURL(/\/sites\/\d+$/);
await page.fill('input[name=target_lang]', 'de-CH');
await page.selectOption('select[name=role]', 'customer');
await page.fill('input[name=label]', 'Marketing team');
await page.click('form:has(input[name=target_lang]) button.primary');
await page.waitForLoadState('networkidle');
await page.fill('input[name=target_lang]', 'de-CH');
await page.selectOption('select[name=role]', 'linguist');
await page.fill('input[name=label]', 'Supertext linguist');
await page.click('form:has(input[name=target_lang]) button.primary');
await page.waitForLoadState('networkidle');
const link = (await page.locator('td.url.mono').first().textContent()).trim();
const token = link.split('/review#')[1];

// A correction through the review API, as the extension sends it.
const api = (path, init = {}) =>
  fetch(`${BASE}/api/review/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
const match = await (await api('match', { method: 'POST', body: JSON.stringify({ side: 'translation', texts: [{ text: 'Kostenlose Parkplätze für Hotelgäste' }] }) })).json();
const id = match.results[0].segments[0].id;
await api(`segments/${id}`, { method: 'PUT', body: JSON.stringify({ text: 'Gratis Parkplätze für unsere Hotelgäste', reviewer: 'Marketing team', comment: 'Our wording' }) });
await page.reload();
await shot('site-links.png');

await page.goto(`${BASE}/`);
await shot('tenants.png');
await page.goto(tenantUrl);
await shot('tenant-memory.png');

await page.goto(`${BASE}/review#${token}`);
await page.waitForSelector('dl.facts');
await shot('review-link.png', page.locator('main .card'));

await browser.close();

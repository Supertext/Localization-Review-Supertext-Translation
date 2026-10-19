// Corrections for content the integration doesn't send again: segment locations recorded on
// download, pending corrections, acknowledgements. Needs Postgres (see proxy.test.ts);
// database review_test_corrections.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupertextClient } from '../sdk/v1/index';
import { createHash } from 'node:crypto';
import { SERVER, setUp, type Harness } from './helpers';

const fingerprintOf = (key: string) => createHash('sha256').update(key).digest('hex');

let h: Harness;
let sql: postgres.Sql;

const PLUGIN = 'Test-Supertext-Translation/1.2.0';
const client = (key = 'key-corr-a', userAgent = PLUGIN) =>
  new SupertextClient(key, { baseUrl: 'http://proxy.test/v1/', fetch: (i, init) => h.fetch(i, init), pollIntervalMs: 0, sleep: async () => {}, userAgent });

interface Correction {
  id: string;
  st_id: string;
  source_lang: string | null;
  target_lang: string;
  politeness: string;
  source_html: string;
  previous_html: string;
  html: string;
  status: string;
  corrected_at: string;
  version: string;
}

const call = (path: string, init: RequestInit & { key?: string; ua?: string } = {}) =>
  h.fetch(`http://proxy.test/v1/review/corrections${path}`, {
    ...init,
    headers: {
      Authorization: `Supertext-Auth-Key ${init.key ?? 'key-corr-a'}`,
      'User-Agent': `supertext-sdk-typescript/0.0.0 ${init.ua ?? PLUGIN}`,
      'Content-Type': 'application/json',
    },
  });

async function pending(query = '', opts: { key?: string; ua?: string } = {}): Promise<{ corrections: Correction[]; next_after: string | null }> {
  const res = await call(query, opts);
  expect(res.status).toBe(200);
  return res.json();
}

const acknowledge = async (items: { id: string; version: string }[], opts: { key?: string; ua?: string } = {}) =>
  (await (await call('/acknowledge', { ...opts, method: 'POST', body: JSON.stringify({ corrections: items }) })).json()) as { acknowledged: number };

/** Translates like a plugin with its own data-st-id values (e.g. Contao's "tl_content.1.text"). */
async function translate(texts: Record<string, string>, key = 'key-corr-a', userAgent = PLUGIN): Promise<Record<string, string>> {
  const html = Object.entries(texts).map(([id, text]) => `<div data-st-id="${id}">${text}</div>`).join('\n');
  const out = await client(key, userAgent).translateHtml(`<!DOCTYPE html><html><body>${html}</body></html>`, 'de-CH', { sourceLang: 'en' });
  return Object.fromEntries([...out.matchAll(/<div data-st-id="([^"]+)">(.*?)<\/div>/g)].map((m) => [m[1]!, m[2]!]));
}

async function correct(sourceText: string, html: string, tenantKey = 'key-corr-a'): Promise<void> {
  const rows = await sql`
    UPDATE segments SET correction_html = ${html}, status = 'corrected', updated_at = now()
    WHERE source_text = ${sourceText} AND target_lang = 'de-CH' AND tenant = ${fingerprintOf(tenantKey)} RETURNING id`;
  expect(rows.length).toBeGreaterThan(0);
}

beforeAll(async () => {
  h = await setUp('review_test_corrections');
  sql = postgres(`${SERVER.replace(/\/[^/]*$/, '')}/review_test_corrections`, { max: 1, onnotice: () => {} });
  await translate({ 'tl_content.1.text': 'Welcome to our shop', 'tl_content.2.text': 'Free shipping from CHF 50' });
  // Same texts, another plugin and another key: separate locations.
  await translate({ 'node.7.title': 'Welcome to our shop' }, 'key-corr-a', 'Other-Supertext-Translation/2.0.0');
  await translate({ 'tl_content.1.text': 'Welcome to our shop' }, 'key-corr-b');
});

afterAll(async () => {
  await sql?.end();
  await h?.close();
});

describe('pending corrections', () => {
  it('records where each segment sits and has nothing pending after a download', async () => {
    const rows = await sql`SELECT plugin, st_id FROM segment_locations ORDER BY plugin, st_id`;
    expect(rows.map((r) => `${r.plugin} ${r.st_id}`)).toEqual([
      'Other-Supertext-Translation node.7.title',
      'Test-Supertext-Translation tl_content.1.text',
      'Test-Supertext-Translation tl_content.1.text',
      'Test-Supertext-Translation tl_content.2.text',
    ]);
    expect((await pending()).corrections).toEqual([]);
  });

  it('lists a correction for every place the text sits, for the plugin and key that sent it', async () => {
    const [ai] = await sql`SELECT ai_html FROM segments WHERE source_text = 'Welcome to our shop' AND tenant = ${fingerprintOf('key-corr-a')}`;
    await correct('Welcome to our shop', 'Herzlich willkommen in unserem Shop');
    const page = await pending();
    expect(page.corrections).toHaveLength(1);
    expect(page.corrections[0]).toMatchObject({
      st_id: 'tl_content.1.text',
      source_lang: 'en',
      target_lang: 'de-CH',
      politeness: 'default',
      source_html: 'Welcome to our shop',
      // What the plugin received with its download: the AI translation.
      previous_html: ai!.ai_html,
      html: 'Herzlich willkommen in unserem Shop',
      status: 'corrected',
    });
    expect(page.corrections[0]!.version).toMatch(/^[0-9a-f]{16}$/);
    expect(page.next_after).toBeNull();
    expect((await pending('', { ua: 'Other-Supertext-Translation/2.1.0' })).corrections.map((c) => c.st_id)).toEqual(['node.7.title']);
    // Key B's memory is its own: its segment wasn't corrected.
    expect((await pending('', { key: 'key-corr-b' })).corrections).toEqual([]);
    expect((await pending('?target_lang=fr-CH')).corrections).toEqual([]);
    expect((await pending('?target_lang=de-CH&source_lang=en&politeness=default')).corrections).toHaveLength(1);
  });

  it('acknowledges only the version that was fetched', async () => {
    const [c] = (await pending()).corrections;
    expect(await acknowledge([{ id: c!.id, version: '0000000000000000' }])).toEqual({ acknowledged: 0 });
    // Another plugin or key can't acknowledge it.
    expect(await acknowledge([{ id: c!.id, version: c!.version }], { ua: 'Other-Supertext-Translation/2.0.0' })).toEqual({ acknowledged: 0 });
    expect(await acknowledge([{ id: c!.id, version: c!.version }], { key: 'key-corr-b' })).toEqual({ acknowledged: 0 });
    expect((await pending()).corrections).toHaveLength(1);
    expect(await acknowledge([{ id: c!.id, version: c!.version }])).toEqual({ acknowledged: 1 });
    expect((await pending()).corrections).toEqual([]);
  });

  it('pends a newer correction again, and a translation round trip delivers it too', async () => {
    await correct('Welcome to our shop', 'Willkommen in unserem Online-Shop');
    expect((await pending()).corrections.map((c) => c.html)).toEqual(['Willkommen in unserem Online-Shop']);
    const out = await translate({ 'tl_content.1.text': 'Welcome to our shop' });
    expect(out).toEqual({ 'tl_content.1.text': 'Willkommen in unserem Online-Shop' });
    expect((await pending()).corrections).toEqual([]);
  });

  it('follows the text a field holds now', async () => {
    // The field's source changed: the old segment's corrections no longer concern it.
    await translate({ 'tl_content.1.text': 'Welcome to the shop' });
    await correct('Welcome to our shop', 'Herzlich willkommen!');
    expect((await pending()).corrections.map((c) => c.st_id)).not.toContain('tl_content.1.text');
  });

  it('pages', async () => {
    await correct('Free shipping from CHF 50', 'Gratis Versand ab CHF 50');
    await correct('Welcome to the shop', 'Willkommen in unserem Laden');
    const first = await pending('?limit=1');
    expect(first.corrections).toHaveLength(1);
    expect(first.next_after).toBe(first.corrections[0]!.id);
    const second = await pending(`?limit=1&after=${first.next_after}`);
    expect(second.corrections).toHaveLength(1);
    expect(second.corrections[0]!.id).not.toBe(first.corrections[0]!.id);
  });

  it('refuses bad requests and keys Supertext rejects', async () => {
    for (const q of ['?limit=0', '?limit=501', '?after=x', '?target_lang=%3Cx%3E', '?politeness=formal']) expect((await call(q)).status).toBe(400);
    expect((await call('/acknowledge', { method: 'POST', body: 'nope' })).status).toBe(400);
    expect((await call('/acknowledge', { method: 'POST', body: JSON.stringify({ corrections: [{ id: '1', version: 'short' }] }) })).status).toBe(400);
    expect((await h.fetch('http://proxy.test/v1/review/corrections')).status).toBe(400);
    const { forgetVerifiedKeys } = await import('../../src/lib/tenant');
    forgetVerifiedKeys();
    expect((await call('', { key: 'invalid' })).status).toBe(401);
  });
});

describe('with the SDK client', () => {
  it('fetches, writes and acknowledges like a plugin', async () => {
    const sdk = client('key-corr-sdk');
    await translate({ 'tl_content.9.text': 'Opening hours' }, 'key-corr-sdk');
    await sql`
      UPDATE segments SET correction_html = 'Öffnungszeiten', status = 'corrected', updated_at = now()
      WHERE source_text = 'Opening hours' AND tenant = ${fingerprintOf('key-corr-sdk')}`;
    const pending = await sdk.pendingCorrections({ targetLang: 'de-CH' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ segmentId: 'tl_content.9.text', html: 'Öffnungszeiten', sourceLang: 'en', politeness: 'default' });
    expect(await sdk.acknowledgeCorrections(pending)).toBe(1);
    expect(await sdk.pendingCorrections({ targetLang: 'de-CH' })).toEqual([]);
  });

  it('gets not_found from Supertext itself', async () => {
    const { SupertextClient: Direct } = await import('../sdk/v1/index');
    const direct = new Direct('key-corr-a', { baseUrl: h.standInUrl, sleep: async () => {} });
    await expect(direct.pendingCorrections()).rejects.toMatchObject({ code: 'not_found' });
  });
});

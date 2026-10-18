// Cases from the security review, end to end through the route handlers. Needs Postgres
// (see proxy.test.ts); database review_test_hardening.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupertextClient } from '../sdk/v1/index';
import { SERVER, setUp, type Harness } from './helpers';

let h: Harness;
let sql: postgres.Sql;
let token: string;
const KEY = 'key-hardening';

const client = () =>
  new SupertextClient(KEY, { baseUrl: 'http://proxy.test/v1/', fetch: (i, init) => h.fetch(i, init), pollIntervalMs: 0, sleep: async () => {} });

function upload(html: string, fields: Record<string, string> = { target_lang: 'de-CH', source_lang: 'en' }, key = KEY) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', new Blob([html], { type: 'text/html' }), 'x.html');
  return h.fetch('http://proxy.test/v1/translate/ai/file', { method: 'POST', body: form, headers: { Authorization: `Supertext-Auth-Key ${key}` } });
}

const doc = (body: string) => `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n${body}\n</body></html>\n`;

const api = (path: string, init: RequestInit = {}) =>
  h.fetch(`http://proxy.test/api/review/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

beforeAll(async () => {
  h = await setUp('review_test_hardening');
  sql = postgres(`${SERVER.replace(/\/[^/]*$/, '')}/review_test_hardening`, { max: 1, onnotice: () => {} });
  await client().translateTexts(
    { a: 'Welcome to our shop', b: { text: 'Read <a href="https://example.ch/guide">the guide</a> first.', html: true }, t: 'Free shipping from CHF 50' },
    'de-CH',
    { sourceLang: 'en' },
  );
  const { fingerprint } = await import('../../src/lib/tenant');
  const store = await import('../../src/lib/admin-store');
  const links = await import('../../src/lib/review-links');
  const site = await store.createSite({ tenant: fingerprint(KEY), name: 'S', origin: 'https://s.example', sourceLang: 'en', sourcePrefix: null, targetPrefixes: {} });
  token = links.tokenFor(await links.createLink(site, 'de-CH', 'customer', '', 30))!;
});

afterAll(async () => {
  await sql?.end();
  await h?.close();
});

describe('which documents go to Supertext', () => {
  it('sends a document with loose text every time, so the loose text is always translated', async () => {
    const html = doc('<h1>Our shop</h1>\n<div data-st-id="0">Welcome to our shop</div>');
    const before = (await h.stats()).submitted;
    await client().translateHtml(html, 'de-CH', { sourceLang: 'en' });
    await client().translateHtml(html, 'de-CH', { sourceLang: 'en' });
    expect((await h.stats()).submitted).toBe(before + 2);
  });

  it('sends documents without segments, so Supertext checks the language pair', async () => {
    const res = await upload(doc('<p>No segments here</p>'), { target_lang: 'xx-INVALID' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('INVALID_LANGUAGE_PAIR');
    expect((await upload(doc(''), {})).status).toBe(404);
  });

  it('sends the whole document when a missing segment can’t travel alone', async () => {
    const before = (await h.stats()).submitted;
    const res = await upload(doc('<table><tr><td data-st-id="0">Opening hours</td></tr></table>'));
    const { file_id: id } = (await res.json()) as { file_id: string };
    const [job] = await sql`SELECT mode FROM jobs WHERE id = ${id}`;
    expect(job!.mode).toBe('full');
    expect((await h.stats()).submitted).toBe(before + 1);
    // An SDK document with div segments still sends only what's missing.
    const r2 = await upload(doc('<div data-st-id="0">Welcome to our shop</div>\n<div data-st-id="1">Brand new line</div>'));
    const [job2] = await sql`SELECT mode FROM jobs WHERE id = ${((await r2.json()) as { file_id: string }).file_id}`;
    expect(job2!.mode).toBe('reduced');
  });
});

describe('concurrent polls', () => {
  it('download and store a finished job once', async () => {
    const res = await upload(doc('<div data-st-id="0">Polled four times at once</div>'));
    const { file_id: id } = (await res.json()) as { file_id: string };
    const poll = () => h.fetch(`http://proxy.test/v1/translate/ai/file/${id}/status`, { headers: { Authorization: `Supertext-Auth-Key ${KEY}` } });
    // The stand-in answers "translating" to the first status poll.
    expect(await (await poll()).json()).toEqual({ status: 'translating' });
    const downloads = (await h.stats()).downloads;
    const answers = await Promise.all([poll(), poll(), poll(), poll()].map(async (p) => ((await (await p).json()) as { status: string }).status));
    expect(answers).toContain('done');
    expect((await h.stats()).downloads).toBe(downloads + 1);
    const [row] = await sql`SELECT hits FROM segments WHERE source_html = 'Polled four times at once'`;
    expect(row!.hits).toBe(1);
    expect(await (await poll()).json()).toEqual({ status: 'done' });
  });
});

describe('uploads the proxy refuses itself', () => {
  it('NUL characters and oversized bodies', async () => {
    expect((await upload(doc('<div data-st-id="0">a\u0000b</div>'))).status).toBe(400);
    const big = new Blob([new Uint8Array(5_000_000)]);
    const res = await h.fetch('http://proxy.test/v1/translate/ai/file', {
      method: 'POST',
      body: big,
      headers: { Authorization: `Supertext-Auth-Key ${KEY}`, 'Content-Type': 'multipart/form-data; boundary=x' },
    });
    expect(res.status).toBe(413);
  });

  it('a crafted 1 MB document doesn’t stall the proxy', async () => {
    const t = Date.now();
    const res = await upload('<a data-st-id=1 '.repeat(62_000), { target_lang: 'de-CH' }, 'garbage-key');
    expect(Date.now() - t).toBeLessThan(5000);
    expect(res.status).toBeGreaterThanOrEqual(200);
  });
});

describe('corrections through the review API', () => {
  const idOf = async (text: string) => {
    const r = (await (await api('match', { method: 'POST', body: JSON.stringify({ side: 'translation', texts: [{ text }] }) })).json()) as {
      results: { segments: { id: number }[] }[];
    };
    return r.results[0]!.segments[0]!.id;
  };

  it('refuse unclosed links, scripts and markup smuggled as entities', async () => {
    const link = await idOf('Lesen Sie zuerst die Anleitung.');
    const put = (id: number, body: unknown) => api(`segments/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    expect((await put(link, { html: 'Lies <a href="https://example.ch/guide">die Anleitung', reviewer: 'M' })).status).toBe(422);
    expect((await put(link, { html: '<script>alert(1)</script> Hallo', reviewer: 'M' })).status).toBe(422);
    const plain = await idOf('Gratisversand ab CHF 50');
    expect((await put(plain, { html: '&lt;img src=x onerror=alert(1)&gt;', reviewer: 'M' })).status).toBe(422);
    expect((await put(plain, { text: '<img src=x onerror=alert(1)>', reviewer: 'M' })).status).toBe(422);
    expect((await put(plain, { text: 'a\u0000b', reviewer: 'M' })).status).toBe(400);
    // Nothing above changed the served translation.
    const out = await client().translateTexts({ t: 'Free shipping from CHF 50' }, 'de-CH', { sourceLang: 'en' });
    expect(out).toEqual({ t: 'Gratisversand ab CHF 50' });
  });

  it('keep the documents a plugin gets back intact', async () => {
    const link = await idOf('Lesen Sie zuerst die Anleitung.');
    const ok = await api(`segments/${link}`, { method: 'PUT', body: JSON.stringify({ html: 'Lesen Sie <b>zuerst</b> <a href="https://example.ch/guide">die Anleitung</a>.', reviewer: 'M' }) });
    // <b> isn't in the source or the AI answer.
    expect(ok.status).toBe(422);
    const good = await api(`segments/${link}`, { method: 'PUT', body: JSON.stringify({ html: 'Bitte zuerst <a href="https://example.ch/guide">die Anleitung</a> lesen.', reviewer: 'M' }) });
    expect(good.status).toBe(200);
    const out = await client().translateTexts(
      { b: { text: 'Read <a href="https://example.ch/guide">the guide</a> first.', html: true }, a: 'Welcome to our shop' },
      'de-CH',
      { sourceLang: 'en' },
    );
    expect(out).toEqual({ b: 'Bitte zuerst <a href="https://example.ch/guide">die Anleitung</a> lesen.', a: 'Willkommen in unserem Shop' });
  });
});

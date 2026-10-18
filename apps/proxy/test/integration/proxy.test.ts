// The proxy driven by the Supertext TypeScript SDK (the client the plugins use) against
// the SDK's stand-in. Needs Postgres: TEST_DATABASE_URL (default
// postgres://postgres:postgres@127.0.0.1:5432/postgres); drops and recreates review_test_proxy.
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupertextClient, SupertextError } from '../sdk/v1/index';
import { SERVER, setUp, type Harness } from './helpers';

let h: Harness;
let sql: postgres.Sql;
/** Bodies of the documents the proxy uploaded to the stand-in, in order. */
let uploads: string[] = [];

const realFetch = globalThis.fetch;

beforeAll(async () => {
  h = await setUp('review_test_proxy');
  sql = postgres(`${SERVER.replace(/\/[^/]*$/, '')}/review_test_proxy`, { max: 1, onnotice: () => {} });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/translate/ai/file') && init?.body instanceof FormData) {
      uploads.push(await (init.body.get('file') as Blob).text());
    }
    return realFetch(input, init);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await sql?.end();
  await h?.close();
});

beforeEach(() => {
  uploads = [];
});

function client(key = 'key-tenant-a') {
  return new SupertextClient(key, {
    baseUrl: 'http://proxy.test/v1/',
    fetch: (input, init) => h.fetch(input, init),
    pollIntervalMs: 0,
    sleep: async () => {},
    userAgent: 'Test-Supertext-Translation/1.0.0',
  });
}

const segmentsIn = (doc: string) => [...doc.matchAll(/data-st-id="([^"]+)"/g)].map((m) => m[1]);

describe('translateTexts through the proxy', () => {
  it('translates through Supertext the first time and stores every segment', async () => {
    const before = (await h.stats()).submitted;
    const out = await client().translateTexts({ title: 'Welcome to our shop', body: 'Something new' }, 'de-CH', { sourceLang: 'en' });
    expect(out).toEqual({ title: 'Willkommen in unserem Shop', body: '[de-CH] Something new' });
    expect((await h.stats()).submitted).toBe(before + 1);
    const rows = await sql`SELECT source_html, ai_html, status, hits FROM segments ORDER BY source_html`;
    expect(rows.map((r) => [r.source_html, r.ai_html, r.status, r.hits])).toEqual([
      ['Something new', '[de-CH] Something new', 'ai', 1],
      ['Welcome to our shop', 'Willkommen in unserem Shop', 'ai', 1],
    ]);
  });

  it('answers a repeat entirely from the memory, without calling Supertext', async () => {
    const before = (await h.stats()).submitted;
    const out = await client().translateTexts({ a: 'Something new', b: 'Welcome to our shop' }, 'de-CH', { sourceLang: 'en' });
    expect(out).toEqual({ a: '[de-CH] Something new', b: 'Willkommen in unserem Shop' });
    expect((await h.stats()).submitted).toBe(before);
    expect(uploads).toEqual([]);
    const [row] = await sql`SELECT hits FROM segments WHERE source_html = 'Something new'`;
    expect(row!.hits).toBe(2);
  });

  it('uploads only the missing segments', async () => {
    const out = await client().translateTexts({ a: 'Welcome to our shop', b: 'Free shipping from CHF 50', c: '' }, 'de-CH', { sourceLang: 'en' });
    expect(out).toEqual({ a: 'Willkommen in unserem Shop', b: 'Gratisversand ab CHF 50', c: '' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('Free shipping from CHF 50');
    expect(uploads[0]).not.toContain('Welcome to our shop');
  });

  it('keeps languages, politeness and source detection apart', async () => {
    const fr = await client().translateTexts({ t: 'Welcome to our shop' }, 'fr-CH', { sourceLang: 'en' });
    expect(fr).toEqual({ t: 'Bienvenue dans notre boutique' });
    const formal = await client().translateTexts({ t: 'Welcome to our shop' }, 'de-CH', { sourceLang: 'en', politeness: 'more' });
    expect(formal).toEqual({ t: 'Willkommen in unserem Shop' });
    const detected = await client().translateTexts({ t: 'Welcome to our shop' }, 'de-CH');
    expect(detected).toEqual({ t: 'Willkommen in unserem Shop' });
    expect(uploads).toHaveLength(3);
    // 'default' politeness is the same translation as none.
    uploads = [];
    await client().translateTexts({ t: 'Welcome to our shop' }, 'de-CH', { sourceLang: 'en', politeness: 'default' });
    expect(uploads).toEqual([]);
  });

  it('keeps tenants apart', async () => {
    const out = await client('key-tenant-b').translateTexts({ t: 'Welcome to our shop' }, 'de-CH', { sourceLang: 'en' });
    expect(out).toEqual({ t: 'Willkommen in unserem Shop' });
    expect(uploads).toHaveLength(1);
    const a = client('key-tenant-a');
    const fileId = await a.submit('<!DOCTYPE html><html><body><div data-st-id="0">Welcome to our shop</div></body></html>', 'de-CH', { sourceLang: 'en' });
    // Another key doesn't see the job.
    await expect(client('key-tenant-b').getStatus(fileId)).rejects.toBeInstanceOf(SupertextError);
    expect(await a.getStatus(fileId)).toBe('done');
    await a.delete(fileId);
    await expect(a.getStatus(fileId)).rejects.toBeInstanceOf(SupertextError);
  });

  it('keeps rich text and serves the stored translation inside a whole-document upload', async () => {
    const html = '<!DOCTYPE html><html><head><title>t</title></head><body>\n<h1>Loose heading</h1>\n' +
      '<div data-st-id="0">Read <a href="https://example.ch/guide">the guide</a> first.</div>\n' +
      '<div data-st-id="1">Welcome to our shop</div>\n</body></html>\n';
    // Pretend a reviewer already corrected segment 1 for this tenant.
    await sql`UPDATE segments SET correction_html = 'Willkommen im Shop', status = 'corrected'
              WHERE source_html = 'Welcome to our shop' AND target_lang = 'de-CH' AND source_lang = 'en' AND politeness = ''
                AND tenant = (SELECT tenant FROM segments WHERE source_html = 'Something new' LIMIT 1)`;
    const out = await client().translateHtml(html, 'de-CH', { sourceLang: 'en' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toBe(html); // text outside segments: the whole document goes
    expect(out).toContain('<div data-st-id="0">Lesen Sie zuerst <a href="https://example.ch/guide">die Anleitung</a>.</div>');
    expect(out).toContain('<div data-st-id="1">Willkommen im Shop</div>');
    expect(out).toContain('<h1>Loose heading</h1>'); // the stand-in leaves non-segment text alone
    const [link] = await sql`SELECT ai_html FROM segments WHERE source_html LIKE 'Read <a%'`;
    expect(link!.ai_html).toBe('Lesen Sie zuerst <a href="https://example.ch/guide">die Anleitung</a>.');
  });
});

describe('Supertext errors reach the integration unchanged', () => {
  it('passes features and the key check through', async () => {
    const features = await client().getFeatures();
    expect(features.some((f) => f.sourceLang === 'en' && f.targetLang === 'de-CH')).toBe(true);
    expect((await client().checkApiKey()).status).toBe('ok');
    expect((await client('invalid').checkApiKey()).status).toBe('invalid');
  });

  it('language pair, politeness, key and file errors', async () => {
    const err = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as SupertextError).code;
      }
      return 'no error';
    };
    expect(await err(client().translateTexts({ t: 'Hello there' }, 'de', { sourceLang: 'en' }))).toBe('invalid_language_pair');
    expect(await err(client().translateTexts({ t: 'Hello there' }, 'en-US', { sourceLang: 'de', politeness: 'more' }))).toBe('unsupported_feature');
    expect(await err(client('invalid').translateTexts({ t: 'Hello there' }, 'de-CH'))).toBe('authentication_failure');
    expect(await err(client().translateTexts({ t: 'STAND-IN:error' }, 'de-CH', { sourceLang: 'en' }))).toBe('translation_error');

    const form = new FormData();
    form.set('target_lang', 'de-CH');
    form.set('file', new Blob(['<div data-st-id="0">x</div>'], { type: 'text/html; charset=utf-8' }), 'x.html');
    const res = await h.fetch('http://proxy.test/v1/translate/ai/file', { method: 'POST', body: form, headers: { Authorization: 'Supertext-Auth-Key key-tenant-a' } });
    expect(res.status).toBe(415);
    const noPrefix = await h.fetch('http://proxy.test/v1/features', { headers: { Authorization: 'key-tenant-a' } });
    expect(noPrefix.status).toBe(400);
  });

  it('rechecks the key with Supertext before answering from the memory alone', async () => {
    const { forgetVerifiedKeys } = await import('../../src/lib/tenant');
    forgetVerifiedKeys();
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error_code: 'UNAUTHORIZED' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    const res = await h.fetch('http://proxy.test/v1/translate/ai/file', {
      method: 'POST',
      headers: { Authorization: 'Supertext-Auth-Key key-tenant-a' },
      body: (() => {
        const f = new FormData();
        f.set('target_lang', 'de-CH');
        f.set('source_lang', 'en');
        f.set('file', new Blob(['<div data-st-id="0">Welcome to our shop</div>'], { type: 'text/html' }), 'x.html');
        return f;
      })(),
    });
    expect(res.status).toBe(401);
  });

  it('records each request: tenant, user agent, jobs', async () => {
    const tenants = await sql`SELECT last_user_agent FROM tenants`;
    expect(tenants.length).toBe(2);
    expect(tenants[0]!.last_user_agent).toContain('Test-Supertext-Translation/1.0.0');
    expect(segmentsIn('<div data-st-id="a"></div>')).toEqual(['a']);
  });
});

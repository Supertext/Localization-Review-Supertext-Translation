// The review API: links, matching page texts, corrections and their effect on the next
// translation request. Needs Postgres (see proxy.test.ts); database review_test_review.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchResponse, ReviewSession, SegmentDetail } from '@supertext-review/shared';
import { SupertextClient } from '../sdk/v1/index';
import { SERVER, setUp, type Harness } from './helpers';

let h: Harness;
let sql: postgres.Sql;
let token: string;
let otherToken: string;
let tenantA: string;

const client = (key = 'key-review-a') =>
  new SupertextClient(key, { baseUrl: 'http://proxy.test/v1/', fetch: (i, init) => h.fetch(i, init), pollIntervalMs: 0, sleep: async () => {} });

const api = (path: string, t: string, init: RequestInit = {}) =>
  h.fetch(`http://proxy.test/api/review/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

async function matchTexts(texts: string[], side: 'translation' | 'source' = 'translation', t = token): Promise<MatchResponse> {
  const res = await api('match', t, { method: 'POST', body: JSON.stringify({ side, texts: texts.map((text) => ({ text })) }) });
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  h = await setUp('review_test_review');
  sql = postgres(`${SERVER.replace(/\/[^/]*$/, '')}/review_test_review`, { max: 1, onnotice: () => {} });
  await client().translateTexts(
    { a: 'Welcome to our shop', b: { text: 'Read <a href="https://example.ch/guide">the guide</a> first.', html: true }, c: 'Free shipping from CHF 50' },
    'de-CH',
    { sourceLang: 'en' },
  );
  await client('key-review-b').translateTexts({ a: 'Welcome to our shop' }, 'de-CH', { sourceLang: 'en' });
  const { fingerprint } = await import('../../src/lib/tenant');
  tenantA = fingerprint('key-review-a');
  const store = await import('../../src/lib/admin-store');
  const links = await import('../../src/lib/review-links');
  const site = await store.createSite({ tenant: tenantA, name: 'Kunde', origin: 'https://www.kunde.ch', sourceLang: 'en', sourcePrefix: '/en/', targetPrefixes: { 'de-CH': '/de/' } });
  token = links.tokenFor(await links.createLink(site, 'de-CH', 'linguist', 'Anna', 30))!;
  const siteB = await store.createSite({ tenant: fingerprint('key-review-b'), name: 'Other', origin: 'https://other.example', sourceLang: null, sourcePrefix: null, targetPrefixes: {} });
  otherToken = links.tokenFor(await links.createLink(siteB, 'de-CH', 'customer', '', 30))!;
});

afterAll(async () => {
  await sql?.end();
  await h?.close();
});

describe('review links', () => {
  it('opens a session for a valid link', async () => {
    const res = await api('session', token);
    expect(res.status).toBe(200);
    const s = (await res.json()) as ReviewSession;
    expect(s).toMatchObject({ targetLang: 'de-CH', targetPrefix: '/de/', role: 'linguist', site: { name: 'Kunde', origin: 'https://www.kunde.ch', sourceLang: 'en', sourcePrefix: '/en/' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('refuses forged, revoked and expired links', async () => {
    const [id, mac] = token.split('.');
    expect((await api('session', `${id}.${'A'.repeat(mac!.length)}`)).status).toBe(401);
    expect((await api('session', 'nonsense')).status).toBe(401);
    expect((await h.fetch('http://proxy.test/api/review/session')).status).toBe(401);
    const links = await import('../../src/lib/review-links');
    const store = await import('../../src/lib/admin-store');
    const site = (await store.listSites())[0]!;
    const revokedId = await links.createLink(Number(site.id), 'de-CH', 'customer', '', 30);
    await links.revokeLink(revokedId);
    const res = await api('session', links.tokenFor(revokedId)!);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'link_revoked' });
    const expiredId = await links.createLink(Number(site.id), 'de-CH', 'customer', '', 1);
    await sql`UPDATE review_links SET expires_at = now() - interval '1 second' WHERE id = ${expiredId}`;
    expect(await (await api('session', links.tokenFor(expiredId)!)).json()).toEqual({ error: 'link_expired' });
  });
});

describe('matching page texts', () => {
  it('finds segments by their translation and by their source, in the link’s tenant only', async () => {
    const r = await matchTexts(['Willkommen in unserem Shop', '  Lesen  Sie zuerst die Anleitung. ', 'Unknown footer text', '']);
    expect(r.results.map((x) => x.segments.length)).toEqual([1, 1, 0, 0]);
    expect(r.results[1]!.segments[0]).toMatchObject({ sourceHtml: 'Read <a href="https://example.ch/guide">the guide</a> first.', status: 'ai' });
    const s = await matchTexts(['Welcome to our shop'], 'source');
    expect(s.results[0]!.segments).toHaveLength(1);
    // Tenant B has the same text, but its link only sees its own segment.
    const b = await matchTexts(['Willkommen in unserem Shop'], 'translation', otherToken);
    expect(b.results[0]!.segments).toHaveLength(1);
    expect(b.results[0]!.segments[0]!.id).not.toBe(r.results[0]!.segments[0]!.id);
  });

  it('refuses bad requests', async () => {
    expect((await api('match', token, { method: 'POST', body: '{"side":"x","texts":[]}' })).status).toBe(400);
    expect((await api('match', token, { method: 'POST', body: JSON.stringify({ side: 'source', texts: ['x'.repeat(5001)] }) })).status).toBe(400);
    expect((await api('match', token, { method: 'POST', body: 'not json' })).status).toBe(400);
  });
});

describe('corrections', () => {
  const idOf = async (text: string) => (await matchTexts([text])).results[0]!.segments[0]!.id;

  it('stores a correction that keeps the source markup and serves it from then on', async () => {
    const id = await idOf('Lesen Sie zuerst die Anleitung.');
    const html = 'Bitte lesen Sie zuerst <a href="https://example.ch/guide">die Anleitung</a>.';
    const res = await api(`segments/${id}`, token, { method: 'PUT', body: JSON.stringify({ html, reviewer: 'Anna', comment: 'Höflicher' }) });
    expect(res.status).toBe(200);
    const d = (await res.json()) as SegmentDetail;
    expect(d).toMatchObject({ translationHtml: html, status: 'corrected', aiHtml: 'Lesen Sie zuerst <a href="https://example.ch/guide">die Anleitung</a>.' });
    expect(d.history.map((e) => [e.kind, e.reviewer, e.role])).toEqual([['ai', null, null], ['correction', 'Anna', 'linguist']]);
    // The page now shows the corrected text, and the next translation request gets it.
    expect((await matchTexts(['Bitte lesen Sie zuerst die Anleitung.'])).results[0]!.segments[0]!.id).toBe(id);
    const before = (await h.stats()).submitted;
    const out = await client().translateTexts({ b: { text: 'Read <a href="https://example.ch/guide">the guide</a> first.', html: true } }, 'de-CH', { sourceLang: 'en' });
    expect(out).toEqual({ b: html });
    expect((await h.stats()).submitted).toBe(before);
  });

  it('accepts plain text for segments without markup', async () => {
    const id = await idOf('Gratisversand ab CHF 50');
    const res = await api(`segments/${id}`, token, { method: 'PUT', body: JSON.stringify({ text: 'Gratis Versand ab CHF 50 & mehr', reviewer: 'Anna' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SegmentDetail).translationHtml).toBe('Gratis Versand ab CHF 50 &amp; mehr');
  });

  it('refuses new markup, plain text where markup is needed, empty and anonymous corrections', async () => {
    const id = await idOf('Bitte lesen Sie zuerst die Anleitung.');
    const put = (body: unknown) => api(`segments/${id}`, token, { method: 'PUT', body: JSON.stringify(body) });
    const evil = await put({ html: 'Klicken Sie <a href="https://evil.example">hier</a>', reviewer: 'Mallory' });
    expect(evil.status).toBe(422);
    expect(((await evil.json()) as { error: string }).error).toBe('markup_not_allowed');
    expect((await put({ html: '<img src=x onerror=alert(1)>Hi', reviewer: 'Mallory' })).status).toBe(422);
    expect((await put({ text: 'Bitte lesen', reviewer: 'Anna' })).status).toBe(400);
    expect((await put({ html: '<a href="https://example.ch/guide"></a>', reviewer: 'Anna' })).status).toBe(400);
    expect((await put({ html: 'x', reviewer: '' })).status).toBe(400);
    expect((await put({ html: 'x', text: 'x', reviewer: 'Anna' })).status).toBe(400);
  });

  it('approves and comments, and never reaches another tenant’s segments', async () => {
    const id = await idOf('Willkommen in unserem Shop');
    const ok = await api(`segments/${id}/approve`, token, { method: 'POST', body: JSON.stringify({ reviewer: 'Anna' }) });
    expect(((await ok.json()) as SegmentDetail).status).toBe('approved');
    const c = await api(`segments/${id}/comment`, token, { method: 'POST', body: JSON.stringify({ reviewer: 'Anna', comment: 'Passt.' }) });
    const detail = (await c.json()) as SegmentDetail;
    expect(detail.history.map((e) => e.kind)).toEqual(['ai', 'approval', 'comment']);
    expect((await api(`segments/${id}/comment`, token, { method: 'POST', body: JSON.stringify({ reviewer: 'Anna' }) })).status).toBe(400);
    // Tenant B's link can't read or change tenant A's segment.
    expect((await api(`segments/${id}`, otherToken)).status).toBe(404);
    expect((await api(`segments/${id}`, otherToken, { method: 'PUT', body: JSON.stringify({ text: 'x', reviewer: 'B' }) })).status).toBe(404);
    expect((await api('segments/abc', token)).status).toBe(404);
  });
});

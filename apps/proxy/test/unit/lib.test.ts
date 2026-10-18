import { afterEach, describe, expect, it } from 'vitest';
import { normalizeOrigin, normalizePrefix } from '../../src/lib/admin-store';
import { segmentKey } from '../../src/lib/memory';
import { linksConfigured, tokenFor, verifyToken } from '../../src/lib/review-links';
import { fingerprint, readCaller } from '../../src/lib/tenant';

const SECRET = process.env.REVIEW_LINK_SECRET!;

afterEach(() => {
  process.env.REVIEW_LINK_SECRET = SECRET;
});

describe('review link tokens', () => {
  it('round-trips and refuses forgeries', () => {
    const t = tokenFor(42)!;
    expect(t).toMatch(/^42\.[A-Za-z0-9_-]{43}$/);
    expect(verifyToken(t)).toBe(42);
    expect(verifyToken(t.replace(/^42/, '43'))).toBeNull();
    expect(verifyToken(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(verifyToken('42')).toBeNull();
    expect(verifyToken('')).toBeNull();
  });

  it('needs a long secret, and a new secret invalidates old tokens', () => {
    const t = tokenFor(7)!;
    process.env.REVIEW_LINK_SECRET = 'another-secret-another-secret-0123456789';
    expect(verifyToken(t)).toBeNull();
    process.env.REVIEW_LINK_SECRET = 'short';
    expect(linksConfigured()).toBe(false);
    expect(tokenFor(7)).toBeNull();
  });
});

describe('callers', () => {
  const req = (auth?: string) => new Request('http://proxy.test/v1/features', { headers: auth ? { Authorization: auth } : {} });

  it('reads the key and fingerprints it like the SDK', async () => {
    const c = readCaller(req('Supertext-Auth-Key abc123'));
    expect(c).toMatchObject({ key: 'abc123', tenant: fingerprint('abc123') });
    expect(fingerprint('abc123')).toBe('6ca13d52ca70c883e0f0bb101e425a89e8624de51db2d2392593af6a84118090');
  });

  it('answers malformed headers like Supertext', async () => {
    expect((readCaller(req()) as Response).status).toBe(400);
    expect((readCaller(req('Bearer abc')) as Response).status).toBe(400);
    // Header values lose trailing spaces, so an empty key arrives without the prefix.
    expect((readCaller(req('Supertext-Auth-Key ')) as Response).status).toBe(400);
    expect((readCaller(req('Supertext-Auth-Key two words')) as Response).status).toBe(401);
  });
});

describe('segment keys', () => {
  const scope = { tenant: 'a'.repeat(64), sourceLang: 'en', targetLang: 'de-CH', politeness: '' };

  it('ignore outer whitespace and line endings, nothing else', () => {
    expect(segmentKey(scope, ' Hello\r\n')).toBe(segmentKey(scope, 'Hello'));
    expect(segmentKey(scope, 'Hello')).not.toBe(segmentKey(scope, 'hello'));
    expect(segmentKey(scope, 'Hello')).not.toBe(segmentKey({ ...scope, politeness: 'more' }, 'Hello'));
    expect(segmentKey(scope, 'Hello')).not.toBe(segmentKey({ ...scope, tenant: 'b'.repeat(64) }, 'Hello'));
    expect(segmentKey(scope, 'Hello')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('site settings', () => {
  it('normalizes origins and prefixes', () => {
    expect(normalizeOrigin(' https://www.Kunde.ch/de/start?x=1 ')).toBe('https://www.kunde.ch');
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizePrefix('fr')).toBe('/fr/');
    expect(normalizePrefix('/fr-ch/')).toBe('/fr-ch/');
    expect(normalizePrefix('/')).toBe('/');
    expect(normalizePrefix('')).toBeNull();
    expect(normalizePrefix('/fr?x=1')).toBeNull();
  });
});

describe('plugins from the User-Agent', async () => {
  const { parseUserAgent } = await import('../../src/lib/integrations');
  it('reads the SDK and plugin tokens', () => {
    expect(parseUserAgent('supertext-sdk-php Typo3-Supertext-Translation/0.6.0')).toEqual({ plugin: 'Typo3-Supertext-Translation', version: '0.6.0', sdk: 'php' });
    expect(parseUserAgent('supertext-sdk-typescript/0.5.0 Payload-Supertext-Translation/1.2.0')).toEqual({ plugin: 'Payload-Supertext-Translation', version: '1.2.0', sdk: 'typescript' });
    expect(parseUserAgent('supertext-wordpress-polylang/2.1.0 WordPress/6.9')).toEqual({ plugin: 'supertext-wordpress-polylang', version: '2.1.0', sdk: '' });
    expect(parseUserAgent('supertext-sdk-php Contao-Supertext-Translation')).toEqual({ plugin: 'Contao-Supertext-Translation', version: '', sdk: 'php' });
    expect(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toEqual({ plugin: '', version: '', sdk: '' });
    expect(parseUserAgent('GuzzleHttp/7 curl/8.5 PHP/8.3')).toEqual({ plugin: '', version: '', sdk: '' });
    expect(parseUserAgent('')).toEqual({ plugin: '', version: '', sdk: '' });
  });
});

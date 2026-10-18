import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * One shared password (REVIEW_ADMIN_PASSWORD). A successful login sets a signed cookie
 * "<expiry>.<hmac>"; the key is derived from the password, so changing the password
 * signs everyone out.
 */
export const SESSION_COOKIE = 'review_session';
export const SESSION_DAYS = 14;

function password(): string | null {
  const p = process.env.REVIEW_ADMIN_PASSWORD;
  return p && p.length >= 12 ? p : null;
}

export function passwordConfigured(): boolean {
  return password() !== null;
}

function key(pw: string): Buffer {
  return createHash('sha256').update(`review-admin-session:${pw}`).digest();
}

function sign(pw: string, expires: number): string {
  return createHmac('sha256', key(pw)).update(`v1:${expires}`).digest('base64url');
}

function same(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export function checkPassword(candidate: string): boolean {
  const pw = password();
  return pw !== null && same(candidate, pw);
}

export function createSession(now = Date.now()): { value: string; expires: Date } | null {
  const pw = password();
  if (!pw) return null;
  const expires = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return { value: `${expires}.${sign(pw, expires)}`, expires: new Date(expires) };
}

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  const pw = password();
  if (!pw || !value) return false;
  const [exp, mac] = value.split('.');
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < now || !mac) return false;
  return same(mac, sign(pw, expires));
}

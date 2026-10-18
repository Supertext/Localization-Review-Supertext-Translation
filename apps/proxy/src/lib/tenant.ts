import { createHash } from 'node:crypto';
import { db } from './db';
import { apiError } from './http';

export const AUTH_PREFIX = 'Supertext-Auth-Key ';

export interface Caller {
  /** The API key exactly as the integration sent it, forwarded to Supertext. Never stored or logged. */
  key: string;
  /** SHA-256 of the key (hex): the tenant. */
  tenant: string;
  /** The integration's User-Agent, at most 300 characters. */
  userAgent: string;
}

/** SHA-256 of the API key, hex. Same as the SDK's `apiKeyFingerprint`. */
export function fingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Reads the caller from the Authorization header, answering malformed headers
 * the way Supertext does (no prefix: 400; empty key: 401).
 */
export function readCaller(req: Request): Caller | Response {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith(AUTH_PREFIX)) return apiError(400, 'INVALID_AUTHORIZATION_HEADER');
  const key = auth.slice(AUTH_PREFIX.length).trim();
  if (!/^\S{1,500}$/.test(key)) return apiError(401, 'UNAUTHORIZED');
  return { key, tenant: fingerprint(key), userAgent: (req.headers.get('user-agent') ?? '').slice(0, 300) };
}

/** Creates the tenant on first contact and records the latest User-Agent. */
export async function touchTenant(caller: Caller): Promise<void> {
  await db()`
    INSERT INTO tenants (fingerprint, last_user_agent) VALUES (${caller.tenant}, ${caller.userAgent})
    ON CONFLICT (fingerprint) DO UPDATE SET last_seen_at = now(), last_user_agent = EXCLUDED.last_user_agent`;
}

/**
 * Keys Supertext accepted recently. A job answered entirely from the memory
 * makes no Supertext call, so without this a key revoked at Supertext would
 * keep working for remembered texts. In memory per process; 10 minutes.
 */
const verified = new Map<string, number>();
export const KEY_RECHECK_MS = 10 * 60 * 1000;

export function markVerified(tenant: string, now = Date.now()): void {
  if (verified.size > 10_000) verified.clear();
  verified.set(tenant, now + KEY_RECHECK_MS);
}

export function recentlyVerified(tenant: string, now = Date.now()): boolean {
  return (verified.get(tenant) ?? 0) > now;
}

/** Test hook. */
export function forgetVerifiedKeys(): void {
  verified.clear();
}

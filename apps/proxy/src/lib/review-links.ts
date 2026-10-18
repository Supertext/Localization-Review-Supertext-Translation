/**
 * Review links. A link belongs to one site, one target language and one role;
 * its token is "<link id>.<hmac>", signed with REVIEW_LINK_SECRET. The row in
 * review_links decides expiry and revocation, so a link can be revoked
 * without changing the secret; changing the secret invalidates every link.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReviewRole } from '@supertext-review/shared';
import { db } from './db';

export const MIN_SECRET_LENGTH = 32;

function secret(): string | null {
  const s = process.env.REVIEW_LINK_SECRET;
  return s && s.length >= MIN_SECRET_LENGTH ? s : null;
}

export function linksConfigured(): boolean {
  return secret() !== null;
}

function mac(s: string, id: string): string {
  return createHmac('sha256', s).update(`review-link:v1:${id}`).digest('base64url');
}

/** The token for a link id; null when REVIEW_LINK_SECRET isn't set. */
export function tokenFor(id: number | string): string | null {
  const s = secret();
  return s ? `${id}.${mac(s, String(id))}` : null;
}

/** The link id of a correctly signed token, else null. */
export function verifyToken(token: string): number | null {
  const s = secret();
  const m = /^([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!s || !m) return null;
  const expected = Buffer.from(mac(s, m[1]!));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given) ? Number(m[1]) : null;
}

export interface ReviewLink {
  id: number;
  site_id: number;
  target_lang: string;
  role: ReviewRole;
  label: string;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export interface ReviewSite {
  id: number;
  tenant: string;
  name: string;
  origin: string;
  source_lang: string | null;
  source_prefix: string | null;
  target_prefixes: Record<string, string>;
  created_at: Date;
}

export async function createLink(siteId: number, targetLang: string, role: ReviewRole, label: string, days: number): Promise<number> {
  const [row] = await db()<{ id: string }[]>`
    INSERT INTO review_links (site_id, target_lang, role, label, expires_at)
    VALUES (${siteId}, ${targetLang}, ${role}, ${label}, now() + make_interval(days => ${days}))
    RETURNING id`;
  return Number(row!.id);
}

export async function revokeLink(id: number): Promise<void> {
  await db()`UPDATE review_links SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
}

/** The link and its site for a token, or why it can't be used. */
export async function resolveToken(
  token: string,
  now = new Date(),
): Promise<{ link: ReviewLink; site: ReviewSite } | { error: 'unauthorized' | 'link_expired' | 'link_revoked' }> {
  const id = verifyToken(token);
  if (id === null) return { error: 'unauthorized' };
  const [row] = await db()<(ReviewLink & { site: ReviewSite })[]>`
    SELECT l.*, row_to_json(s.*) AS site FROM review_links l JOIN review_sites s ON s.id = l.site_id WHERE l.id = ${id}`;
  if (!row) return { error: 'unauthorized' };
  if (row.revoked_at) return { error: 'link_revoked' };
  if (new Date(row.expires_at) <= now) return { error: 'link_expired' };
  const { site, ...link } = row;
  return { link: { ...link, id: Number(link.id), site_id: Number(link.site_id) }, site: { ...site, id: Number(site.id) } };
}

/** Queries for the staff pages: tenants, segments, review sites and links. */
import type { ReviewRole, SegmentStatus } from '@supertext-review/shared';
import { normalizeText } from '@supertext-review/shared';
import { db } from './db';
import type { ReviewLink, ReviewSite } from './review-links';

export interface TenantRow {
  fingerprint: string;
  label: string;
  notes: string;
  first_seen_at: Date;
  last_seen_at: Date;
  last_user_agent: string;
  segments: number;
  corrected: number;
  languages: string[];
}

export async function listTenants(): Promise<TenantRow[]> {
  return db()<TenantRow[]>`
    SELECT t.*,
      (SELECT count(*)::int FROM segments s WHERE s.tenant = t.fingerprint) AS segments,
      (SELECT count(*)::int FROM segments s WHERE s.tenant = t.fingerprint AND s.status <> 'ai') AS corrected,
      coalesce((SELECT array_agg(DISTINCT s.target_lang ORDER BY s.target_lang) FROM segments s WHERE s.tenant = t.fingerprint), '{}') AS languages
    FROM tenants t ORDER BY t.last_seen_at DESC`;
}

export async function getTenant(fingerprint: string): Promise<TenantRow | null> {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  const rows = await listTenants();
  return rows.find((t) => t.fingerprint === fingerprint) ?? null;
}

export async function updateTenant(fingerprint: string, label: string, notes: string): Promise<void> {
  await db()`UPDATE tenants SET label = ${label}, notes = ${notes} WHERE fingerprint = ${fingerprint}`;
}

export interface SegmentListRow {
  id: string;
  source_lang: string;
  target_lang: string;
  politeness: string;
  source_html: string;
  ai_html: string;
  ai_latest_html: string | null;
  correction_html: string | null;
  status: SegmentStatus;
  hits: number;
  user_agent: string;
  last_seen_at: Date;
}

export interface SegmentFilter {
  targetLang?: string;
  status?: SegmentStatus;
  /** Searches source and served text. */
  q?: string;
  limit?: number;
}

export async function listSegments(tenant: string, f: SegmentFilter = {}): Promise<SegmentListRow[]> {
  const sql = db();
  const q = f.q ? `%${normalizeText(f.q).replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
  return sql<SegmentListRow[]>`
    SELECT id, source_lang, target_lang, politeness, source_html, ai_html, ai_latest_html, correction_html, status, hits, user_agent, last_seen_at
    FROM segments WHERE tenant = ${tenant}
      ${f.targetLang ? sql`AND target_lang = ${f.targetLang}` : sql``}
      ${f.status ? sql`AND status = ${f.status}` : sql``}
      ${q ? sql`AND (source_text ILIKE ${q} OR served_text ILIKE ${q})` : sql``}
    ORDER BY last_seen_at DESC, id DESC LIMIT ${Math.min(f.limit ?? 200, 1000)}`;
}

export interface SiteRow extends ReviewSite {
  tenant_label: string;
  links: number;
}

export async function listSites(): Promise<SiteRow[]> {
  return db()<SiteRow[]>`
    SELECT s.*, t.label AS tenant_label,
      (SELECT count(*)::int FROM review_links l WHERE l.site_id = s.id AND l.revoked_at IS NULL AND l.expires_at > now()) AS links
    FROM review_sites s JOIN tenants t ON t.fingerprint = s.tenant ORDER BY s.name, s.id`;
}

export async function getSite(id: number): Promise<SiteRow | null> {
  return (await listSites()).find((s) => Number(s.id) === id) ?? null;
}

export interface SiteInput {
  tenant: string;
  name: string;
  origin: string;
  sourceLang: string | null;
  sourcePrefix: string | null;
  targetPrefixes: Record<string, string>;
}

/** The origin of a site URL (`https://www.example.ch`), or null if it isn't an http(s) URL. */
export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** A path prefix like `/fr/`: leading and trailing slash, no query. Empty → null. */
export function normalizePrefix(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (!/^\/?[A-Za-z0-9._~\-/]*\/?$/.test(v)) return null;
  return `/${v.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
}

export async function createSite(input: SiteInput): Promise<number> {
  const sql = db();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO review_sites (tenant, name, origin, source_lang, source_prefix, target_prefixes)
    VALUES (${input.tenant}, ${input.name}, ${input.origin}, ${input.sourceLang}, ${input.sourcePrefix}, ${sql.json(input.targetPrefixes)})
    RETURNING id`;
  return Number(row!.id);
}

export async function updateSite(id: number, input: Omit<SiteInput, 'tenant'>): Promise<void> {
  const sql = db();
  await sql`
    UPDATE review_sites SET name = ${input.name}, origin = ${input.origin}, source_lang = ${input.sourceLang},
      source_prefix = ${input.sourcePrefix}, target_prefixes = ${sql.json(input.targetPrefixes)}
    WHERE id = ${id}`;
}

export async function deleteSite(id: number): Promise<void> {
  await db()`DELETE FROM review_sites WHERE id = ${id}`;
}

export interface LinkRow extends ReviewLink {
  corrections: number;
}

export async function listLinks(siteId: number): Promise<LinkRow[]> {
  return db()<LinkRow[]>`
    SELECT l.*, (SELECT count(*)::int FROM segment_events e WHERE e.link_id = l.id AND e.kind = 'correction') AS corrections
    FROM review_links l WHERE l.site_id = ${siteId} ORDER BY l.created_at DESC`;
}

export const ROLES: ReviewRole[] = ['customer', 'linguist'];

export interface IntegrationRow {
  tenant: string;
  tenant_label: string;
  plugin: string;
  plugin_version: string;
  sdk: string;
  user_agent: string;
  key_checks: number;
  uploads: number;
  memory_answers: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

/** Every plugin installation that used the proxy, by plugin, newest first; or one tenant's. */
export async function listIntegrations(tenant?: string): Promise<IntegrationRow[]> {
  const sql = db();
  return sql<IntegrationRow[]>`
    SELECT i.*, t.label AS tenant_label FROM integrations i JOIN tenants t ON t.fingerprint = i.tenant
    ${tenant ? sql`WHERE i.tenant = ${tenant}` : sql``}
    ORDER BY i.plugin = '', lower(i.plugin), i.last_seen_at DESC`;
}

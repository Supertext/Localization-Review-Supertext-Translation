/**
 * Corrections for content the integration doesn't send again. Every downloaded
 * translation records where its segments sit (`data-st-id`, per tenant, plugin,
 * language pair and politeness) and what the integration received. A segment
 * whose served translation differs from that (a reviewer corrected it) is a
 * pending correction; the integration fetches them, writes them into the CMS
 * and acknowledges them.
 *
 *   GET  /v1/review/corrections              pending corrections (paged)
 *   POST /v1/review/corrections/acknowledge  { corrections: [{ id, version }] }
 *
 * Not part of Supertext's API: answered by the proxy only. See docs/DEVELOPER.md.
 */
import { createHash } from 'node:crypto';
import { isSafeSegmentContent } from '@supertext-review/shared';
import { db } from './db';
import { apiError, json, readBody } from './http';
import { parseUserAgent } from './integrations';
import type { PairScope } from './memory';
import type { Caller } from './tenant';

export const MAX_PAGE = 500;
const MAX_ACK = 1000;
const MAX_ACK_BYTES = 200_000;

/** Short fingerprint of a served translation: an acknowledgement only counts for the version fetched. */
export function correctionVersion(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16);
}

export interface Delivered {
  stId: string;
  segmentId: string;
  html: string;
}

/** Records what a downloaded translation gave the integration, per data-st-id. Never fails the download. */
export async function recordLocations(caller: Caller, scope: PairScope, delivered: readonly Delivered[]): Promise<void> {
  if (delivered.length === 0) return;
  const plugin = parseUserAgent(caller.userAgent).plugin;
  // One row per id (a document repeating an id keeps the last), sorted against deadlocks.
  const rows = [...new Map(delivered.map((d) => [d.stId, d])).values()]
    .sort((a, b) => (a.stId < b.stId ? -1 : a.stId > b.stId ? 1 : 0))
    .map((d) => ({
      tenant: scope.tenant,
      plugin,
      source_lang: scope.sourceLang,
      target_lang: scope.targetLang,
      politeness: scope.politeness,
      st_id: d.stId.slice(0, 500),
      segment_id: d.segmentId,
      delivered_html: d.html,
    }));
  const sql = db();
  try {
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await sql`
        INSERT INTO segment_locations ${sql(chunk, 'tenant', 'plugin', 'source_lang', 'target_lang', 'politeness', 'st_id', 'segment_id', 'delivered_html')}
        ON CONFLICT (tenant, plugin, source_lang, target_lang, politeness, st_id) DO UPDATE SET
          segment_id = EXCLUDED.segment_id,
          delivered_html = EXCLUDED.delivered_html,
          delivered_at = now(),
          last_seen_at = now()`;
    }
  } catch (error) {
    console.error('corrections: recording segment locations failed', error instanceof Error ? error.message : error);
  }
}

interface PendingRow {
  id: string;
  st_id: string;
  source_lang: string;
  target_lang: string;
  politeness: string;
  source_html: string;
  html: string;
  status: string;
  updated_at: Date;
}

const LANG = /^[A-Za-z0-9-]{0,40}$/;

/** `GET /v1/review/corrections?target_lang=&source_lang=&politeness=&after=&limit=` */
export async function pendingCorrections(req: Request, caller: Caller): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const target = q.get('target_lang');
  const source = q.get('source_lang');
  const politenessParam = q.get('politeness');
  const after = q.get('after') ?? '0';
  const limit = Number(q.get('limit') ?? MAX_PAGE);
  if ((target !== null && !LANG.test(target)) || (source !== null && !LANG.test(source)) || !/^\d{1,18}$/.test(after)) {
    return apiError(400, 'INVALID_PARAMETER');
  }
  if (politenessParam !== null && !['', 'default', 'more', 'less'].includes(politenessParam)) return apiError(400, 'INVALID_PARAMETER');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return apiError(400, 'INVALID_PARAMETER');
  const politeness = politenessParam === 'default' ? '' : politenessParam;
  const plugin = parseUserAgent(caller.userAgent).plugin;
  const sql = db();
  const rows = await sql<PendingRow[]>`
    SELECT l.id::text AS id, l.st_id, l.source_lang, l.target_lang, l.politeness, s.source_html,
           coalesce(s.correction_html, s.ai_html) AS html, s.status, s.updated_at
    FROM segment_locations l JOIN segments s ON s.id = l.segment_id
    WHERE l.tenant = ${caller.tenant} AND l.plugin = ${plugin} AND l.id > ${after}
      AND s.tenant = ${caller.tenant}
      AND coalesce(s.correction_html, s.ai_html) <> l.delivered_html
      ${target !== null ? sql`AND l.target_lang = ${target}` : sql``}
      ${source !== null ? sql`AND l.source_lang = ${source}` : sql``}
      ${politeness !== null ? sql`AND l.politeness = ${politeness}` : sql``}
    ORDER BY l.id
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit).filter((r) => isSafeSegmentContent(r.html));
  const more = rows.length > limit;
  return json(200, {
    corrections: page.map((r) => ({
      id: r.id,
      st_id: r.st_id,
      source_lang: r.source_lang || null,
      target_lang: r.target_lang,
      politeness: r.politeness || 'default',
      source_html: r.source_html,
      html: r.html,
      status: r.status,
      corrected_at: r.updated_at.toISOString(),
      version: correctionVersion(r.html),
    })),
    // Pass the last id as `after` for the next page.
    next_after: more ? rows[limit - 1]!.id : null,
  });
}

/** `POST /v1/review/corrections/acknowledge`: the integration wrote these into the CMS. */
export async function acknowledgeCorrections(req: Request, caller: Caller): Promise<Response> {
  const body = await readBody(req, MAX_ACK_BYTES);
  if (body === null) return apiError(413, 'REQUEST_TOO_LARGE');
  let items: unknown;
  try {
    items = (JSON.parse(new TextDecoder().decode(body)) as { corrections?: unknown }).corrections;
  } catch {
    return apiError(400, 'INVALID_JSON');
  }
  if (!Array.isArray(items) || items.length > MAX_ACK) return apiError(400, 'INVALID_PARAMETER');
  const wanted = new Map<string, string>();
  for (const item of items) {
    const id = (item as { id?: unknown })?.id;
    const version = (item as { version?: unknown })?.version;
    if (typeof id !== 'string' || !/^\d{1,18}$/.test(id) || typeof version !== 'string' || !/^[0-9a-f]{16}$/.test(version)) {
      return apiError(400, 'INVALID_PARAMETER');
    }
    wanted.set(id, version);
  }
  if (wanted.size === 0) return json(200, { acknowledged: 0 });
  const plugin = parseUserAgent(caller.userAgent).plugin;
  const sql = db();
  const rows = await sql<{ id: string; html: string }[]>`
    SELECT l.id::text AS id, coalesce(s.correction_html, s.ai_html) AS html
    FROM segment_locations l JOIN segments s ON s.id = l.segment_id
    WHERE l.tenant = ${caller.tenant} AND l.plugin = ${plugin} AND l.id = ANY(${[...wanted.keys()]}::bigint[])`;
  // Only the version that was fetched: a newer correction made meanwhile stays pending.
  const current = rows.filter((r) => wanted.get(r.id) === correctionVersion(r.html));
  for (const r of current) {
    await sql`UPDATE segment_locations SET delivered_html = ${r.html}, delivered_at = now() WHERE id = ${r.id} AND tenant = ${caller.tenant}`;
  }
  return json(200, { acknowledged: current.length });
}

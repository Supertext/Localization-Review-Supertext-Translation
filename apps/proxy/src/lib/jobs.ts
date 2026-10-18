/**
 * The four file endpoints of the Supertext API, answered by the proxy:
 *
 *   POST   translate/ai/file                  look up every segment; upload only what's needed
 *   GET    translate/ai/file/{id}/status      poll Supertext (only while the integration polls)
 *   GET    translate/ai/file/{id}/translation the document with the served translations
 *   DELETE translate/ai/file/{id}             forget the job (and Supertext's file)
 *
 * See docs/DEVELOPER.md → How the proxy answers.
 */
import { randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { isBlankSegment, isSafeSegmentContent, replaceSegments, scanDocument, scanSegments, type ScannedSegment } from '@supertext-review/shared';
import { db } from './db';
import { apiError, json, readBody } from './http';
import { countHits, segmentKey, servedTranslations, storeAiResults, type AiResult, type PairScope } from './memory';
import { markVerified, recentlyVerified, touchTenant, type Caller } from './tenant';
import * as upstream from './upstream';

export const MAX_CHARACTERS = 1_000_000;
/** Upload size cap in bytes, before parsing: 1,000,000 characters of UTF-8 plus the multipart envelope. */
export const MAX_UPLOAD_BYTES = 4_500_000;
export const JOB_TTL_HOURS = 24;
/** A status poll that claimed a finished job and then died: others may take over after this long. */
const CLAIM_TIMEOUT_SECONDS = 120;

const HEAD = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n';
const TAIL = '</body></html>\n';

/**
 * Elements that keep their meaning outside their context. Missing segments in
 * other elements (`td`, `li`, `option`, …) could be moved or dropped by an
 * HTML parser when sent on their own, so such documents go to Supertext whole.
 */
const STANDALONE = new Set([
  'div', 'p', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'blockquote', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'strong', 'em', 'b', 'i', 'u', 'small', 'a', 'pre', 'address',
]);

interface JobSegment {
  id: string;
  /** null: blank segment, passed through as it is. */
  key: string | null;
  /** Sent to Supertext in this job. */
  sent?: boolean;
}

interface JobRow {
  id: string;
  tenant: string;
  source_lang: string;
  target_lang: string;
  politeness: string;
  mode: 'local' | 'reduced' | 'full';
  original_html: string;
  segments: JobSegment[];
  upstream_file_id: string | null;
  status: string;
  upstream_html: string | null;
  user_agent: string;
}

const FILE_STATUSES = new Set(['translating', 'done', 'error', 'limit_exceeded', 'deleted']);

function scopeOf(job: Pick<JobRow, 'tenant' | 'source_lang' | 'target_lang' | 'politeness'>): PairScope {
  return { tenant: job.tenant, sourceLang: job.source_lang, targetLang: job.target_lang, politeness: job.politeness };
}

/** Upstream call that never throws: network failures become 502. */
async function tryUpstream(fn: () => Promise<upstream.UpstreamResponse>): Promise<upstream.UpstreamResponse | Response> {
  try {
    return await fn();
  } catch {
    return upstream.unreachable();
  }
}

/**
 * Makes sure Supertext still accepts the key before answering from the
 * memory alone. Returns an error response to pass on, or null.
 */
async function verifyKey(caller: Caller): Promise<Response | null> {
  if (recentlyVerified(caller.tenant)) return null;
  const r = await tryUpstream(() => upstream.features(caller.key, caller.userAgent, ''));
  if (r instanceof Response) return r;
  if (r.status === 200) {
    markVerified(caller.tenant);
    return null;
  }
  return upstream.passThrough(r);
}

type Mode = JobRow['mode'];

/**
 * Which mode a document needs:
 * - full: no segments at all, or visible text outside them (Supertext translates that too,
 *   every time), or missing segments in elements that can't travel alone;
 * - local: every segment is in the memory;
 * - reduced: only the missing segments go to Supertext.
 */
export function chooseMode(segmentCount: number, textOutside: boolean, missing: readonly ScannedSegment[]): Mode {
  if (segmentCount === 0 || textOutside) return 'full';
  if (missing.length === 0) return 'local';
  return missing.every((s) => STANDALONE.has(s.tag)) ? 'reduced' : 'full';
}

export async function createJob(req: Request, caller: Caller): Promise<Response> {
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body === null) return apiError(413, 'FILE_TOO_LARGE');
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'Content-Type': req.headers.get('content-type') ?? '' } }).formData();
  } catch {
    return apiError(400, 'INVALID_MULTIPART');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return apiError(400, 'MISSING_FILE');
  if (file.type !== 'text/html') return apiError(415, 'UNSUPPORTED_MEDIA_TYPE', { content_type: file.type });
  const html = await file.text();
  if (html.length > MAX_CHARACTERS) return apiError(413, 'FILE_TOO_LARGE');
  // Postgres text can't hold NUL; no real document contains it.
  if (html.includes('\u0000')) return apiError(400, 'INVALID_DOCUMENT');

  const field = (name: string) => (form.has(name) ? String(form.get(name)).slice(0, 100) : null);
  const fields: upstream.UploadFields = {
    targetLang: field('target_lang'),
    sourceLang: field('source_lang'),
    politeness: field('politeness'),
    fileName: (file.name || 'document.html').slice(0, 200),
  };
  // Omitted and 'default' politeness are the same translation.
  const politeness = fields.politeness === null || fields.politeness === 'default' ? '' : fields.politeness;
  const scope: PairScope = { tenant: caller.tenant, sourceLang: fields.sourceLang ?? '', targetLang: fields.targetLang ?? '', politeness };

  const doc = scanDocument(html);
  const segments: JobSegment[] = doc.segments.map((s) => ({ id: s.id, key: isBlankSegment(s.inner) ? null : segmentKey(scope, s.inner) }));
  const keys = segments.flatMap((s) => (s.key ? [s.key] : []));
  const known = await servedTranslations(keys);
  const missing = doc.segments.filter((_, i) => segments[i]!.key && !known.has(segments[i]!.key!));
  const mode = chooseMode(keys.length, doc.textOutside, missing);

  let upstreamFileId: string | null = null;
  if (mode === 'local') {
    const refused = await verifyKey(caller);
    if (refused) return refused;
  } else {
    const document = mode === 'full' ? html : HEAD + missing.map((s) => html.slice(s.start, s.end)).join('\n') + '\n' + TAIL;
    const r = await tryUpstream(() => upstream.upload(caller.key, caller.userAgent, fields, document));
    if (r instanceof Response) return r;
    if (r.status !== 200) return upstream.passThrough(r);
    let id: unknown;
    try {
      id = (JSON.parse(r.body) as { file_id?: unknown }).file_id;
    } catch {
      id = null;
    }
    if (typeof id !== 'string' || id === '' || id.length > 200) return apiError(502, 'UPSTREAM_INVALID_ANSWER');
    upstreamFileId = id;
    markVerified(caller.tenant);
    const sentIds = new Set(missing.map((s) => s.id));
    for (const s of segments) if (s.key && (mode === 'full' || sentIds.has(s.id))) s.sent = true;
  }

  await touchTenant(caller);
  await countHits([...known.keys()], caller.userAgent);
  const jobId = randomBytes(16).toString('hex');
  const sql = db();
  await sql`DELETE FROM jobs WHERE created_at < now() - make_interval(hours => ${JOB_TTL_HOURS})`;
  await sql`
    INSERT INTO jobs (id, tenant, source_lang, target_lang, politeness, mode, original_html, segments, upstream_file_id, status, user_agent)
    VALUES (${jobId}, ${caller.tenant}, ${scope.sourceLang}, ${scope.targetLang}, ${politeness}, ${mode}, ${html},
            ${sql.json(segments as unknown as postgres.JSONValue)}, ${upstreamFileId}, ${mode === 'local' ? 'done' : 'translating'}, ${caller.userAgent})`;
  return json(200, { file_id: jobId });
}

async function loadJob(id: string, caller: Caller): Promise<JobRow | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const [row] = await db()<JobRow[]>`
    SELECT * FROM jobs WHERE id = ${id} AND tenant = ${caller.tenant}
      AND created_at >= now() - make_interval(hours => ${JOB_TTL_HOURS})`;
  return row ?? null;
}

const notFound = () => apiError(404, 'NOT_FOUND');

/** Claims a finished job for downloading, so concurrent polls download it once. */
async function claim(jobId: string): Promise<boolean> {
  const rows = await db()`
    UPDATE jobs SET status = 'fetching', claimed_at = now()
    WHERE id = ${jobId}
      AND (status = 'translating' OR (status = 'fetching' AND claimed_at < now() - make_interval(secs => ${CLAIM_TIMEOUT_SECONDS})))
    RETURNING id`;
  return rows.length === 1;
}

async function release(jobId: string): Promise<void> {
  await db()`UPDATE jobs SET status = 'translating', claimed_at = NULL WHERE id = ${jobId} AND status = 'fetching'`;
}

export async function jobStatus(id: string, caller: Caller): Promise<Response> {
  const job = await loadJob(id, caller);
  if (!job) return notFound();
  if (job.status === 'fetching') {
    // Another poll is downloading it; it may also have died, then this poll takes over.
    if (!(await claim(job.id))) return json(200, { status: 'translating' });
    await release(job.id);
  } else if (job.status !== 'translating' || !job.upstream_file_id) {
    return json(200, { status: job.status });
  }

  const r = await tryUpstream(() => upstream.status(caller.key, caller.userAgent, job.upstream_file_id!));
  if (r instanceof Response) return r;
  if (r.status !== 200) return upstream.passThrough(r);
  let status: unknown;
  try {
    status = (JSON.parse(r.body) as { status?: unknown }).status;
  } catch {
    status = null;
  }
  if (typeof status !== 'string' || !FILE_STATUSES.has(status)) return apiError(502, 'UPSTREAM_INVALID_ANSWER');
  if (status === 'translating') return json(200, { status });
  if (status !== 'done') {
    await db()`UPDATE jobs SET status = ${status} WHERE id = ${job.id} AND status = 'translating'`;
    return json(200, { status });
  }

  // Done: download once (other polls answer "translating" meanwhile), store, then report done.
  if (!(await claim(job.id))) return json(200, { status: 'translating' });
  try {
    const t = await tryUpstream(() => upstream.translation(caller.key, caller.userAgent, job.upstream_file_id!));
    if (t instanceof Response || t.status !== 200) {
      await release(job.id);
      return t instanceof Response ? t : upstream.passThrough(t);
    }
    const translated = new Map(scanSegments(t.body).map((s) => [s.id, s.inner]));
    const original = new Map(scanSegments(job.original_html).map((s) => [s.id, s.inner]));
    const results: AiResult[] = [];
    for (const s of job.segments) {
      if (!s.key || !s.sent) continue;
      const ai = translated.get(s.id);
      const source = original.get(s.id);
      // Only store what can be served back safely inside a segment element.
      if (ai === undefined || source === undefined || isBlankSegment(ai) || !isSafeSegmentContent(ai)) continue;
      results.push({ key: s.key, sourceHtml: source, aiHtml: ai });
    }
    await storeAiResults(scopeOf(job), results, job.user_agent);
    await db()`
      UPDATE jobs SET status = 'done', claimed_at = NULL, upstream_html = ${job.mode === 'full' ? t.body : null} WHERE id = ${job.id}`;
    return json(200, { status: 'done' });
  } catch (error) {
    await release(job.id).catch(() => {});
    throw error;
  }
}

export async function jobTranslation(id: string, caller: Caller): Promise<Response> {
  const job = await loadJob(id, caller);
  if (!job) return notFound();
  if (job.status !== 'done') return apiError(404, 'NOT_READY');
  const base = job.mode === 'full' && job.upstream_html ? job.upstream_html : job.original_html;
  const served = await servedTranslations(job.segments.flatMap((s) => (s.key ? [s.key] : [])));
  const keyOf = new Map(job.segments.map((s) => [s.id, s.key]));
  const out = replaceSegments(base, scanSegments(base), (segmentId) => {
    const key = keyOf.get(segmentId);
    if (!key) return undefined; // blank or unknown to the job: as it is
    const html = served.get(key);
    if (html !== undefined && isSafeSegmentContent(html)) return html;
    // Not available: in a whole-document answer keep Supertext's text, otherwise drop the
    // element so the integration sees the segment as missing.
    return job.mode === 'full' ? undefined : null;
  });
  return new Response(out, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function deleteJob(id: string, caller: Caller): Promise<Response> {
  const job = await loadJob(id, caller);
  if (!job) return notFound();
  await db()`DELETE FROM jobs WHERE id = ${job.id}`;
  // Supertext's copy too (best effort; its files expire after 24 hours anyway).
  if (job.upstream_file_id) {
    void upstream.remove(caller.key, caller.userAgent, job.upstream_file_id).catch(() => {});
  }
  return json(200, {});
}

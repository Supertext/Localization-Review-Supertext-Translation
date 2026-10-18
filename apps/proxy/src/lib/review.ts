/**
 * The review API behind /api/review/… (types in packages/shared/src/api.ts,
 * protocol in docs/DEVELOPER.md → Review API). Every call is scoped to the
 * link's site (its tenant) and target language.
 */
import { createHash } from 'node:crypto';
import {
  checkCorrection,
  escapeHtml,
  htmlToText,
  isSafeSegmentContent,
  markupTags,
  MAX_CORRECTION_CHARACTERS,
  normalizeSegmentHtml,
  normalizeText,
  type CorrectionRequest,
  type MatchResponse,
  type ReviewSession,
  type SegmentDetail,
  type SegmentEvent,
  type SegmentSummary,
} from '@supertext-review/shared';
import { db } from './db';
import { readJson, reviewError, reviewJson } from './http';
import { RateLimiter } from './rate-limit';
import { resolveToken, type ReviewLink, type ReviewSite } from './review-links';

export const MAX_TEXTS = 2000;
export const MAX_TEXT_LENGTH = 5000;
const MAX_BODY = 4_000_000;

// 600 requests per minute per link: plenty for a reviewer, a brake for a leaked link.
const limiter = new RateLimiter(600, 60_000);

export interface ReviewContext {
  link: ReviewLink;
  site: ReviewSite;
}

/** Reads the Bearer token; an error response when it can't be used. */
export async function authenticate(req: Request): Promise<ReviewContext | Response> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const resolved = await resolveToken(token);
  if ('error' in resolved) return reviewError(401, resolved.error);
  if (!limiter.take(`link:${resolved.link.id}`)) return reviewError(429, 'rate_limited');
  await db()`UPDATE review_links SET last_used_at = now() WHERE id = ${resolved.link.id}
             AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
  return resolved;
}

export function session(ctx: ReviewContext): Response {
  const body: ReviewSession = {
    site: {
      id: ctx.site.id,
      name: ctx.site.name,
      origin: ctx.site.origin,
      sourceLang: ctx.site.source_lang,
      sourcePrefix: ctx.site.source_prefix,
    },
    targetLang: ctx.link.target_lang,
    targetPrefix: ctx.site.target_prefixes[ctx.link.target_lang] ?? null,
    role: ctx.link.role,
    expiresAt: new Date(ctx.link.expires_at).toISOString(),
  };
  return reviewJson(200, body);
}

interface SegmentRow {
  id: string;
  source_html: string;
  ai_html: string;
  ai_latest_html: string | null;
  correction_html: string | null;
  source_text: string;
  served_text: string;
  status: SegmentSummary['status'];
  hits: number;
  last_seen_at: Date;
}

function summary(r: SegmentRow): SegmentSummary {
  return {
    id: Number(r.id),
    sourceHtml: r.source_html,
    translationHtml: r.correction_html ?? r.ai_html,
    status: r.status,
    hits: r.hits,
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  };
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** Source-language filter: the site's source language, plus segments whose source Supertext detected. */
function sourceLangs(site: ReviewSite): string[] | null {
  return site.source_lang ? [site.source_lang, ''] : null;
}

export async function match(req: Request, ctx: ReviewContext): Promise<Response> {
  const body = (await readJson(req, MAX_BODY)) as { side?: unknown; texts?: unknown } | null;
  if (!body || (body.side !== 'translation' && body.side !== 'source') || !Array.isArray(body.texts)) {
    return reviewError(400, 'invalid_request', 'Expected { side: "translation" | "source", texts: [{ text }] }.');
  }
  if (body.texts.length > MAX_TEXTS) return reviewError(400, 'invalid_request', `At most ${MAX_TEXTS} texts.`);
  const texts: string[] = [];
  for (const t of body.texts) {
    const text = typeof t === 'string' ? t : t && typeof t === 'object' && typeof (t as { text?: unknown }).text === 'string' ? (t as { text: string }).text : null;
    if (text === null || text.length > MAX_TEXT_LENGTH) return reviewError(400, 'invalid_request', `Each text: a string of at most ${MAX_TEXT_LENGTH} characters.`);
    // Normalize again, so an extension that forgot to can't miss.
    texts.push(normalizeText(text));
  }
  const wanted = [...new Set(texts.filter((t) => t !== ''))];
  const byText = new Map<string, SegmentSummary[]>();
  if (wanted.length > 0) {
    const sql = db();
    const column = body.side === 'translation' ? sql('served_text') : sql('source_text');
    const langs = sourceLangs(ctx.site);
    const rows = await sql<(SegmentRow & { matched: string })[]>`
      SELECT *, ${column} AS matched FROM segments
      WHERE tenant = ${ctx.site.tenant} AND target_lang = ${ctx.link.target_lang}
        AND md5(${column}) = ANY(${wanted.map(md5)}) AND ${column} = ANY(${wanted})
        ${langs ? sql`AND source_lang = ANY(${langs})` : sql``}
      ORDER BY last_seen_at DESC
      LIMIT 20000`;
    for (const r of rows) {
      const list = byText.get(r.matched) ?? [];
      if (list.length < 10) list.push(summary(r));
      byText.set(r.matched, list);
    }
  }
  const out: MatchResponse = { results: texts.map((t, index) => ({ index, segments: byText.get(t) ?? [] })) };
  return reviewJson(200, out);
}

async function loadSegment(id: string, ctx: ReviewContext): Promise<SegmentRow | null> {
  if (!/^[1-9][0-9]{0,15}$/.test(id)) return null;
  const langs = sourceLangs(ctx.site);
  const sql = db();
  const [row] = await sql<SegmentRow[]>`
    SELECT * FROM segments WHERE id = ${id} AND tenant = ${ctx.site.tenant} AND target_lang = ${ctx.link.target_lang}
    ${langs ? sql`AND source_lang = ANY(${langs})` : sql``}`;
  return row ?? null;
}

export async function segmentDetail(id: string, ctx: ReviewContext): Promise<Response> {
  const row = await loadSegment(id, ctx);
  if (!row) return reviewError(404, 'not_found');
  const events = await db()<{ kind: SegmentEvent['kind']; html: string | null; comment: string | null; reviewer: string | null; role: SegmentEvent['role']; created_at: Date }[]>`
    SELECT kind, html, comment, reviewer, role, created_at FROM segment_events WHERE segment_id = ${row.id} ORDER BY created_at, id`;
  const detail: SegmentDetail = {
    ...summary(row),
    aiHtml: row.ai_html,
    aiLatestHtml: row.ai_latest_html,
    history: events.map((e) => ({ kind: e.kind, html: e.html, comment: e.comment, reviewer: e.reviewer, role: e.role, at: new Date(e.created_at).toISOString() })),
  };
  return reviewJson(200, detail);
}

function reviewerOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = normalizeText(value);
  return name.length >= 1 && name.length <= 100 ? name : null;
}

function commentOf(value: unknown): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 5000) return false;
  return value.trim() || null;
}

export async function correct(req: Request, id: string, ctx: ReviewContext): Promise<Response> {
  const row = await loadSegment(id, ctx);
  if (!row) return reviewError(404, 'not_found');
  const body = (await readJson(req, 200_000)) as Partial<CorrectionRequest> | null;
  const reviewer = reviewerOf(body?.reviewer);
  const comment = commentOf(body?.comment);
  if (!body || !reviewer || comment === false) return reviewError(400, 'invalid_request', 'Expected { html | text, reviewer (1–100 characters), comment? }.');
  let html: string;
  if (typeof body.html === 'string' && body.text === undefined) {
    if (body.html.length > MAX_CORRECTION_CHARACTERS) return reviewError(400, 'invalid_request', 'The correction is too long.');
    html = normalizeSegmentHtml(body.html);
  } else if (typeof body.text === 'string' && body.html === undefined) {
    if (body.text.length > MAX_CORRECTION_CHARACTERS) return reviewError(400, 'invalid_request', 'The correction is too long.');
    // Plain text would silently drop links and formatting: only for segments without tags.
    if (markupTags(row.source_html).length > 0) return reviewError(400, 'invalid_request', 'This segment has formatting or links: send html.');
    html = escapeHtml(normalizeSegmentHtml(body.text)).replace(/\n/g, '<br>');
  } else {
    return reviewError(400, 'invalid_request', 'Send exactly one of html and text.');
  }
  // Markup first (linear), then the rest. The AI answer's tags are allowed too: Supertext may
  // translate attributes (alt, title) or localize links, and a correction must be able to keep that.
  const problems = checkCorrection(row.source_html, html, row.ai_html);
  if (problems.length > 0) return reviewError(422, 'markup_not_allowed', problems.map((p) => `${p.code}: ${p.detail}`).join('; '));
  if (!isSafeSegmentContent(html)) return reviewError(422, 'markup_not_allowed', 'unbalanced: the correction would break the page.');
  if (htmlToText(html) === '') return reviewError(400, 'invalid_request', 'The correction is empty.');

  await db().begin(async (tx) => {
    await tx`
      UPDATE segments SET correction_html = ${html}, served_text = ${htmlToText(html)}, status = 'corrected', updated_at = now()
      WHERE id = ${row.id}`;
    await tx`
      INSERT INTO segment_events (segment_id, kind, html, comment, reviewer, role, link_id)
      VALUES (${row.id}, 'correction', ${html}, ${comment}, ${reviewer}, ${ctx.link.role}, ${ctx.link.id})`;
  });
  return segmentDetail(id, ctx);
}

export async function approve(req: Request, id: string, ctx: ReviewContext): Promise<Response> {
  return reviewerAction(req, id, ctx, 'approval');
}

export async function addComment(req: Request, id: string, ctx: ReviewContext): Promise<Response> {
  return reviewerAction(req, id, ctx, 'comment');
}

async function reviewerAction(req: Request, id: string, ctx: ReviewContext, kind: 'approval' | 'comment'): Promise<Response> {
  const row = await loadSegment(id, ctx);
  if (!row) return reviewError(404, 'not_found');
  const body = (await readJson(req, 20_000)) as { reviewer?: unknown; comment?: unknown } | null;
  const reviewer = reviewerOf(body?.reviewer);
  const comment = commentOf(body?.comment);
  if (!reviewer || comment === false || (kind === 'comment' && !comment)) {
    return reviewError(400, 'invalid_request', kind === 'comment' ? 'Expected { reviewer, comment }.' : 'Expected { reviewer, comment? }.');
  }
  await db().begin(async (tx) => {
    if (kind === 'approval') await tx`UPDATE segments SET status = 'approved', updated_at = now() WHERE id = ${row.id}`;
    await tx`
      INSERT INTO segment_events (segment_id, kind, comment, reviewer, role, link_id)
      VALUES (${row.id}, ${kind}, ${comment}, ${reviewer}, ${ctx.link.role}, ${ctx.link.id})`;
  });
  return segmentDetail(id, ctx);
}

/**
 * The translation memory: every segment the proxy has seen, per tenant,
 * language pair and politeness, with the AI translation as first received and
 * the human correction. What the proxy serves: correction, else the stored AI
 * translation.
 */
import { createHash } from 'node:crypto';
import { htmlToText, normalizeSegmentHtml } from '@supertext-review/shared';
import { db } from './db';

export interface PairScope {
  tenant: string;
  /** '' when Supertext detects the source language. */
  sourceLang: string;
  targetLang: string;
  /** '' (default), 'more' or 'less'. */
  politeness: string;
}

/** The memory key of a source segment: SHA-256 over the scope and the normalized source HTML. */
export function segmentKey(scope: PairScope, sourceHtml: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['v1', scope.tenant, scope.sourceLang, scope.targetLang, scope.politeness, normalizeSegmentHtml(sourceHtml)]))
    .digest('hex');
}

/** What the proxy serves per key, for the keys that are in the memory. */
export async function servedTranslations(keys: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Map();
  const rows = await db()<{ key: string; html: string }[]>`
    SELECT key, coalesce(correction_html, ai_html) AS html FROM segments WHERE key = ANY(${unique})`;
  return new Map(rows.map((r) => [r.key, r.html]));
}

/** Counts a request for remembered segments. */
export async function countHits(keys: readonly string[], userAgent: string): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  await db()`
    UPDATE segments SET hits = hits + 1, last_seen_at = now(), user_agent = ${userAgent} WHERE key = ANY(${unique})`;
}

export interface AiResult {
  key: string;
  sourceHtml: string;
  aiHtml: string;
}

/**
 * Stores Supertext's translations. New segments are created with the AI
 * translation as the one to serve. For segments already in the memory (the
 * whole document went to Supertext again), the stored translation stays and
 * Supertext's new answer is kept as `ai_latest_html` when it differs.
 */
export async function storeAiResults(scope: PairScope, results: readonly AiResult[], userAgent: string): Promise<void> {
  if (results.length === 0) return;
  // Same order in every transaction, so two jobs with overlapping segments can't deadlock.
  const sorted = [...new Map(results.map((r) => [r.key, r])).values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  await db().begin(async (tx) => {
    for (const r of sorted) {
      const source = normalizeSegmentHtml(r.sourceHtml);
      const ai = normalizeSegmentHtml(r.aiHtml);
      const [row] = await tx<{ id: string; inserted: boolean; changed: boolean }[]>`
        INSERT INTO segments (tenant, source_lang, target_lang, politeness, key, source_html, source_text, ai_html, served_text, hits, user_agent)
        VALUES (${scope.tenant}, ${scope.sourceLang}, ${scope.targetLang}, ${scope.politeness}, ${r.key}, ${source}, ${htmlToText(source)}, ${ai}, ${htmlToText(ai)}, 1, ${userAgent})
        ON CONFLICT (key) DO UPDATE SET
          ai_latest_html = CASE WHEN segments.ai_html = EXCLUDED.ai_html THEN NULL ELSE EXCLUDED.ai_html END,
          ai_latest_at = now(),
          hits = segments.hits + 1,
          last_seen_at = now(),
          user_agent = EXCLUDED.user_agent
        RETURNING id, (xmax = 0) AS inserted, (ai_latest_html IS NOT NULL) AS changed`;
      if (row && (row.inserted || row.changed)) {
        await tx`INSERT INTO segment_events (segment_id, kind, html) VALUES (${row.id}, 'ai', ${ai})`;
      }
    }
  });
}

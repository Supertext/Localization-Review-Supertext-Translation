/**
 * Corrections for the CMS (spec/corrections.json): reviewers correct translations on
 * the website in Supertext Localization Review; its review service (a drop-in proxy
 * for the API) remembers where each segment sits by the integration's `data-st-id`.
 * The integration fetches the corrections it hasn't written yet and acknowledges them.
 * Only the review service answers these calls; Supertext's API answers 404 (`not_found`).
 */
import type { Politeness } from './client.js'

export interface Correction {
  /** The review service's id of this place (send back with `acknowledgeCorrections`). */
  id: string
  /** The `data-st-id` the integration gave the segment (its own reference to the field). */
  segmentId: string
  /** null: the source language was detected. */
  sourceLang: string | null
  targetLang: string
  politeness: Politeness
  sourceHtml: string
  /** What the integration received for this place last: check the field still holds it before overwriting an editor's change. */
  previousHtml: string
  /** The corrected translation: write this into the field. */
  html: string
  /** `corrected`, `approved`, … */
  status: string
  /** ISO time of the latest change. */
  correctedAt: string
  /** Changes with every new correction: acknowledge the version you wrote. */
  version: string
}

export interface PendingCorrectionsOptions {
  targetLang?: string | null
  sourceLang?: string | null
  politeness?: Politeness | null
}

export const CORRECTIONS_PAGE_SIZE = 500
export const CORRECTIONS_MAX_PAGES = 100
export const ACKNOWLEDGE_BATCH_SIZE = 1000

const VERSION = /^[0-9a-f]{16}$/
const DIGITS = /^[0-9]+$/

/** The path of one page of pending corrections. */
export function correctionsPath(options: PendingCorrectionsOptions, after: string | null): string {
  const query: string[] = []
  const add = (name: string, value: string | null | undefined) => {
    if (value !== undefined && value !== null) query.push(`${name}=${encodeURIComponent(value)}`)
  }
  add('target_lang', options.targetLang)
  add('source_lang', options.sourceLang)
  add('politeness', options.politeness)
  add('after', after)
  add('limit', String(CORRECTIONS_PAGE_SIZE))
  return `review/corrections?${query.join('&')}`
}

/** One page: its valid corrections and the `after` for the next page (null: last page). */
export function parseCorrectionsPage(body: string): { corrections: Correction[]; nextAfter: string | null } {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return { corrections: [], nextAfter: null }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { corrections: [], nextAfter: null }
  const page = data as Record<string, unknown>
  if (!Array.isArray(page.corrections)) return { corrections: [], nextAfter: null }
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const corrections = page.corrections.flatMap((raw: unknown): Correction[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const o = raw as Record<string, unknown>
    const required = [o.id, o.st_id, o.target_lang, o.html]
    if (!required.every((v) => typeof v === 'string' && v !== '')) return []
    if (typeof o.version !== 'string' || !VERSION.test(o.version)) return []
    return [
      {
        id: o.id as string,
        segmentId: o.st_id as string,
        sourceLang: typeof o.source_lang === 'string' && o.source_lang !== '' ? o.source_lang : null,
        targetLang: o.target_lang as string,
        politeness: o.politeness === 'more' || o.politeness === 'less' ? o.politeness : 'default',
        sourceHtml: str(o.source_html),
        previousHtml: str(o.previous_html),
        html: o.html as string,
        status: str(o.status),
        correctedAt: str(o.corrected_at),
        version: o.version,
      },
    ]
  })
  const next = page.next_after
  return { corrections, nextAfter: typeof next === 'string' && DIGITS.test(next) ? next : null }
}

/** The acknowledge request body, byte-exact. */
export function acknowledgeBody(corrections: readonly Pick<Correction, 'id' | 'version'>[]): string {
  return JSON.stringify({ corrections: corrections.map((c) => ({ id: c.id, version: c.version })) })
}

/** The answer's `acknowledged` (0 when it isn't a non-negative integer). */
export function acknowledgedCount(body: string): number {
  try {
    const n = (JSON.parse(body) as { acknowledged?: unknown })?.acknowledged
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

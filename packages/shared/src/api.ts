/**
 * The review API between the Chrome extension and the proxy (`/api/review/…`).
 * Every request carries the review link's token: `Authorization: Bearer <token>`.
 * Documented in docs/DEVELOPER.md → Review API.
 */

export type ReviewRole = 'customer' | 'linguist'
export type SegmentStatus = 'ai' | 'corrected' | 'approved'

/** `GET /api/review/session`: what the review link opens. */
export interface ReviewSession {
  site: {
    id: number
    name: string
    /** Origin of the site, e.g. `https://www.example.ch`. */
    origin: string
    /** Supertext source language (`de`), or null when the CMS lets Supertext detect it. */
    sourceLang: string | null
    /** Path prefix of the source language version (`/de/`), or null if not set. */
    sourcePrefix: string | null
  }
  /** Supertext target language of this link (`fr-CH`). */
  targetLang: string
  /** Path prefix of the target language version (`/fr/`), or null if not set. */
  targetPrefix: string | null
  role: ReviewRole
  expiresAt: string
}

/** One text read from the page. */
export interface PageText {
  /** Normalized with `htmlToText(element.innerHTML)` or `normalizeText(attributeValue)`. */
  text: string
  /** Where it came from, for the panel only (not used for matching). */
  kind?: 'text' | 'attribute' | 'meta' | 'title' | 'json-ld'
}

/** `POST /api/review/match` body. At most 2000 texts of at most 5000 characters each. */
export interface MatchRequest {
  /** `translation`: texts of the translated page; `source`: texts of the original page. */
  side: 'translation' | 'source'
  texts: PageText[]
}

export interface SegmentSummary {
  id: number
  sourceHtml: string
  /** The translation the proxy serves: the correction if there is one, else the stored AI translation. */
  translationHtml: string
  status: SegmentStatus
  /** Times the segment was requested by the integration. */
  hits: number
  lastSeenAt: string
}

export interface MatchResponse {
  /** One entry per text, same order: the matching segments (several when the same text has several sources). */
  results: { index: number; segments: SegmentSummary[] }[]
}

export interface SegmentEvent {
  kind: 'correction' | 'approval' | 'comment' | 'ai'
  html: string | null
  comment: string | null
  reviewer: string | null
  role: ReviewRole | null
  at: string
}

/** `GET /api/review/segments/{id}`. */
export interface SegmentDetail extends SegmentSummary {
  aiHtml: string
  /** The AI's answer the last time Supertext translated the segment again (whole-document uploads), if it differs. */
  aiLatestHtml: string | null
  history: SegmentEvent[]
}

/** `PUT /api/review/segments/{id}`: a correction. Exactly one of `html` and `text`. */
export interface CorrectionRequest {
  /** Corrected HTML; may only use the source's tags. */
  html?: string
  /** Corrected plain text (escaped by the proxy); only for segments without tags. */
  text?: string
  reviewer: string
  comment?: string
}

/** `POST /api/review/segments/{id}/approve` and `/comment`. */
export interface ReviewerAction {
  reviewer: string
  comment?: string
}

/** Error body of every review API error: `{ error: <code>, detail? }`. */
export interface ReviewError {
  error:
    | 'unauthorized'
    | 'link_expired'
    | 'link_revoked'
    | 'not_found'
    | 'invalid_request'
    | 'markup_not_allowed'
    | 'rate_limited'
    | 'unavailable'
  detail?: string
}

/**
 * Client for the proxy's review API (`/api/review/…`, types in
 * packages/shared/src/api.ts). Runs in the background service worker, which
 * has the proxy's host permission, so CORS doesn't matter.
 */
import type {
  CorrectionRequest,
  MatchResponse,
  PageText,
  ReviewError,
  ReviewSession,
  SegmentDetail,
  SegmentSummary,
} from '@supertext-review/shared'
import type { ReviewLink } from './link'

export const MAX_TEXTS_PER_REQUEST = 2000

export class ReviewApiError extends Error {
  constructor(
    readonly code: ReviewError['error'] | 'network',
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class ReviewApi {
  constructor(
    private readonly link: ReviewLink,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.link.proxy}/api/review/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.link.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
      })
    } catch {
      throw new ReviewApiError('network', 0)
    }
    const body = (await res.json().catch(() => null)) as unknown
    if (!res.ok) {
      const e = body as Partial<ReviewError> | null
      throw new ReviewApiError(e?.error ?? 'unavailable', res.status, e?.detail)
    }
    return body as T
  }

  session(): Promise<ReviewSession> {
    return this.call('session')
  }

  /** Matches any number of texts, in requests of at most 2000. Same order as given. */
  async match(side: 'translation' | 'source', texts: string[]): Promise<SegmentSummary[][]> {
    const out: SegmentSummary[][] = []
    for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_REQUEST) {
      const chunk: PageText[] = texts.slice(i, i + MAX_TEXTS_PER_REQUEST).map((text) => ({ text }))
      const r = await this.call<MatchResponse>('match', { method: 'POST', body: JSON.stringify({ side, texts: chunk }) })
      for (const result of r.results) out[i + result.index] = result.segments
    }
    return texts.map((_, i) => out[i] ?? [])
  }

  segment(id: number): Promise<SegmentDetail> {
    return this.call(`segments/${id}`)
  }

  correct(id: number, body: CorrectionRequest): Promise<SegmentDetail> {
    return this.call(`segments/${id}`, { method: 'PUT', body: JSON.stringify(body) })
  }

  approve(id: number, reviewer: string, comment?: string): Promise<SegmentDetail> {
    return this.call(`segments/${id}/approve`, { method: 'POST', body: JSON.stringify({ reviewer, comment }) })
  }

  comment(id: number, reviewer: string, comment: string): Promise<SegmentDetail> {
    return this.call(`segments/${id}/comment`, { method: 'POST', body: JSON.stringify({ reviewer, comment }) })
  }
}

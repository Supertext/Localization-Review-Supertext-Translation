/** Fixed-window rate limiter in memory (one app instance on Railway; enough for abuse protection). */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True if the request is allowed. With `count` false, only checks (for limits counted on failure). */
  take(key: string, now = Date.now(), count = true): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (!count) return true;
      if (this.hits.size > 10_000) this.prune(now);
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    if (count) h.count++;
    return count ? h.count <= this.limit : h.count < this.limit;
  }

  private prune(now: number): void {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * The caller's IP: the first X-Forwarded-For entry. Railway's edge writes the
 * header (measurements show a client-sent X-Forwarded-For doesn't reach the
 * app), while the last entry can be a shared CDN hop, which would put every
 * visitor in one bucket. Railway doesn't document this as a guarantee, so
 * limits keyed on it are backed by a global limit (see actions.ts → login).
 */
export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown';
}

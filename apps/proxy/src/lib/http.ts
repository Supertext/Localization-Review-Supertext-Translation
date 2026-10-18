/** Small response helpers shared by the API routes. */

const NO_STORE = { 'Cache-Control': 'no-store' };

/** JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers },
  });
}

/** An error in the Supertext API's shape: `{ "error_code": … }`. */
export function apiError(status: number, errorCode: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error_code: errorCode, ...extra });
}

/** CORS for the review API: token in the Authorization header, no cookies, so any origin may call it. */
export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
};

export function reviewJson(status: number, body: unknown): Response {
  return json(status, body, CORS);
}

export function reviewError(status: number, error: string, detail?: string): Response {
  return reviewJson(status, detail ? { error, detail } : { error });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Reads the request body, at most `maxBytes` (also without Content-Length):
 * null when it is larger. Stops reading as soon as the cap is passed.
 */
export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > maxBytes) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

/** Reads a JSON body of at most `max` bytes; null if it isn't valid JSON, too large or contains NUL. */
export async function readJson(req: Request, max: number): Promise<unknown | null> {
  const body = await readBody(req, max);
  if (body === null) return null;
  const text = new TextDecoder().decode(body);
  // Postgres text can't hold NUL, and no reviewer types it.
  if (text.includes('\u0000') || text.includes('\\u0000')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Wraps an API route so an unexpected failure (database down, a bug) answers
 * in the API's own error shape instead of an HTML error page: 503, which the
 * Supertext SDK reports as "service unavailable". The error itself goes to
 * the log, never to the caller.
 */
export function guarded<A extends unknown[]>(kind: 'v1' | 'review', handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error(`proxy: ${kind} request failed:`, error instanceof Error ? error.message : 'unknown error');
      return kind === 'v1' ? apiError(503, 'SERVICE_UNAVAILABLE') : reviewError(503, 'unavailable');
    }
  };
}

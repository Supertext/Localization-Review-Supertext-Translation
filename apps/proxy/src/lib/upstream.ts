/**
 * Calls to the real Supertext AI file translation API v1 (or the stand-in in
 * tests), always with the integration's own API key. Answers come back as
 * they are, so errors reach the integration unchanged.
 */
import { AUTH_PREFIX } from './tenant';
import { APP_VERSION } from './version';

export const LIVE_BASE_URL = 'https://api.supertext.com/v1/';
const TIMEOUT_MS = 30_000;

export function baseUrl(): string {
  const url = process.env.SUPERTEXT_API_URL || LIVE_BASE_URL;
  return url.endsWith('/') ? url : `${url}/`;
}

export interface UpstreamResponse {
  status: number;
  contentType: string;
  retryAfter: string | null;
  body: string;
}

function userAgent(integration: string): string {
  return `${integration ? integration + ' ' : ''}supertext-review-proxy/${APP_VERSION}`.slice(0, 500);
}

async function call(path: string, key: string, ua: string, init: RequestInit = {}): Promise<UpstreamResponse> {
  const res = await fetch(baseUrl() + path, {
    ...init,
    headers: { Authorization: AUTH_PREFIX + key, Accept: 'application/json', 'User-Agent': userAgent(ua), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'application/json',
    retryAfter: res.headers.get('retry-after'),
    body: await res.text(),
  };
}

/** Turns an upstream answer into the proxy's answer, unchanged. */
export function passThrough(r: UpstreamResponse): Response {
  const headers: Record<string, string> = { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' };
  if (r.retryAfter) headers['Retry-After'] = r.retryAfter;
  return new Response(r.body, { status: r.status, headers });
}

/** 502 in Supertext's error shape when Supertext can't be reached at all. */
export function unreachable(): Response {
  return new Response(JSON.stringify({ error_code: 'UPSTREAM_UNREACHABLE' }), {
    status: 502,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function features(key: string, ua: string, query: string): Promise<UpstreamResponse> {
  return call(`features${query}`, key, ua);
}

export interface UploadFields {
  targetLang: string | null;
  sourceLang: string | null;
  politeness: string | null;
  fileName: string;
}

export function upload(key: string, ua: string, fields: UploadFields, html: string): Promise<UpstreamResponse> {
  const form = new FormData();
  if (fields.targetLang !== null) form.set('target_lang', fields.targetLang);
  if (fields.sourceLang !== null) form.set('source_lang', fields.sourceLang);
  if (fields.politeness !== null) form.set('politeness', fields.politeness);
  // The file part's Content-Type must be exactly text/html (no charset), or Supertext answers 415.
  form.set('file', new Blob([html], { type: 'text/html' }), fields.fileName);
  return call('translate/ai/file', key, ua, { method: 'POST', body: form });
}

export function status(key: string, ua: string, fileId: string): Promise<UpstreamResponse> {
  return call(`translate/ai/file/${encodeURIComponent(fileId)}/status`, key, ua);
}

export function translation(key: string, ua: string, fileId: string): Promise<UpstreamResponse> {
  return call(`translate/ai/file/${encodeURIComponent(fileId)}/translation`, key, ua, { headers: { Accept: 'text/html' } });
}

export function remove(key: string, ua: string, fileId: string): Promise<UpstreamResponse> {
  return call(`translate/ai/file/${encodeURIComponent(fileId)}`, key, ua, { method: 'DELETE' });
}

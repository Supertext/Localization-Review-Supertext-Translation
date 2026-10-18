import { headers } from 'next/headers';

/**
 * The proxy's public base URL (no trailing slash), for review links and the
 * plugin setting shown in the UI: REVIEW_PUBLIC_URL, else the request's host.
 */
export async function publicUrl(): Promise<string> {
  const configured = process.env.REVIEW_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Railway healthcheck: the app is up and reaches its database. */
export async function GET() {
  try {
    await db()`SELECT 1`;
    return new Response('ok\n', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  } catch {
    return new Response('database unreachable\n', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

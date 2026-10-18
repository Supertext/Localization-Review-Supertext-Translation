// Shared setup for the integration tests: a fresh database, the Supertext stand-in,
// and a fetch that dispatches to the proxy's route handlers (no HTTP server needed).
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import postgres from 'postgres';
// Plain JavaScript (vendored from Supertext-API-SDK-and-Guide).
import { createStandIn } from '../stand-in/stand-in.mjs';

export const SERVER = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export interface Harness {
  standInUrl: string;
  standIn: http.Server;
  stats(): Promise<{ submitted: number; deleted: number; polls: number; downloads: number; lastUpload: Record<string, unknown> | null }>;
  /** fetch() that routes proxy URLs (http://proxy.test/…) to the route handlers. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
}

/** Fresh database `name`, migrations applied twice (the second run must be a no-op), stand-in started. */
export async function setUp(name: string): Promise<Harness> {
  const admin = postgres(SERVER, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  process.env.DATABASE_URL = SERVER;
  process.env.REVIEW_DB_NAME = name;
  for (let i = 0; i < 2; i++) execFileSync('node', ['scripts/migrate.mjs'], { env: process.env, stdio: 'pipe' });

  const standIn: http.Server = createStandIn({ samplesDir: new URL('../fixtures', import.meta.url).pathname });
  await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve));
  const standInUrl = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}/v1/`;
  process.env.SUPERTEXT_API_URL = standInUrl;

  const features = await import('../../src/app/v1/features/route');
  const file = await import('../../src/app/v1/translate/ai/file/route');
  const one = await import('../../src/app/v1/translate/ai/file/[id]/route');
  const status = await import('../../src/app/v1/translate/ai/file/[id]/status/route');
  const translation = await import('../../src/app/v1/translate/ai/file/[id]/translation/route');
  const session = await import('../../src/app/api/review/session/route');
  const match = await import('../../src/app/api/review/match/route');
  const segment = await import('../../src/app/api/review/segments/[id]/route');
  const approve = await import('../../src/app/api/review/segments/[id]/approve/route');
  const comment = await import('../../src/app/api/review/segments/[id]/comment/route');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const dispatch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    const method = req.method;
    let m: RegExpMatchArray | null;
    if (path === '/v1/features' && method === 'GET') return features.GET(req);
    if (path === '/v1/translate/ai/file' && method === 'POST') return file.POST(req);
    if ((m = path.match(/^\/v1\/translate\/ai\/file\/([^/]+)\/status$/)) && method === 'GET') return status.GET(req, params(m[1]!));
    if ((m = path.match(/^\/v1\/translate\/ai\/file\/([^/]+)\/translation$/)) && method === 'GET') return translation.GET(req, params(m[1]!));
    if ((m = path.match(/^\/v1\/translate\/ai\/file\/([^/]+)$/)) && method === 'DELETE') return one.DELETE(req, params(m[1]!));
    if (path === '/api/review/session' && method === 'GET') return session.GET(req);
    if (path === '/api/review/match' && method === 'POST') return match.POST(req);
    if ((m = path.match(/^\/api\/review\/segments\/([^/]+)$/))) {
      if (method === 'GET') return segment.GET(req, params(m[1]!));
      if (method === 'PUT') return segment.PUT(req, params(m[1]!));
    }
    if ((m = path.match(/^\/api\/review\/segments\/([^/]+)\/approve$/)) && method === 'POST') return approve.POST(req, params(m[1]!));
    if ((m = path.match(/^\/api\/review\/segments\/([^/]+)\/comment$/)) && method === 'POST') return comment.POST(req, params(m[1]!));
    return new Response('no route in the test dispatcher', { status: 599 });
  };

  return {
    standIn,
    standInUrl,
    async stats() {
      return (await fetch(standInUrl.replace(/v1\/$/, '__stand-in/stats'))).json();
    },
    fetch: dispatch,
    async close() {
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
      const { db } = await import('../../src/lib/db');
      await db().end();
    },
  };
}

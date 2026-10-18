import { guarded, preflight } from '@/lib/http';
import { authenticate, session } from '@/lib/review';

export const dynamic = 'force-dynamic';

/** What a review link opens: site, target language, role. */
export const GET = guarded('review', async function GET(req: Request) {
  const ctx = await authenticate(req);
  return ctx instanceof Response ? ctx : session(ctx);
});

export const OPTIONS = preflight;

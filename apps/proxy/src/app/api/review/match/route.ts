import { guarded, preflight } from '@/lib/http';
import { authenticate, match } from '@/lib/review';

export const dynamic = 'force-dynamic';

/** Which page texts are known segments. */
export const POST = guarded('review', async function POST(req: Request) {
  const ctx = await authenticate(req);
  return ctx instanceof Response ? ctx : match(req, ctx);
});

export const OPTIONS = preflight;

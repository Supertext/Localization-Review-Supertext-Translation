import { guarded, preflight } from '@/lib/http';
import { approve, authenticate } from '@/lib/review';

export const dynamic = 'force-dynamic';

/** Marks the served translation as approved. */
export const POST = guarded('review', async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authenticate(req);
  return ctx instanceof Response ? ctx : approve(req, (await params).id, ctx);
});

export const OPTIONS = preflight;

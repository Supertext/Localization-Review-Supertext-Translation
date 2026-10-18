import { guarded, preflight } from '@/lib/http';
import { authenticate, correct, segmentDetail } from '@/lib/review';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** One segment with its history. */
export const GET = guarded('review', async function GET(req: Request, { params }: Ctx) {
  const ctx = await authenticate(req);
  return ctx instanceof Response ? ctx : segmentDetail((await params).id, ctx);
});

/** A correction. */
export const PUT = guarded('review', async function PUT(req: Request, { params }: Ctx) {
  const ctx = await authenticate(req);
  return ctx instanceof Response ? ctx : correct(req, (await params).id, ctx);
});

export const OPTIONS = preflight;

import { guarded, preflight } from '@/lib/http';
import { addComment, authenticate } from '@/lib/review';

export const dynamic = 'force-dynamic';

/** A comment without changing the translation. */
export const POST = guarded('review', async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authenticate(req);
  return ctx instanceof Response ? ctx : addComment(req, (await params).id, ctx);
});

export const OPTIONS = preflight;

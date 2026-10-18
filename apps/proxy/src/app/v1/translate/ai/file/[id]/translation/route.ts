import { guarded } from '@/lib/http';
import { jobTranslation } from '@/lib/jobs';
import { readCaller } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** `GET translate/ai/file/{id}/translation`. */
export const GET = guarded('v1', async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = readCaller(req);
  if (caller instanceof Response) return caller;
  return jobTranslation((await ctx.params).id, caller);
});

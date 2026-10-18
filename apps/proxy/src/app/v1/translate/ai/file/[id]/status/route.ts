import { guarded } from '@/lib/http';
import { jobStatus } from '@/lib/jobs';
import { readCaller } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** `GET translate/ai/file/{id}/status`. */
export const GET = guarded('v1', async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = readCaller(req);
  if (caller instanceof Response) return caller;
  return jobStatus((await ctx.params).id, caller);
});

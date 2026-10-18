import { guarded } from '@/lib/http';
import { deleteJob } from '@/lib/jobs';
import { readCaller } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** `DELETE translate/ai/file/{id}`. */
export const DELETE = guarded('v1', async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = readCaller(req);
  if (caller instanceof Response) return caller;
  return deleteJob((await ctx.params).id, caller);
});

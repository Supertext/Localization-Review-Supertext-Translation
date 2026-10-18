import { guarded } from '@/lib/http';
import { createJob } from '@/lib/jobs';
import { readCaller } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** `POST translate/ai/file`: see src/lib/jobs.ts. */
export const POST = guarded('v1', async function POST(req: Request) {
  const caller = readCaller(req);
  if (caller instanceof Response) return caller;
  return createJob(req, caller);
});

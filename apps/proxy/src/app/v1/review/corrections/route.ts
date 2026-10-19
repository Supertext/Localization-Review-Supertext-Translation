import { pendingCorrections } from '@/lib/corrections';
import { guarded } from '@/lib/http';
import { verifyKey } from '@/lib/jobs';
import { readCaller } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** `GET /v1/review/corrections`: corrections the integration hasn't written into the CMS yet (proxy only). */
export const GET = guarded('v1', async function GET(req: Request) {
  const caller = readCaller(req);
  if (caller instanceof Response) return caller;
  const refused = await verifyKey(caller);
  if (refused) return refused;
  return pendingCorrections(req, caller);
});

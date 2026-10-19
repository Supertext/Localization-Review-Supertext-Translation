import { acknowledgeCorrections } from '@/lib/corrections';
import { guarded } from '@/lib/http';
import { verifyKey } from '@/lib/jobs';
import { readCaller } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** `POST /v1/review/corrections/acknowledge`: corrections the integration wrote into the CMS (proxy only). */
export const POST = guarded('v1', async function POST(req: Request) {
  const caller = readCaller(req);
  if (caller instanceof Response) return caller;
  const refused = await verifyKey(caller);
  if (refused) return refused;
  return acknowledgeCorrections(req, caller);
});

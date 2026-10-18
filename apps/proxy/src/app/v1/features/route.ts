import { guarded } from '@/lib/http';
import { recordIntegration } from '@/lib/integrations';
import { touchTenant, markVerified, readCaller } from '@/lib/tenant';
import * as upstream from '@/lib/upstream';

export const dynamic = 'force-dynamic';

/** `GET features`: passed through to Supertext (cost-free; the plugins' API key check). */
export const GET = guarded('v1', async function GET(req: Request) {
  const caller = readCaller(req);
  if (caller instanceof Response) return caller;
  const query = new URL(req.url).search;
  let r: upstream.UpstreamResponse;
  try {
    r = await upstream.features(caller.key, caller.userAgent, query);
  } catch {
    return upstream.unreachable();
  }
  if (r.status === 200) {
    markVerified(caller.tenant);
    await touchTenant(caller);
    await recordIntegration(caller, 'key_check');
  }
  return upstream.passThrough(r);
});

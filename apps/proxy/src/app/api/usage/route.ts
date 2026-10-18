import { listIntegrations } from '@/lib/admin-store';
import { guarded, json } from '@/lib/http';
import { checkUsageToken, usageTokenConfigured } from '@/lib/usage-token';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/usage`: which plugins use the proxy, per tenant, for the Commando
 * Center. Plugin, version, SDK, tenant label and counters only: never
 * translations, review sites or links. `Authorization: Bearer <REVIEW_USAGE_TOKEN>`.
 * Protocol: docs/DEVELOPER.md → Usage API.
 */
export const GET = guarded('v1', async function GET(req: Request) {
  if (!usageTokenConfigured()) return json(404, { error: 'not_configured' });
  if (!checkUsageToken(req.headers.get('authorization'))) return json(401, { error: 'unauthorized' });
  const rows = await listIntegrations();
  return json(200, {
    schema: 1,
    generatedAt: new Date().toISOString(),
    integrations: rows.map((r) => ({
      tenant: r.tenant,
      tenantLabel: r.tenant_label,
      plugin: r.plugin,
      pluginVersion: r.plugin_version,
      sdk: r.sdk,
      keyChecks: r.key_checks,
      uploads: r.uploads,
      memoryAnswers: r.memory_answers,
      firstSeenAt: new Date(r.first_seen_at).toISOString(),
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
    })),
  });
});

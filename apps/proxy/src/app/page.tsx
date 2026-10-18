import Link from 'next/link';
import { listTenants } from '@/lib/admin-store';
import { requireAuth } from '@/lib/session';
import { tenantName, when } from '@/components/format';

export const dynamic = 'force-dynamic';

export default async function TenantsPage() {
  await requireAuth();
  const tenants = await listTenants();
  const segments = tenants.reduce((n, t) => n + t.segments, 0);
  const corrected = tenants.reduce((n, t) => n + t.corrected, 0);
  return (
    <>
      <h1>Tenants</h1>
      <p className="sub">
        Every Supertext API key that sent translations through the proxy. The key itself is never stored: a tenant is its SHA-256
        fingerprint. Give tenants a label so you recognize the customer.
      </p>
      <div className="stats">
        <div className="stat"><div className="n">{tenants.length}</div><div className="l">Tenants</div></div>
        <div className="stat"><div className="n">{segments}</div><div className="l">Segments in the memory</div></div>
        <div className="stat"><div className="n">{corrected}</div><div className="l">Reviewed (corrected or approved)</div></div>
      </div>
      <div className="card table-wrap">
        {tenants.length === 0 ? (
          <p className="empty">No translations yet. Point a plugin&apos;s Supertext API URL at this proxy&apos;s <code>/v1/</code>.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Tenant</th><th>Languages</th><th>Segments</th><th>Reviewed</th><th>Last request</th><th>Integration</th></tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.fingerprint}>
                  <td><Link className="link" href={`/tenants/${t.fingerprint}`}>{tenantName(t)}</Link></td>
                  <td className="url">{t.languages.join(', ') || '–'}</td>
                  <td>{t.segments}</td>
                  <td>{t.corrected}</td>
                  <td>{when(t.last_seen_at)}</td>
                  <td className="url small muted">{t.last_user_agent || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

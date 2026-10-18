import Link from 'next/link';
import { listSites, listTenants } from '@/lib/admin-store';
import { requireAuth } from '@/lib/session';
import { tenantName } from '@/components/format';
import { createSiteAction } from '../actions';
import SiteFields from './site-fields';

export const dynamic = 'force-dynamic';

export default async function SitesPage() {
  await requireAuth();
  const [sites, tenants] = await Promise.all([listSites(), listTenants()]);
  return (
    <>
      <h1>Review sites</h1>
      <p className="sub">
        A review site is a customer&apos;s website whose translations people review with the Chrome extension. It belongs to one tenant
        (the API key its plugin uses). Review links give access to one target language.
      </p>
      <div className="card table-wrap" style={{ marginBottom: 24 }}>
        {sites.length === 0 ? (
          <p className="empty">No review sites yet.</p>
        ) : (
          <table>
            <thead><tr><th>Site</th><th>Address</th><th>Tenant</th><th>Languages</th><th>Active links</th></tr></thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td><Link className="link" href={`/sites/${s.id}`}>{s.name}</Link></td>
                  <td className="url">{s.origin}</td>
                  <td>{tenantName({ label: s.tenant_label, fingerprint: s.tenant })}</td>
                  <td className="mono small">{s.source_lang || 'auto'} → {Object.keys(s.target_prefixes).join(', ') || '–'}</td>
                  <td>{s.links}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>New review site</h2>
      {tenants.length === 0 ? (
        <p className="notice">A site needs a tenant. Tenants appear after the first translation through the proxy.</p>
      ) : (
        <form action={createSiteAction} className="card form-body" style={{ maxWidth: 720 }}>
          <label>
            Tenant
            <select name="tenant" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {tenants.map((t) => <option key={t.fingerprint} value={t.fingerprint}>{tenantName(t)}</option>)}
            </select>
          </label>
          <SiteFields />
          <button type="submit" className="primary">Create site</button>
        </form>
      )}
    </>
  );
}

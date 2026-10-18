import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSite, listLinks, ROLES } from '@/lib/admin-store';
import { linksConfigured, tokenFor } from '@/lib/review-links';
import { publicUrl } from '@/lib/public-url';
import { requireAuth } from '@/lib/session';
import ConfirmButton from '@/components/confirm-button';
import { tenantName, when } from '@/components/format';
import { createLinkAction, deleteSiteAction, revokeLinkAction, updateSiteAction } from '../../actions';
import SiteFields from '../site-fields';

export const dynamic = 'force-dynamic';

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAuth();
  const siteId = Number((await params).id);
  const site = Number.isInteger(siteId) && siteId > 0 ? await getSite(siteId) : null;
  if (!site) notFound();
  const [links, base] = await Promise.all([listLinks(siteId), publicUrl()]);
  const now = Date.now();
  return (
    <>
      <p className="small"><Link className="link" href="/sites">Review sites</Link></p>
      <h1>{site.name}</h1>
      <p className="sub">
        <a className="link" href={site.origin} target="_blank" rel="noopener">{site.origin}</a> · tenant{' '}
        <Link className="link" href={`/tenants/${site.tenant}`}>{tenantName({ label: site.tenant_label, fingerprint: site.tenant })}</Link>
      </p>

      <h2>Review links</h2>
      {!linksConfigured() && (
        <p className="notice error">Review links need <code>REVIEW_LINK_SECRET</code> (at least 32 characters) in the service variables.</p>
      )}
      <div className="card table-wrap" style={{ marginBottom: 16 }}>
        {links.length === 0 ? (
          <p className="empty">No links yet.</p>
        ) : (
          <table>
            <thead><tr><th>For</th><th>Language</th><th>Role</th><th>Valid until</th><th>Corrections</th><th>Last used</th><th>Link</th><th /></tr></thead>
            <tbody>
              {links.map((l) => {
                const active = !l.revoked_at && new Date(l.expires_at).getTime() > now;
                const token = tokenFor(Number(l.id));
                return (
                  <tr key={l.id}>
                    <td>{l.label || '–'}</td>
                    <td className="mono">{l.target_lang}</td>
                    <td>{l.role}</td>
                    <td>{l.revoked_at ? <span className="badge bad">revoked</span> : active ? when(l.expires_at) : <span className="badge outdated">expired</span>}</td>
                    <td>{l.corrections}</td>
                    <td>{when(l.last_used_at)}</td>
                    <td className="url mono small">{active && token ? `${base}/review#${token}` : '–'}</td>
                    <td>
                      {active && (
                        <form action={revokeLinkAction}>
                          <input type="hidden" name="id" value={l.id} />
                          <input type="hidden" name="site_id" value={siteId} />
                          <ConfirmButton message="Revoke this link? Whoever has it can no longer review.">Revoke</ConfirmButton>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <form action={createLinkAction} className="card form-body" style={{ maxWidth: 720 }}>
        <input type="hidden" name="site_id" value={siteId} />
        <div className="grid2" style={{ gap: 12 }}>
          <label>
            Target language
            <input name="target_lang" required maxLength={40} placeholder="fr-CH" list="target-langs" />
            <datalist id="target-langs">
              {Object.keys(site.target_prefixes).map((l) => <option key={l} value={l} />)}
            </datalist>
          </label>
          <label>
            Role
            <select name="role" defaultValue="customer">
              {ROLES.map((r) => <option key={r} value={r}>{r === 'customer' ? 'Customer' : 'Supertext linguist'}</option>)}
            </select>
          </label>
          <label>
            For (name or note)
            <input name="label" maxLength={200} placeholder="Marketing team" />
          </label>
          <label>
            Valid for (days)
            <input name="days" type="number" min={1} max={365} defaultValue={30} />
          </label>
        </div>
        <button type="submit" className="primary">Create link</button>
      </form>

      <h2>Site settings</h2>
      <form action={updateSiteAction} className="card form-body" style={{ maxWidth: 720 }}>
        <input type="hidden" name="id" value={siteId} />
        <SiteFields site={site} />
        <button type="submit" className="primary">Save</button>
      </form>
      <form action={deleteSiteAction} style={{ marginTop: 16 }}>
        <input type="hidden" name="id" value={siteId} />
        <ConfirmButton message="Delete this site and all its links? The translation memory stays.">Delete site</ConfirmButton>
      </form>
    </>
  );
}

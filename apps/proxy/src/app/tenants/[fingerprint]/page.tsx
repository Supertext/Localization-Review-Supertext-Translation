import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { SegmentStatus } from '@supertext-review/shared';
import { getTenant, listIntegrations, listSegments } from '@/lib/admin-store';
import IntegrationsTable from '@/components/integrations-table';
import { requireAuth } from '@/lib/session';
import { SegmentText, StatusBadge, tenantName, when } from '@/components/format';
import { saveTenant } from '../../actions';

export const dynamic = 'force-dynamic';

const STATUSES: SegmentStatus[] = ['ai', 'corrected', 'approved'];

export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ fingerprint: string }>;
  searchParams: Promise<{ lang?: string; status?: string; q?: string }>;
}) {
  await requireAuth();
  const { fingerprint } = await params;
  const f = await searchParams;
  const tenant = await getTenant(fingerprint);
  if (!tenant) notFound();
  const status = STATUSES.includes(f.status as SegmentStatus) ? (f.status as SegmentStatus) : undefined;
  const [segments, integrations] = await Promise.all([
    listSegments(fingerprint, { targetLang: f.lang || undefined, status, q: f.q || undefined }),
    listIntegrations(fingerprint),
  ]);
  return (
    <>
      <p className="small"><Link className="link" href="/">Tenants</Link></p>
      <h1>{tenantName(tenant)}</h1>
      <p className="sub">
        Key fingerprint <code>{tenant.fingerprint}</code> · first request {when(tenant.first_seen_at)} · last {when(tenant.last_seen_at)}
      </p>

      <div className="grid2">
        <form action={saveTenant} className="card form-body">
          <input type="hidden" name="fingerprint" value={tenant.fingerprint} />
          <label>
            Label (customer)
            <input name="label" defaultValue={tenant.label} maxLength={200} placeholder="e.g. Kunde AG, www.kunde.ch" />
          </label>
          <label>
            Notes
            <textarea name="notes" defaultValue={tenant.notes} maxLength={5000} />
          </label>
          <button type="submit" className="primary">Save</button>
        </form>
        <div className="card">
          <dl className="facts">
            <dt>Segments</dt><dd>{tenant.segments}</dd>
            <dt>Reviewed</dt><dd>{tenant.corrected}</dd>
            <dt>Target languages</dt><dd>{tenant.languages.join(', ') || '–'}</dd>
            <dt>Integration</dt><dd className="small">{tenant.last_user_agent || '–'}</dd>
          </dl>
          <p className="small muted" style={{ padding: '0 20px 16px', margin: 0 }}>
            To let people review this tenant&apos;s site, <Link className="link" href="/sites">add a review site</Link> and create review links.
          </p>
        </div>
      </div>

      <h2>Plugins</h2>
      <div className="card table-wrap">
        <IntegrationsTable rows={integrations} showTenant={false} />
      </div>

      <h2>Translation memory</h2>
      <form className="filters">
        <select name="lang" defaultValue={f.lang ?? ''} aria-label="Target language">
          <option value="">All languages</option>
          {tenant.languages.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <select name="status" defaultValue={status ?? ''} aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s === 'ai' ? 'AI only' : s}</option>)}
        </select>
        <input type="search" name="q" defaultValue={f.q ?? ''} placeholder="Search source or translation" />
        <button type="submit">Filter</button>
      </form>
      <div className="card table-wrap">
        {segments.length === 0 ? (
          <p className="empty">No segments match.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Languages</th><th>Source</th><th>Translation served</th><th>Status</th><th>Requests</th><th>Last request</th></tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr key={s.id}>
                  <td className="mono small">{s.source_lang || 'auto'} → {s.target_lang}{s.politeness ? ` (${s.politeness})` : ''}</td>
                  <td className="url"><SegmentText html={s.source_html} /></td>
                  <td className="url">
                    <SegmentText html={s.correction_html ?? s.ai_html} />
                    {s.correction_html && <div className="small muted">AI: <SegmentText html={s.ai_html} max={200} /></div>}
                    {s.ai_latest_html && <div className="small muted">Newer AI answer: <SegmentText html={s.ai_latest_html} max={200} /></div>}
                  </td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{s.hits}</td>
                  <td>{when(s.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {segments.length >= 200 && <p className="small muted">Showing the 200 most recent. Narrow the filter to see others.</p>}
    </>
  );
}

import Link from 'next/link';
import type { IntegrationRow } from '@/lib/admin-store';
import { tenantName, when } from './format';

/** Plugins that used the proxy, one row per customer (tenant) and plugin. */
export default function IntegrationsTable({ rows, showTenant = true }: { rows: IntegrationRow[]; showTenant?: boolean }) {
  if (rows.length === 0) return <p className="empty">No plugin has used the proxy yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Plugin</th>
          <th>Version</th>
          {showTenant && <th>Tenant</th>}
          <th>Uploads</th>
          <th>From the memory</th>
          <th>Key checks</th>
          <th>First request</th>
          <th>Last request</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.tenant}|${r.plugin}`}>
            <td className="url">
              {r.plugin ? (
                <a className="link" href={`https://github.com/Supertext/${encodeURIComponent(r.plugin)}`} target="_blank" rel="noopener">{r.plugin}</a>
              ) : (
                <span className="muted" title={r.user_agent}>Unknown{r.user_agent ? ` (${r.user_agent.slice(0, 60)})` : ''}</span>
              )}
              {r.sdk && <div className="small muted">SDK: {r.sdk}</div>}
            </td>
            <td className="mono">{r.plugin_version || '–'}</td>
            {showTenant && (
              <td>
                <Link className="link" href={`/tenants/${r.tenant}`}>{tenantName({ label: r.tenant_label, fingerprint: r.tenant })}</Link>
              </td>
            )}
            <td>{r.uploads}</td>
            <td>{r.uploads ? `${r.memory_answers} (${Math.round((100 * r.memory_answers) / r.uploads)} %)` : '–'}</td>
            <td>{r.key_checks}</td>
            <td>{when(r.first_seen_at)}</td>
            <td>{when(r.last_seen_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

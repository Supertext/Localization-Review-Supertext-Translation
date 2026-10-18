import { htmlToText } from '@supertext-review/shared';

const TZ = process.env.REVIEW_TIMEZONE || 'Europe/Zurich';

export function when(d: Date | string | null): string {
  if (!d) return '–';
  return new Intl.DateTimeFormat('de-CH', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));
}

/** A tenant's name for the UI: its label, else the start of the fingerprint. */
export function tenantName(t: { label: string; fingerprint: string }): string {
  return t.label || `Key ${t.fingerprint.slice(0, 10)}…`;
}

/** Segment HTML shown as text (never rendered as HTML: it comes from customers' sites). */
export function SegmentText({ html, max = 400 }: { html: string; max?: number }) {
  const text = htmlToText(html);
  return <span title={html}>{text.length > max ? text.slice(0, max) + '…' : text || '–'}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'ai' ? 'unknown' : 'current';
  const label = status === 'ai' ? 'AI' : status === 'corrected' ? 'corrected' : 'approved';
  return <span className={`badge ${cls}`}>{label}</span>;
}

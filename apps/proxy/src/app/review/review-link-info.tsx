'use client';

import { useEffect, useState } from 'react';
import type { ReviewError, ReviewSession } from '@supertext-review/shared';

const MESSAGES: Record<string, string> = {
  unauthorized: 'This review link is not valid. Check that you copied all of it, or ask Supertext for a new one.',
  link_expired: 'This review link has expired. Ask Supertext or your contact for a new one.',
  link_revoked: 'This review link was revoked. Ask Supertext or your contact for a new one.',
  unavailable: 'The review service is not available right now. Try again in a few minutes.',
};

type State = { kind: 'loading' } | { kind: 'ok'; session: ReviewSession } | { kind: 'error'; message: string };

export default function ReviewLinkInfo() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const token = decodeURIComponent(window.location.hash.replace(/^#/, ''));
    if (!token) {
      setState({ kind: 'error', message: MESSAGES.unauthorized! });
      return;
    }
    fetch('/api/review/session', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(async (res) => {
        if (res.ok) return setState({ kind: 'ok', session: (await res.json()) as ReviewSession });
        const body = (await res.json().catch(() => ({ error: 'unavailable' }))) as ReviewError;
        setState({ kind: 'error', message: MESSAGES[body.error] ?? MESSAGES.unavailable! });
      })
      .catch(() => setState({ kind: 'error', message: MESSAGES.unavailable! }));
  }, []);

  if (state.kind === 'loading') return <p className="muted">Checking the link…</p>;
  if (state.kind === 'error') return <p className="notice error">{state.message}</p>;
  const s = state.session;
  const until = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.expiresAt));
  return (
    <>
      <dl className="facts" style={{ padding: '0 0 16px' }}>
        <dt>Website</dt>
        <dd>{s.site.name} ({s.site.origin})</dd>
        <dt>Language</dt>
        <dd className="mono">{s.targetLang}</dd>
        <dt>Valid until</dt>
        <dd>{until}</dd>
      </dl>
      <ol style={{ paddingLeft: 20, margin: 0, display: 'grid', gap: 8 }}>
        <li>Install the <strong>Supertext Localization Review</strong> extension in Google Chrome.</li>
        <li>Open its side panel and paste this page&apos;s address (the whole link in the address bar).</li>
        <li>Open the website: the original and the translation appear side by side, and you can correct texts directly.</li>
      </ol>
      <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
        Keep this link to yourself: anyone who has it can change the translations of this website until it expires.
      </p>
    </>
  );
}

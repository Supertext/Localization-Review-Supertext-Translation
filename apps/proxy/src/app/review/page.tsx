import type { Metadata } from 'next';
import ReviewLinkInfo from './review-link-info';

export const metadata: Metadata = { title: 'Review translations · Supertext', referrer: 'no-referrer' };

/**
 * The page a review link opens: `/review#<token>`. The token is in the
 * fragment, so it never reaches server logs; the page reads it in the browser
 * and asks the review API what the link is for.
 */
export default function ReviewLinkPage() {
  return (
    <div className="card login" style={{ maxWidth: 620 }}>
      <h1>Review translations</h1>
      <ReviewLinkInfo />
    </div>
  );
}

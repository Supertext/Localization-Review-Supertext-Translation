import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The usage API is read by the Commando Center with a shared token,
 * REVIEW_USAGE_TOKEN (at least 32 characters). Without it the API is off.
 */
export const MIN_USAGE_TOKEN_LENGTH = 32;

export function usageTokenConfigured(): boolean {
  return (process.env.REVIEW_USAGE_TOKEN ?? '').length >= MIN_USAGE_TOKEN_LENGTH;
}

export function checkUsageToken(header: string | null): boolean {
  const token = process.env.REVIEW_USAGE_TOKEN ?? '';
  if (token.length < MIN_USAGE_TOKEN_LENGTH || !header?.startsWith('Bearer ')) return false;
  const a = createHash('sha256').update(header.slice(7).trim()).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

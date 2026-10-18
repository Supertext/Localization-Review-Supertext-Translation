/**
 * Review links look like `https://<proxy>/review#<link id>.<hmac>`. The
 * extension keeps the proxy's origin (for the review API) and the token.
 */
export interface ReviewLink {
  /** Origin of the proxy, e.g. `https://localizationreview-production.up.railway.app`. */
  proxy: string
  token: string
}

const TOKEN = /^[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{43}$/

/** Parses a pasted review link; null if it isn't one. Only https, except for local test proxies. */
export function parseReviewLink(input: string): ReviewLink | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
  if (url.pathname.replace(/\/+$/, '') !== '/review') return null
  const token = decodeURIComponent(url.hash.replace(/^#/, ''))
  if (!TOKEN.test(token)) return null
  return { proxy: url.origin, token }
}

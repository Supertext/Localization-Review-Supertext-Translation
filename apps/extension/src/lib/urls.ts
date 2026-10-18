/**
 * The page in the other language: the review site's path prefixes (`/en/` ↔
 * `/de/`) are swapped. Sites without prefixes return null; the reviewer then
 * opens the other page by hand.
 */
export interface SitePrefixes {
  origin: string
  sourcePrefix: string | null
  targetPrefix: string | null
}

export type Side = 'source' | 'translation'

/** Which side a URL of the site shows, by its prefix; null if neither (or the URL is elsewhere). */
export function sideOf(url: string, site: SitePrefixes): Side | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.origin !== site.origin) return null
  const t = site.targetPrefix
  const s = site.sourcePrefix
  // The longer prefix first, so "/" as source prefix doesn't swallow "/de/".
  const checks: [Side, string | null][] = (t?.length ?? 0) >= (s?.length ?? 0) ? [['translation', t], ['source', s]] : [['source', s], ['translation', t]]
  for (const [side, prefix] of checks) if (prefix && (u.pathname === prefix.replace(/\/$/, '') || u.pathname.startsWith(prefix))) return side
  return null
}

/** The same page on the other side, keeping the rest of the path, the query and the hash. */
export function counterpart(url: string, site: SitePrefixes): { side: Side; url: string } | null {
  const side = sideOf(url, site)
  if (!side || !site.sourcePrefix || !site.targetPrefix) return null
  const u = new URL(url)
  const from = side === 'source' ? site.sourcePrefix : site.targetPrefix
  const to = side === 'source' ? site.targetPrefix : site.sourcePrefix
  const path = u.pathname === from.replace(/\/$/, '') ? '' : u.pathname.slice(from.length)
  u.pathname = to + path
  return { side: side === 'source' ? 'translation' : 'source', url: u.toString() }
}

/** The start page of a side, for opening the site from the panel. */
export function startUrl(site: SitePrefixes, side: Side): string {
  const prefix = side === 'source' ? site.sourcePrefix : site.targetPrefix
  return site.origin + (prefix ?? '/')
}

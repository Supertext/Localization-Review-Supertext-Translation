/**
 * Text normalization shared by the proxy and the Chrome extension. The proxy
 * stores every segment's plain text normalized with {@link htmlToText}; the
 * extension normalizes what it reads from the page the same way, so matching
 * is a plain string comparison. Change it only together with a migration that
 * recomputes the stored texts.
 */
import { decodeEntities, tokenize } from './html'

export { decodeEntities }

/**
 * The form texts are compared in: Unicode NFC, NUL, soft hyphens and
 * zero-width characters removed, every run of whitespace (no-break spaces
 * included) one space, trimmed. Case and punctuation stay.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u0000­​‌‍⁠﻿]/g, '')
    .replace(/[\s  -   　]+/g, ' ')
    .trim()
}

/** Tags that separate words: `<br>` and block elements count as a space. */
const BREAKS = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'table', 'section', 'article', 'blockquote', 'hr', 'dt', 'dd'])

/** Elements whose content is never shown as text. */
const INVISIBLE = new Set(['script', 'style', 'template', 'noscript'])

/** Plain, normalized text of an HTML fragment: tags removed (`<br>` and block tags count as a space), entities decoded. */
export function htmlToText(html: string): string {
  let out = ''
  let invisible = 0
  tokenize(html, (t) => {
    if (t.type === 'text') {
      if (invisible === 0) out += decodeEntities(html.slice(t.start, t.end))
    } else if (t.type === 'raw') {
      // textarea, title, … content is text; script and style aren't.
      if (!INVISIBLE.has(t.element) && invisible === 0) out += html.slice(t.start, t.end)
    } else if (t.type === 'start') {
      if (INVISIBLE.has(t.name) && !t.selfClosing) invisible++
      if (BREAKS.has(t.name)) out += ' '
    } else if (t.type === 'end') {
      if (INVISIBLE.has(t.name) && invisible > 0) invisible--
      if (BREAKS.has(t.name)) out += ' '
    }
  })
  return normalizeText(out)
}

/** Normalized source HTML of a segment, the key of the translation memory: line endings and outer whitespace only. */
export function normalizeSegmentHtml(html: string): string {
  const s = html.replace(/\r\n?/g, '\n')
  // Trim by hand: `/[ ]+$/` is quadratic on long runs of spaces.
  const ws = (c: number) => c === 32 || c === 9 || c === 10 || c === 12
  let a = 0
  let b = s.length
  while (a < b && ws(s.charCodeAt(a))) a++
  while (b > a && ws(s.charCodeAt(b - 1))) b--
  return s.slice(a, b).normalize('NFC')
}

/** True if a segment has no text worth translating (empty, whitespace, only tags). */
export function isBlankSegment(html: string): boolean {
  return htmlToText(html) === ''
}

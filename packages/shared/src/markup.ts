/**
 * Markup rules for human corrections. A reviewer may change the words, never
 * the markup: corrections end up on customers' websites, so no reviewer, and
 * no stolen review link, may add scripts, styles, event handlers, new links or
 * markup that breaks the page.
 *
 * A correction is checked with the same linear tokenizer the proxy uses:
 * - only start tags that occur as real tags (not inside comments or raw text)
 *   in the segment's source or its AI translation, with exactly the same
 *   attributes (name and decoded value, in the same order), and at most as
 *   often as there;
 * - never script-like or embedding elements, whatever the source contains;
 * - well-nested: every element closed in order, end tags without attributes;
 * - no comments, declarations, unfinished tags or stray `<` / `>`;
 * - no markup smuggled in as entities (`&lt;img …&gt;`), which integrations
 *   decode when they read the segment as plain text;
 * - `<br>` may always be added or removed.
 */
import { decodeEntities, tokens, VOID, type Attribute } from './html'

export interface MarkupProblem {
  code: 'unknown_tag' | 'forbidden_tag' | 'unbalanced' | 'end_tag_attributes' | 'stray_angle_bracket' | 'comment' | 'encoded_markup' | 'too_long'
  /** The offending tag or snippet, at most 80 characters. */
  detail: string
}

export const MAX_CORRECTION_CHARACTERS = 100_000

/** Never allowed in a correction, even if the source has them. */
export const FORBIDDEN = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'template', 'textarea',
  'title', 'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'svg', 'math', 'base', 'link', 'meta', 'form',
  'input', 'button', 'select', 'option', 'html', 'head', 'body', 'portal', 'slot', 'dialog',
])

const ATTR_NAME = /^[a-z_:][a-z0-9_:.-]*$/

/** Canonical form of a start tag: name and attributes (name, decoded value) as written. */
function canonical(name: string, attrs: Attribute[]): string {
  return JSON.stringify([name, attrs.map((a) => [a.name, a.hasValue ? a.value : null])])
}

/** How often each start tag (canonical form) occurs as a real tag in `html`. */
export function tagCounts(html: string): Map<string, number> {
  const out = new Map<string, number>()
  // Tags inside noscript, template or any forbidden element are inert (or never allowed): skip them.
  const inert: string[] = []
  for (const t of tokens(html)) {
    if (t.type === 'end') {
      if (inert.length > 0 && inert[inert.length - 1] === t.name) inert.pop()
      continue
    }
    if (t.type !== 'start') continue
    if (inert.length > 0) {
      if (!t.selfClosing && !VOID.has(t.name) && (FORBIDDEN.has(t.name) || t.name === 'noscript')) inert.push(t.name)
      continue
    }
    if (FORBIDDEN.has(t.name) || t.name === 'noscript') {
      if (!t.selfClosing && !VOID.has(t.name)) inert.push(t.name)
      continue
    }
    const key = canonical(t.name, t.attrs)
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

/** The names of the real start tags in `html` other than `<br>` (for "does this segment have markup?"). */
export function markupTags(html: string): string[] {
  return tokens(html).flatMap((t) => (t.type === 'start' && t.name !== 'br' ? [t.name] : []))
}

const short = (s: string) => (s.length > 80 ? s.slice(0, 77) + '…' : s)

/**
 * Checks a correction against the segment's source (and optionally its AI
 * translation, whose attributes may be translated). Returns the problems
 * found; empty means fine.
 */
export function checkCorrection(sourceHtml: string, correctionHtml: string, aiHtml?: string): MarkupProblem[] {
  if (correctionHtml.length > MAX_CORRECTION_CHARACTERS) return [{ code: 'too_long', detail: String(correctionHtml.length) }]
  const allowed = tagCounts(sourceHtml)
  if (aiHtml !== undefined) {
    for (const [k, n] of tagCounts(aiHtml)) allowed.set(k, Math.max(allowed.get(k) ?? 0, n))
  }
  const used = new Map<string, number>()
  const problems: MarkupProblem[] = []
  const stack: string[] = []
  const add = (code: MarkupProblem['code'], detail: string) => {
    if (problems.length < 20) problems.push({ code, detail: short(detail) })
  }

  for (const t of tokens(correctionHtml)) {
    const raw = correctionHtml.slice(t.start, t.end)
    switch (t.type) {
      case 'text': {
        if (/[<>]/.test(raw)) add('stray_angle_bracket', raw)
        // Entities that decode to markup, e.g. &lt;img src=x onerror=…&gt;.
        if (/<[A-Za-z!/?]/.test(decodeEntities(raw))) add('encoded_markup', raw)
        // Entities browsers decode without a semicolon or with odd forms (&lt img, &#60 …): only
        // complete, known entities may start with & followed by a letter or #.
        else if (hasIncompleteEntity(raw)) add('encoded_markup', raw)
        break
      }
      case 'comment':
      case 'declaration':
        add('comment', raw)
        break
      case 'unterminated':
        add('stray_angle_bracket', raw)
        break
      case 'raw':
        // Only after a forbidden raw-text start tag, which is already reported.
        break
      case 'start': {
        if (t.name === 'br' && t.attrs.length === 0) break
        if (FORBIDDEN.has(t.name)) {
          add('forbidden_tag', raw)
        } else {
          const names = new Set<string>()
          const badAttrs = t.attrs.some((a) => !ATTR_NAME.test(a.name) || names.size === names.add(a.name).size)
          const key = canonical(t.name, t.attrs)
          const n = (used.get(key) ?? 0) + 1
          used.set(key, n)
          if (badAttrs || n > (allowed.get(key) ?? 0)) add('unknown_tag', raw)
        }
        if (VOID.has(t.name)) break
        if (t.selfClosing) {
          add('unbalanced', raw)
          break
        }
        // Refused tags stay on the stack too, so their end tags aren't reported again.
        stack.push(t.name)
        break
      }
      case 'end': {
        if (t.hasAttributes) add('end_tag_attributes', raw)
        if (t.name === 'br' || VOID.has(t.name)) {
          add('unbalanced', raw)
          break
        }
        if (stack[stack.length - 1] !== t.name) {
          add('unbalanced', raw)
          break
        }
        stack.pop()
        break
      }
    }
  }
  if (stack.length > 0) add('unbalanced', `<${stack[stack.length - 1]}> not closed`)
  return problems
}

/** True if text has an `&` + letter or `#` that isn't a complete entity the decoder knows. */
function hasIncompleteEntity(raw: string): boolean {
  const re = /&(?=[#A-Za-z])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const rest = raw.slice(m.index, m.index + 40)
    if (decodeEntities(rest).startsWith('&') && !rest.startsWith('&amp;')) return true
  }
  return false
}

/** Escapes plain text for use as HTML (a correction typed as plain text). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

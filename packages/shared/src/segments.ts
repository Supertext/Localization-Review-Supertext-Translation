/**
 * Finds the segments of a Supertext document: every element carrying
 * `data-st-id`. Supertext translates each such element on its own, so each one
 * is a unit of the translation memory.
 *
 * Built on the linear tokenizer in ./html: attributes are parsed (a
 * `data-st-id` inside another attribute's value doesn't count, a quoted `>`
 * doesn't end the tag), comments and raw text never count as markup, and
 * start and end tags are paired in one pass with a stack, so the time is
 * linear in the document's length whatever it contains.
 */
import { decodeEntities, RAW_TEXT, tokenize, VOID, type Token } from './html'
import { FORBIDDEN } from './markup'

export interface ScannedSegment {
  /** The `data-st-id` value. */
  id: string
  /** The element's tag name, lower case. */
  tag: string
  /** Index of `<` of the start tag. */
  start: number
  /** Index right after the start tag's `>`. */
  contentStart: number
  /** Index of `<` of the matching end tag. */
  contentEnd: number
  /** Index right after the end tag's `>`. */
  end: number
  /** The element's inner HTML, untrimmed. */
  inner: string
}

/** Ids the proxy accepts: what integrations use in practice (`0`, `12`, `title`, `field.3`). */
export const SEGMENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/

/**
 * Elements whose text is never shown as page content. noscript and template
 * aren't here on purpose: counting their text as visible only makes the proxy
 * send the whole document, the safe direction (an unclosed one would otherwise
 * hide the rest of the document).
 */
const HIDDEN = new Set(['script', 'style', 'title'])

/** What a head may contain; any other start tag (or `<body>`) ends the head, as in HTML. */
const HEAD_CONTENT = new Set(['title', 'meta', 'link', 'style', 'script', 'noscript', 'base', 'template'])

/**
 * Never segments, even with data-st-id: their content isn't text a reviewer may
 * change (a correction inside `<script data-st-id>` would be code on the site).
 * Documents with such elements go to Supertext whole.
 */
const NOT_SEGMENTS = new Set([...RAW_TEXT, ...FORBIDDEN])

interface Open {
  name: string
  start: Extract<Token, { type: 'start' }>
  /** The data-st-id, when this element is a candidate segment. */
  id: string | null
}

export interface ScannedDocument {
  segments: ScannedSegment[]
  /** True if the document has visible text outside its segments (head, scripts, styles, comments excluded). */
  textOutside: boolean
}

/** One pass over the document: its segments and whether it has text outside them. */
export function scanDocument(html: string): ScannedDocument {
  const stack: Open[] = []
  const count = new Map<string, number>()
  const found: ScannedSegment[] = []
  let hidden = 0
  let inHead = false
  let textOutside = false

  const push = (o: Open) => {
    stack.push(o)
    count.set(o.name, (count.get(o.name) ?? 0) + 1)
    if (HIDDEN.has(o.name)) hidden++
  }
  const pop = (): Open => {
    const o = stack.pop()!
    count.set(o.name, count.get(o.name)! - 1)
    if (HIDDEN.has(o.name)) hidden--
    return o
  }
  // Inside an element that is a segment (the first one wins; segments don't nest).
  let segmentDepth = 0
  const isSegment = (o: Open) => o.id !== null && segmentDepth === 0

  tokenize(html, (t) => {
    switch (t.type) {
      case 'text':
        if (!textOutside && segmentDepth === 0 && hidden === 0 && !inHead && /[^\t\n\f\r  ]/.test(decodeEntities(html.slice(t.start, t.end)))) {
          textOutside = true
        }
        return
      case 'raw':
        // Raw text of textarea, iframe, … outside segments is visible content too.
        if (!textOutside && segmentDepth === 0 && hidden === 0 && !inHead && !HIDDEN.has(t.element) && /\S/.test(html.slice(t.start, t.end))) {
          textOutside = true
        }
        return
      case 'start': {
        if (t.name === 'head') {
          inHead = true
          return
        }
        if (inHead && !HEAD_CONTENT.has(t.name)) inHead = false
        if (t.selfClosing || VOID.has(t.name)) return
        const attr = t.attrs.find((a) => a.name === 'data-st-id')
        const id = attr && SEGMENT_ID.test(attr.value) && !NOT_SEGMENTS.has(t.name) ? attr.value : null
        const o: Open = { name: t.name, start: t, id }
        if (isSegment(o)) segmentDepth = 1
        else if (segmentDepth > 0) segmentDepth++
        push(o)
        return
      }
      case 'end': {
        if (t.name === 'head') {
          inHead = false
          return
        }
        if (!count.get(t.name)) return // nothing open with that name: ignore
        // Close everything up to the nearest open element with this name (amortized linear).
        for (;;) {
          const o = pop()
          if (segmentDepth > 0) {
            segmentDepth--
            if (segmentDepth === 0 && o.id !== null && o.name === t.name) {
              found.push({
                id: o.id,
                tag: o.name,
                start: o.start.start,
                contentStart: o.start.end,
                contentEnd: t.start,
                end: t.end,
                inner: html.slice(o.start.end, t.start),
              })
            }
          }
          if (o.name === t.name) break
        }
        return
      }
      default:
        return
    }
  })

  // The first element per id wins.
  const seen = new Set<string>()
  const segments = found.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
  return { segments, textOutside }
}

/**
 * The segments in document order. The first element per id wins; elements
 * without a closing tag, nested inside another segment or with an id outside
 * {@link SEGMENT_ID} are skipped (they stay part of the surrounding text).
 */
export function scanSegments(html: string): ScannedSegment[] {
  return scanDocument(html).segments
}

/** True if the document has visible text outside its segments: Supertext would translate it too. */
export function hasTextOutsideSegments(html: string): boolean {
  return scanDocument(html).textOutside
}

/**
 * Replaces the inner HTML of segments. `replacement(id)` returns the new inner
 * HTML, `undefined` to keep the element as it is, or `null` to drop the
 * element entirely (the integration then sees the segment as missing).
 */
export function replaceSegments(html: string, segments: readonly ScannedSegment[], replacement: (id: string) => string | null | undefined): string {
  let out = ''
  let pos = 0
  for (const s of segments) {
    const value = replacement(s.id)
    if (value === undefined) continue
    out += value === null ? html.slice(pos, s.start) : html.slice(pos, s.contentStart) + value + html.slice(s.contentEnd, s.end)
    pos = s.end
  }
  return out + html.slice(pos)
}

/**
 * True if `inner` can be put inside a segment element and read back unchanged,
 * i.e. it doesn't close the element or swallow what follows. The proxy only
 * stores and serves HTML that passes this.
 */
export function isSafeSegmentContent(inner: string): boolean {
  const probe = `<div data-st-id="0">${inner}</div><div data-st-id="1">x</div>`
  const s = scanSegments(probe)
  return s.length === 2 && s[0]!.inner === inner && s[1]!.inner === 'x'
}

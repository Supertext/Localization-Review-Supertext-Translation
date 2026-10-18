/**
 * Reads the texts of a page the way the proxy stores them, so matching is an
 * exact comparison: a block's text is `htmlToText(innerHTML)` of the element
 * that holds it (without nested blocks), an attribute's text is
 * `normalizeText(value)`. Runs in the content script; pure DOM, no chrome APIs.
 */
import { htmlToText, normalizeText } from '@supertext-review/shared'

/** Elements that hold a paragraph of text (what a plugin sends as one segment). */
export const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DT', 'DD', 'FIGCAPTION', 'BLOCKQUOTE', 'CAPTION', 'LABEL',
  'BUTTON', 'SUMMARY', 'LEGEND', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'ADDRESS',
  'PRE', 'OPTION', 'BODY',
])

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'CANVAS'])

/** Attribute the extension marks its own UI with; never collected. */
export const OWN_UI = 'data-st-review-ui'

export interface Block {
  el: Element
  text: string
}

export type InvisibleKind = 'title' | 'meta' | 'attribute' | 'json-ld'

export interface Invisible {
  text: string
  kind: InvisibleKind
  /** Where it is: `<title>`, `meta og:description`, `img alt`, `JSON-LD headline`. */
  where: string
  el?: Element
}

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP.has(e.tagName.toUpperCase()) || e.hasAttribute(OWN_UI)) return true
  }
  return false
}

function blockOf(node: Node): Element | null {
  for (let e = node.parentElement; e; e = e.parentElement) if (BLOCK_TAGS.has(e.tagName.toUpperCase())) return e
  return null
}

/** The block's own text: its HTML without nested blocks, as the proxy normalizes it. */
function ownText(el: Element): string {
  const nested = [...el.querySelectorAll('*')].some((d) => BLOCK_TAGS.has(d.tagName.toUpperCase()))
  if (!nested) return htmlToText(el.innerHTML)
  const clone = el.cloneNode(true) as Element
  for (const d of [...clone.querySelectorAll('*')]) if (BLOCK_TAGS.has(d.tagName.toUpperCase())) d.remove()
  return htmlToText(clone.innerHTML)
}

/** Every block that directly holds visible text, in document order, with its normalized text. */
export function collectBlocks(doc: Document, limit = 5000): Block[] {
  const body = doc.body
  if (!body) return []
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */)
  const seen = new Set<Element>()
  const out: Block[] = []
  for (let n = walker.nextNode(); n && out.length < limit; n = walker.nextNode()) {
    if (!n.nodeValue || !/\S/.test(n.nodeValue)) continue
    const block = blockOf(n)
    if (!block || seen.has(block) || skipped(block)) continue
    seen.add(block)
    const text = ownText(block)
    if (text && text.length <= 5000) out.push({ el: block, text })
  }
  return out
}

const META = /^(description|keywords|og:title|og:description|og:image:alt|og:site_name|twitter:title|twitter:description|twitter:image:alt)$/i
const ATTRIBUTES: [selector: string, attr: string, where: string][] = [
  ['img[alt]', 'alt', 'img alt'],
  ['area[alt]', 'alt', 'area alt'],
  ['input[type=image][alt]', 'alt', 'input alt'],
  ['[title]', 'title', 'title'],
  ['[aria-label]', 'aria-label', 'aria-label'],
  ['[placeholder]', 'placeholder', 'placeholder'],
  ['input[type=submit][value], input[type=button][value], input[type=reset][value]', 'value', 'button value'],
]
const JSON_LD_KEYS = new Set(['name', 'description', 'headline', 'alternateName', 'alternativeHeadline', 'text', 'caption', 'abstract', 'slogan'])

function jsonLdTexts(value: unknown, out: Invisible[], depth = 0): void {
  if (depth > 12 || out.length > 500) return
  if (Array.isArray(value)) for (const v of value) jsonLdTexts(v, out, depth + 1)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && JSON_LD_KEYS.has(k)) {
        const text = normalizeText(v)
        if (text && text.length <= 5000) out.push({ text, kind: 'json-ld', where: `JSON-LD ${k}` })
      } else jsonLdTexts(v, out, depth + 1)
    }
  }
}

/** Texts a visitor doesn't see on the page: title, meta tags, attributes, structured data. */
export function collectInvisible(doc: Document, limit = 2000): Invisible[] {
  const out: Invisible[] = []
  const add = (raw: string | null, kind: InvisibleKind, where: string, el?: Element) => {
    const text = normalizeText(raw ?? '')
    if (text && text.length <= 5000 && out.length < limit && !out.some((o) => o.text === text && o.where === where)) out.push({ text, kind, where, el })
  }
  add(doc.title, 'title', '<title>')
  for (const m of doc.querySelectorAll('meta[content]')) {
    const name = m.getAttribute('name') ?? m.getAttribute('property') ?? ''
    if (META.test(name)) add(m.getAttribute('content'), 'meta', `meta ${name.toLowerCase()}`)
  }
  for (const [selector, attr, where] of ATTRIBUTES) {
    for (const el of doc.querySelectorAll(selector)) if (!skipped(el)) add(el.getAttribute(attr), 'attribute', where, el)
  }
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonLdTexts(JSON.parse(s.textContent ?? ''), out)
    } catch {
      // Broken JSON-LD: nothing to collect.
    }
  }
  return out.slice(0, limit)
}

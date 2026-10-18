/**
 * A small HTML tokenizer: one pass, linear time, no backtracking regexes, so
 * a crafted 1 MB document can't stall the proxy. It follows the parts of the
 * HTML tokenizer that matter for Supertext documents and corrections:
 *
 * - attribute values may contain `>` when quoted; only HTML whitespace
 *   (tab, LF, FF, CR, space) separates attributes;
 * - comments (`<!-- … -->`), doctypes and other `<!…>` / `<?…>` constructs are
 *   single tokens, their content is never markup;
 * - the content of raw-text elements (script, style, textarea, title, …) is
 *   one raw token up to the matching end tag;
 * - a tag that never ends (end of input inside it) becomes one `unterminated`
 *   token running to the end, as browsers drop it.
 */

export type Token =
  | { type: 'text'; start: number; end: number }
  | { type: 'raw'; start: number; end: number; element: string }
  | { type: 'comment'; start: number; end: number }
  | { type: 'declaration'; start: number; end: number }
  | { type: 'start'; start: number; end: number; name: string; attrs: Attribute[]; selfClosing: boolean }
  | { type: 'end'; start: number; end: number; name: string; hasAttributes: boolean }
  | { type: 'unterminated'; start: number; end: number }

export interface Attribute {
  /** Lower case. */
  name: string
  /** Decoded value ('' when the attribute has none). */
  value: string
  /** True when written with `=`. */
  hasValue: boolean
}

/** Elements whose content is text until their end tag. */
export const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'])

/** Elements that never have content or an end tag. */
export const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen'])

const isWs = (c: number) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

/** Tokenizes `html`. `emit` gets every token in order. */
export function tokenize(html: string, emit: (t: Token) => void): void {
  const n = html.length
  let i = 0
  let textStart = 0
  const flushText = (until: number) => {
    if (until > textStart) emit({ type: 'text', start: textStart, end: until })
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    const c1 = html.charCodeAt(lt + 1)

    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) {
      flushText(lt)
      if (html.startsWith('<!--', lt)) {
        // As browsers: `<!-->` and `<!--->` end at once; otherwise the first `-->` or `--!>`.
        let end: number
        if (html.charCodeAt(lt + 4) === 62) end = lt + 5
        else if (html.startsWith('->', lt + 4)) end = lt + 6
        else {
          const a = html.indexOf('-->', lt + 4)
          const b = html.indexOf('--!>', lt + 4)
          const close = a < 0 ? b : b < 0 ? a : Math.min(a, b)
          end = close < 0 ? n : close === b ? close + 4 : close + 3
        }
        emit({ type: 'comment', start: lt, end })
        i = textStart = end
      } else {
        const close = html.indexOf('>', lt + 2)
        const end = close < 0 ? n : close + 1
        emit({ type: 'declaration', start: lt, end })
        i = textStart = end
      }
      continue
    }

    const closing = c1 === 47 /* / */
    const nameStart = closing ? lt + 2 : lt + 1
    if (!isAlpha(html.charCodeAt(nameStart))) {
      // `<` not starting a tag is text (`a < b`, `</ >`).
      i = lt + 1
      continue
    }

    flushText(lt)
    let j = nameStart
    while (j < n && !isWs(html.charCodeAt(j)) && html.charCodeAt(j) !== 47 && html.charCodeAt(j) !== 62) j++
    const name = html.slice(nameStart, j).toLowerCase()
    const attrs: Attribute[] = []
    let selfClosing = false
    let terminated = false

    // Attributes, until `>`.
    while (j < n) {
      const c = html.charCodeAt(j)
      if (isWs(c)) {
        j++
        continue
      }
      if (c === 62 /* > */) {
        j++
        terminated = true
        break
      }
      if (c === 47 /* / */) {
        if (html.charCodeAt(j + 1) === 62) {
          selfClosing = true
          j += 2
          terminated = true
          break
        }
        j++
        continue
      }
      // Attribute name: up to whitespace, `/`, `>` or `=` (a leading `=` belongs to the name).
      const an = j
      j++
      while (j < n) {
        const d = html.charCodeAt(j)
        if (isWs(d) || d === 47 || d === 62 || d === 61) break
        j++
      }
      const attrName = html.slice(an, j).toLowerCase()
      let k = j
      while (k < n && isWs(html.charCodeAt(k))) k++
      if (html.charCodeAt(k) !== 61 /* = */) {
        attrs.push({ name: attrName, value: '', hasValue: false })
        continue
      }
      k++
      while (k < n && isWs(html.charCodeAt(k))) k++
      const q = html.charCodeAt(k)
      if (q === 34 || q === 39) {
        const close = html.indexOf(q === 34 ? '"' : "'", k + 1)
        if (close < 0) {
          j = n // end of input inside the value
          break
        }
        attrs.push({ name: attrName, value: decodeEntities(html.slice(k + 1, close)), hasValue: true })
        j = close + 1
      } else {
        const vs = k
        while (k < n && !isWs(html.charCodeAt(k)) && html.charCodeAt(k) !== 62) k++
        attrs.push({ name: attrName, value: decodeEntities(html.slice(vs, k)), hasValue: true })
        j = k
      }
    }

    if (!terminated) {
      emit({ type: 'unterminated', start: lt, end: n })
      i = textStart = n
      break
    }

    if (closing) {
      emit({ type: 'end', start: lt, end: j, name, hasAttributes: attrs.length > 0 })
      i = textStart = j
      continue
    }

    emit({ type: 'start', start: lt, end: j, name, attrs, selfClosing })
    i = textStart = j
    if (RAW_TEXT.has(name) && !selfClosing) {
      // Content up to `</name` followed by whitespace, `/` or `>` (case-insensitive), or the end.
      const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi')
      re.lastIndex = j
      const m = re.exec(html)
      const contentEnd = m ? m.index : n
      if (contentEnd > j) emit({ type: 'raw', start: j, end: contentEnd, element: name })
      i = textStart = contentEnd
    }
  }
  flushText(n)
}

/** All tokens as an array. */
export function tokens(html: string): Token[] {
  const out: Token[] = []
  tokenize(html, (t) => out.push(t))
  return out
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', deg: '°', times: '×', thinsp: ' ', ensp: ' ', emsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ograve: 'ò', oacute: 'ó', ocirc: 'ô',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', ccedil: 'ç', ntilde: 'ñ',
  Agrave: 'À', Aacute: 'Á', Egrave: 'È', Eacute: 'É', Ccedil: 'Ç',
}

// Leading zeros as browsers accept them; otherwise bounded quantifiers: linear.
const ENTITY = /&(#[xX]0*[0-9a-fA-F]{1,6}|#0*[0-9]{1,7}|[A-Za-z]{2,8});/g

/** Decodes numeric entities and the common named ones; unknown entities stay as they are. */
export function decodeEntities(text: string): string {
  if (text.indexOf('&') < 0) return text
  return text.replace(ENTITY, (match, entity: string) => {
    if (entity[0] !== '#') return NAMED[entity] ?? match
    const hex = entity[1] === 'x' || entity[1] === 'X'
    const cp = parseInt(entity.slice(hex ? 2 : 1).replace(/^0+(?=.)/, ''), hex ? 16 : 10)
    const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
    return valid ? String.fromCodePoint(cp) : match
  })
}

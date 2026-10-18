/**
 * The side panel: connects with a review link, finds (or opens) the original
 * and the translated tab, matches their texts through the review API, and lets
 * the reviewer correct, approve and comment. All page and proxy content is
 * shown as text (textContent / textarea values), never as HTML.
 */
import { htmlToText, markupTags, type ReviewSession, type SegmentDetail, type SegmentStatus, type SegmentSummary } from '@supertext-review/shared'
import { ReviewApi, ReviewApiError } from './lib/api'
import { parseReviewLink, type ReviewLink } from './lib/link'
import type { FromContent, ScanResult, ToContent } from './lib/messages'
import { openBeside, splitPartner } from './lib/split'
import { counterpart, sideOf, startUrl, type Side, type SitePrefixes } from './lib/urls'

const t = (key: string, ...subs: (string | number)[]): string => chrome.i18n.getMessage(key, subs.map(String)) || key

// ---------- State ----------

interface TabScan {
  tabId: number
  scan: ScanResult
  /** Per block: matching segments ([] = unmatched). */
  matches: SegmentSummary[][]
  /** Translation side: per block, true when the text is a known original (not translated). */
  untranslated: boolean[]
  invisibleMatches: SegmentSummary[][]
}

interface State {
  link: ReviewLink | null
  session: ReviewSession | null
  reviewer: string
  sync: boolean
  reviewMode: boolean
  tabs: Partial<Record<Side, number>>
  scans: Partial<Record<Side, TabScan>>
  list: 'page' | 'unmatched' | 'invisible'
  selected: number | null
  detail: SegmentDetail | null
  /** Unmatched block selected on the page (index into the translation scan). */
  unmatched: number | null
  busy: boolean
  error: string | null
  notice: string | null
  needsSitePermission: boolean
}

const state: State = {
  link: null,
  session: null,
  reviewer: '',
  sync: true,
  reviewMode: true,
  tabs: {},
  scans: {},
  list: 'page',
  selected: null,
  detail: null,
  unmatched: null,
  busy: false,
  error: null,
  notice: null,
  needsSitePermission: false,
}

let api: ReviewApi | null = null

/**
 * The browser window whose tabs are reviewed: the side panel's own window, or
 * `?window=<id>` when the panel page is opened in a window of its own (tests).
 */
const reviewWindow = Number(new URLSearchParams(location.search).get('window')) || chrome.windows.WINDOW_ID_CURRENT
const activeTab = async () => (await chrome.tabs.query({ active: true, windowId: reviewWindow }))[0]
/** Ignore "scrolled" from a tab we just scrolled ourselves (no ping-pong). */
const scrolledByUs = new Map<number, number>()

const prefixes = (): SitePrefixes | null =>
  state.session ? { origin: state.session.site.origin, sourcePrefix: state.session.site.sourcePrefix, targetPrefix: state.session.targetPrefix } : null

// ---------- Errors ----------

function messageFor(e: unknown): string {
  if (e instanceof ReviewApiError) {
    if (e.code === 'unauthorized') return t('errorUnauthorized')
    if (e.code === 'link_expired') return t('errorExpired')
    if (e.code === 'link_revoked') return t('errorRevoked')
    if (e.code === 'network' || e.code === 'unavailable') return t('errorNetwork')
    if (e.code === 'markup_not_allowed') return t('errorMarkup')
    return t('errorGeneric', e.detail ?? e.code)
  }
  return t('errorGeneric', e instanceof Error ? e.message : String(e))
}

async function attempt(fn: () => Promise<void>): Promise<void> {
  state.error = null
  state.busy = true
  render()
  try {
    await fn()
  } catch (e) {
    state.error = messageFor(e)
  } finally {
    state.busy = false
    render()
  }
}

// ---------- Storage ----------

async function load(): Promise<void> {
  const s = await chrome.storage.local.get(['link', 'reviewer', 'sync', 'reviewMode'])
  state.reviewer = typeof s.reviewer === 'string' ? s.reviewer : ''
  state.sync = s.sync !== false
  state.reviewMode = s.reviewMode !== false
  const link = s.link as ReviewLink | undefined
  if (link?.proxy && link?.token) await connect(link, false)
}

const save = (values: Record<string, unknown>) => chrome.storage.local.set(values).catch(() => {})

// ---------- Connecting ----------

async function connect(link: ReviewLink, interactive: boolean): Promise<void> {
  api = new ReviewApi(link)
  const session = await api.session()
  state.link = link
  state.session = session
  save({ link })
  const site = `${session.site.origin}/*`
  const has = await chrome.permissions.contains({ origins: [site] })
  if (!has && interactive) {
    // Still within the click's user activation in most cases; otherwise the button below asks.
    try {
      state.needsSitePermission = !(await chrome.permissions.request({ origins: [site] }))
    } catch {
      state.needsSitePermission = true
    }
  } else state.needsSitePermission = !has
  if (!state.needsSitePermission) await findTabs()
}

async function allowSite(): Promise<void> {
  if (!state.session) return
  const granted = await chrome.permissions.request({ origins: [`${state.session.site.origin}/*`] })
  if (!granted) {
    state.error = t('errorPermission')
    return
  }
  state.needsSitePermission = false
  await findTabs()
}

async function disconnect(): Promise<void> {
  for (const side of ['source', 'translation'] as Side[]) {
    const id = state.tabs[side]
    if (id !== undefined) await toContent(id, { type: 'clear' }).catch(() => {})
  }
  Object.assign(state, { link: null, session: null, tabs: {}, scans: {}, selected: null, detail: null, unmatched: null, notice: null })
  api = null
  await chrome.storage.local.remove('link')
}

// ---------- Tabs ----------

async function toContent<T = unknown>(tabId: number, msg: ToContent): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>
}

async function inject(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  await toContent(tabId, { type: 'review-mode', on: state.reviewMode })
}

/** The active tab and, if it is in a split view, its partner: which is the original, which the translation. */
async function findTabs(): Promise<void> {
  const p = prefixes()
  if (!p) return
  const active = await activeTab()
  state.tabs = {}
  state.scans = {}
  if (!active?.id || !active.url) return
  const partner = await splitPartner(active)
  const candidates = [active, partner].filter((x): x is chrome.tabs.Tab => !!x?.id && !!x.url && x.url.startsWith(p.origin))
  for (const tab of candidates) {
    const side = sideOf(tab.url!, p)
    if (side && state.tabs[side] === undefined) state.tabs[side] = tab.id!
  }
  // No prefixes: in a split view the tab with more matched translations is the translation.
  if (candidates.length === 2 && Object.keys(state.tabs).length < 2) {
    const counts = await Promise.all(candidates.map(async (tab) => (await scanTab(tab.id!, 'translation')).matches.filter((m) => m.length).length))
    const [a, b] = candidates
    state.tabs = counts[0]! >= counts[1]! ? { translation: a!.id!, source: b!.id! } : { translation: b!.id!, source: a!.id! }
  } else if (candidates.length === 1 && Object.keys(state.tabs).length === 0) {
    state.tabs.translation = candidates[0]!.id!
  }
  await rescan()
}

async function openSideBySide(): Promise<void> {
  const p = prefixes()
  if (!p) return
  const current = await activeTab()
  if (!current?.id) return
  let active: chrome.tabs.Tab = current
  if (!active.url?.startsWith(p.origin)) {
    // Not on the site yet: show the translated start page in this tab.
    active = (await chrome.tabs.update(current.id, { url: startUrl(p, 'translation') })) ?? current
  }
  const url = active.pendingUrl || active.url || ''
  const side = sideOf(url, p)
  const pair = counterpart(url, p)
  if (!side || !pair) {
    state.notice = t('noPrefixHint')
    state.tabs = { translation: active.id! }
    return
  }
  // Original on the left, translation on the right.
  const opened = await openBeside(active, pair.url, side === 'translation' ? 'left' : 'right')
  state.tabs = side === 'translation' ? { translation: active.id!, source: opened.tab.id! } : { source: active.id!, translation: opened.tab.id! }
  state.scans = {}
  state.notice = opened.split ? null : t('splitHint')
  // Both pages load; tabs.onUpdated rescans them when they are complete.
}

// ---------- Scanning and matching ----------

async function scanTab(tabId: number, side: Side): Promise<TabScan> {
  await inject(tabId)
  const scan = await toContent<ScanResult>(tabId, { type: 'scan' })
  const texts = scan.blocks.map((b) => b.text)
  const matches = await api!.match(side, texts)
  let untranslated = texts.map(() => false)
  if (side === 'translation') {
    const missing = texts.map((text, i) => (matches[i]!.length ? null : text))
    const asSource = await api!.match('source', missing.map((x) => x ?? ''))
    untranslated = missing.map((x, i) => x !== null && asSource[i]!.length > 0)
  }
  const invisibleMatches = side === 'translation' ? await api!.match('translation', scan.invisible.map((x) => x.text)) : []
  return { tabId, scan, matches, untranslated, invisibleMatches }
}

async function mark(side: Side): Promise<void> {
  const s = state.scans[side]
  if (!s) return
  const marks = s.scan.blocks.map((b) => {
    const segs = s.matches[b.i] ?? []
    const status: SegmentStatus | 'unmatched' | 'untranslated' = segs.length ? segs[0]!.status : s.untranslated[b.i] ? 'untranslated' : 'unmatched'
    return { i: b.i, segmentIds: segs.map((x) => x.id), status }
  })
  // The original only marks what it has in common with the translation.
  await toContent(s.tabId, { type: 'mark', marks: side === 'source' ? marks.filter((m) => m.segmentIds.length) : marks }).catch(() => {})
}

async function rescan(): Promise<void> {
  if (!api) return
  for (const side of ['translation', 'source'] as Side[]) {
    const id = state.tabs[side]
    if (id === undefined) continue
    try {
      state.scans[side] = await scanTab(id, side)
      await mark(side)
    } catch (e) {
      if (e instanceof ReviewApiError) throw e
      // A page we can't script (chrome://, the web store, a PDF): leave that side empty.
      delete state.scans[side]
    }
  }
  if (state.selected !== null) await highlight(state.selected, false)
}

/** All segments found on the translated page (blocks and invisible texts), first occurrence each. */
function pageSegments(): SegmentSummary[] {
  const s = state.scans.translation
  if (!s) return []
  const seen = new Map<number, SegmentSummary>()
  for (const list of [...s.matches, ...s.invisibleMatches]) for (const seg of list) if (!seen.has(seg.id)) seen.set(seg.id, seg)
  return [...seen.values()]
}

function updateSummary(d: SegmentDetail): void {
  for (const scan of Object.values(state.scans)) {
    for (const list of [...scan!.matches, ...scan!.invisibleMatches]) {
      for (let i = 0; i < list.length; i++) if (list[i]!.id === d.id) list[i] = { ...list[i]!, status: d.status, translationHtml: d.translationHtml }
    }
  }
}

// ---------- Selection ----------

async function highlight(segmentId: number | null, scroll: boolean): Promise<void> {
  for (const side of ['source', 'translation'] as Side[]) {
    const id = state.tabs[side]
    if (id !== undefined) await toContent(id, { type: 'highlight', segmentId, scroll }).catch(() => {})
  }
}

async function select(segmentId: number): Promise<void> {
  state.selected = segmentId
  state.unmatched = null
  state.notice = null
  state.detail = await api!.segment(segmentId)
  await highlight(segmentId, true)
}

async function back(): Promise<void> {
  state.selected = null
  state.detail = null
  state.unmatched = null
  await highlight(null, false)
}

function requireReviewer(): string | null {
  const name = state.reviewer.trim()
  if (!name) {
    state.error = t('errorReviewer')
    return null
  }
  return name
}

async function saveCorrection(value: string, comment: string): Promise<void> {
  const d = state.detail
  const reviewer = requireReviewer()
  if (!d || !reviewer) return
  const html = markupTags(d.sourceHtml).length > 0
  const updated = await api!.correct(d.id, html ? { html: value, reviewer, comment: comment || undefined } : { text: value, reviewer, comment: comment || undefined })
  state.detail = updated
  updateSummary(updated)
  state.notice = t('saved')
  await mark('translation')
  await mark('source')
}

async function approve(comment: string): Promise<void> {
  const d = state.detail
  const reviewer = requireReviewer()
  if (!d || !reviewer) return
  const updated = await api!.approve(d.id, reviewer, comment || undefined)
  state.detail = updated
  updateSummary(updated)
  state.notice = t('approved')
  await mark('translation')
  await mark('source')
}

async function addComment(comment: string): Promise<void> {
  const d = state.detail
  const reviewer = requireReviewer()
  if (!d || !reviewer || !comment.trim()) return
  state.detail = await api!.comment(d.id, reviewer, comment.trim())
  state.notice = t('commented')
}

// ---------- Events from the pages and tabs ----------

chrome.runtime.onMessage.addListener((msg: FromContent, sender) => {
  const tabId = sender.tab?.id
  if (tabId === undefined || !Object.values(state.tabs).includes(tabId)) return
  if (msg.type === 'select') void attempt(() => select(msg.segmentId))
  else if (msg.type === 'select-unmatched' && tabId === state.tabs.translation) {
    state.selected = null
    state.detail = null
    state.unmatched = msg.i
    state.list = 'unmatched'
    render()
  } else if (msg.type === 'scrolled' && state.sync) {
    const until = scrolledByUs.get(tabId) ?? 0
    if (Date.now() < until) return
    const other = tabId === state.tabs.translation ? state.tabs.source : state.tabs.translation
    if (other === undefined) return
    scrolledByUs.set(other, Date.now() + 600)
    void toContent(other, { type: 'scrollTo', segmentId: msg.segmentId }).catch(() => {})
  }
})

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && Object.values(state.tabs).includes(tabId) && api) void attempt(rescan)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const side of ['source', 'translation'] as Side[]) {
    if (state.tabs[side] === tabId) {
      delete state.tabs[side]
      delete state.scans[side]
    }
  }
  render()
})

chrome.tabs.onActivated.addListener(() => {
  // A different tab: if it isn't one of ours, look again which tabs to review.
  if (!api || state.needsSitePermission) return
  void activeTab().then((tab) => {
    if (tab?.id !== undefined && !Object.values(state.tabs).includes(tab.id)) void attempt(findTabs)
  })
})

// ---------- Rendering ----------

type Child = Node | string | null | undefined | false
function h(tag: string, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v)
    else if (v === true) el.setAttribute(k, '')
    else if (v !== false) el.setAttribute(k, v)
  }
  for (const c of children) if (c) el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return el
}

const statusLabel = (s: string) => (s === 'ai' ? t('statusAi') : s === 'corrected' ? t('statusCorrected') : t('statusApproved'))
const badge = (s: string) => h('span', { class: `badge ${s}` }, statusLabel(s))
const asText = (html: string) => htmlToText(html)

function renderConnect(root: HTMLElement): void {
  const input = h('input', { type: 'url', id: 'link', placeholder: 'https://…/review#…', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement
  const go = () =>
    void attempt(async () => {
      const link = parseReviewLink(input.value)
      if (!link) {
        state.error = t('errorBadLink')
        return
      }
      await connect(link, true)
    })
  input.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && go())
  root.append(
    h('h1', {}, t('connectTitle')),
    h('p', { class: 'muted' }, t('connectHelp')),
    h('label', { for: 'link' }, t('connectLinkLabel')),
    input,
    h('button', { class: 'primary', onclick: go, disabled: state.busy }, t('connectButton')),
  )
}

function renderSession(root: HTMLElement, s: ReviewSession): void {
  const until = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { dateStyle: 'medium' }).format(new Date(s.expiresAt))
  const reviewer = h('input', { id: 'reviewer', value: state.reviewer, maxlength: '100', autocomplete: 'name' }) as HTMLInputElement
  reviewer.addEventListener('change', () => {
    state.reviewer = reviewer.value.trim()
    save({ reviewer: state.reviewer })
  })
  const toggle = (key: 'sync' | 'reviewMode', label: string) => {
    const box = h('input', { type: 'checkbox', checked: state[key] }) as HTMLInputElement
    box.addEventListener('change', () => {
      state[key] = box.checked
      save({ [key]: box.checked })
      if (key === 'reviewMode') for (const id of Object.values(state.tabs)) void toContent(id!, { type: 'review-mode', on: box.checked }).catch(() => {})
    })
    return h('label', { class: 'check' }, box, label)
  }
  root.append(
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, t('site')),
      h('dd', {}, s.site.name),
      h('dt', {}, t('language')),
      h('dd', { class: 'mono' }, `${s.site.sourceLang ?? '…'} → ${s.targetLang}`),
      h('dt', {}, t('validUntil')),
      h('dd', {}, `${until} · ${s.role === 'linguist' ? t('roleLinguist') : t('roleCustomer')}`),
    ),
    h('label', { for: 'reviewer' }, t('reviewerLabel')),
    reviewer,
  )
  if (state.needsSitePermission) {
    root.append(
      h('p', { class: 'notice' }, t('errorPermission')),
      h('button', { class: 'primary', onclick: () => void attempt(allowSite) }, `${t('connectButton')}: ${new URL(s.site.origin).host}`),
    )
    return
  }
  root.append(
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', onclick: () => void attempt(openSideBySide), disabled: state.busy }, t('openSideBySide')),
      h('button', { onclick: () => void attempt(findTabs), disabled: state.busy }, t('rescan')),
    ),
    h('div', { class: 'toggles' }, toggle('sync', t('syncScroll')), toggle('reviewMode', t('reviewMode'))),
  )
}

function renderDetail(root: HTMLElement, d: SegmentDetail): void {
  const hasMarkup = markupTags(d.sourceHtml).length > 0
  const editor = h('textarea', { id: 'translation', rows: '6', spellcheck: 'true', lang: state.session?.targetLang ?? '' }) as HTMLTextAreaElement
  editor.value = hasMarkup ? d.translationHtml : asText(d.translationHtml)
  const comment = h('textarea', { id: 'comment', rows: '2', maxlength: '5000' }) as HTMLTextAreaElement
  const several = (state.scans.translation?.matches ?? []).find((m) => m.some((x) => x.id === d.id) && m.length > 1)
  root.append(
    h('button', { class: 'link', onclick: () => void attempt(back) }, `← ${t('back')}`),
    h('div', { class: 'card' },
      h('div', { class: 'row space' }, h('strong', {}, t('original')), badge(d.status)),
      h('p', { class: 'source', lang: state.session?.site.sourceLang ?? '' }, asText(d.sourceHtml)),
      several && h('p', { class: 'muted small' }, t('severalSources', several.length)),
      h('label', { for: 'translation' }, t('translation')),
      hasMarkup && h('p', { class: 'muted small' }, t('markupHint')),
      editor,
      h('label', { for: 'comment' }, t('commentLabel')),
      comment,
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: state.busy, onclick: () => void attempt(() => saveCorrection(editor.value, comment.value)) }, t('save')),
        h('button', { disabled: state.busy, onclick: () => void attempt(() => approve(comment.value)) }, t('approve')),
        h('button', { disabled: state.busy, onclick: () => void attempt(() => addComment(comment.value)) }, t('addComment')),
      ),
    ),
    h('h2', {}, t('history')),
    h('ol', { class: 'history' },
      ...[...d.history].reverse().map((e) => {
        const who = e.reviewer ?? ''
        const title = e.kind === 'ai' ? t('historyAi') : e.kind === 'correction' ? t('historyCorrection', who) : e.kind === 'approval' ? t('historyApproval', who) : t('historyComment', who)
        const when = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(e.at))
        return h('li', {},
          h('div', { class: 'small muted' }, `${title} · ${when}`),
          e.html !== null && h('div', {}, asText(e.html)),
          e.comment && h('div', { class: 'comment' }, e.comment),
        )
      }),
    ),
  )
}

function renderLists(root: HTMLElement): void {
  const s = state.scans.translation
  if (!s) {
    root.append(h('p', { class: 'muted' }, state.tabs.translation === undefined ? t('notOnSite') : t('scanning')))
    return
  }
  const segments = pageSegments()
  const unmatched = s.scan.blocks.filter((b) => !(s.matches[b.i] ?? []).length)
  const invisible = s.scan.invisible.map((x, i) => ({ ...x, segs: s.invisibleMatches[i] ?? [] }))
  const tab = (key: State['list'], label: string) =>
    h('button', { class: state.list === key ? 'tab active' : 'tab', 'aria-pressed': String(state.list === key), onclick: () => {
      state.list = key
      render()
    } }, label)
  root.append(
    h('div', { class: 'tabs', role: 'toolbar' }, tab('page', t('tabPage', segments.length)), tab('unmatched', t('tabUnmatched', unmatched.length)), tab('invisible', t('tabInvisible', invisible.length))),
  )
  if (state.list === 'page') {
    if (!segments.length) root.append(h('p', { class: 'muted' }, t('emptyPage')))
    else root.append(h('p', { class: 'muted small' }, t('selectHint')), h('ul', { class: 'list' }, ...segments.map((seg) =>
      h('li', { class: state.selected === seg.id ? 'selected' : '' },
        h('button', { class: 'item', onclick: () => void attempt(() => select(seg.id)) },
          h('span', { class: 'text' }, asText(seg.translationHtml)), badge(seg.status)))),
    ))
  } else if (state.list === 'unmatched') {
    if (!unmatched.length) root.append(h('p', { class: 'muted' }, t('emptyUnmatched')))
    else root.append(h('ul', { class: 'list' }, ...unmatched.map((b) =>
      h('li', { class: state.unmatched === b.i ? 'selected' : '' },
        h('div', { class: 'text' }, b.text),
        h('div', { class: 'small muted' }, s.untranslated[b.i] ? t('unmatchedUntranslated') : t('unmatchedOther'))))))
  } else {
    if (!invisible.length) root.append(h('p', { class: 'muted' }, t('emptyInvisible')))
    else root.append(h('ul', { class: 'list' }, ...invisible.map((x) => {
      const seg = x.segs[0]
      const body = [h('span', { class: 'where mono small' }, x.where), h('span', { class: 'text' }, x.text), seg ? badge(seg.status) : null]
      return h('li', {}, seg ? h('button', { class: 'item', onclick: () => void attempt(() => select(seg.id)) }, ...body) : h('div', { class: 'item' }, ...body))
    })))
  }
}

function render(): void {
  const root = document.getElementById('app')!
  root.replaceChildren()
  const header = h('header', {}, h('img', { src: 'icons/icon-32.png', alt: '', width: '20', height: '20' }), h('span', {}, t('extName')))
  if (state.session) header.append(h('button', { class: 'link small', onclick: () => void attempt(disconnect) }, t('disconnect')))
  root.append(header)
  const main = h('main', { 'aria-busy': String(state.busy) })
  root.append(main)
  if (state.error) main.append(h('p', { class: 'notice error', role: 'alert' }, state.error))
  if (state.notice) main.append(h('p', { class: 'notice', role: 'status' }, state.notice))
  if (!state.session) return renderConnect(main)
  renderSession(main, state.session)
  if (state.needsSitePermission) return
  if (state.detail) renderDetail(main, state.detail)
  else renderLists(main)
}

document.documentElement.lang = chrome.i18n.getUILanguage()
render()
void attempt(load)

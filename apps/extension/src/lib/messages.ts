/**
 * Messages between the side panel and the content scripts in the two tabs.
 * The panel holds the state and talks to the proxy; content scripts only read
 * and mark their page. No page content is ever inserted as HTML.
 */
import type { SegmentStatus } from '@supertext-review/shared'
import type { InvisibleKind } from './collect'

/** Panel → content script. */
export type ToContent =
  | { type: 'scan' }
  | { type: 'mark'; marks: { i: number; segmentIds: number[]; status: SegmentStatus | 'unmatched' | 'untranslated' }[] }
  | { type: 'highlight'; segmentId: number | null; scroll: boolean }
  | { type: 'scrollTo'; segmentId: number }
  | { type: 'review-mode'; on: boolean }
  | { type: 'clear' }

export interface ScanResult {
  url: string
  blocks: { i: number; text: string }[]
  invisible: { text: string; kind: InvisibleKind; where: string }[]
}

/** Content script → panel (chrome.runtime.sendMessage; the sender's tab id comes with it). */
export type FromContent =
  | { type: 'select'; segmentId: number }
  | { type: 'select-unmatched'; i: number }
  | { type: 'hover'; segmentId: number | null }
  | { type: 'scrolled'; segmentId: number }
  | { type: 'ready'; url: string }

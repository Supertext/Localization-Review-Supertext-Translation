/**
 * Chrome's native split view. Chrome 155+ lets extensions create it
 * (`tabs.create({ splitWithTabId })`, `tabs.createSplit`); Chrome 140+ only
 * exposes `Tab.splitViewId`. Older or missing APIs fall back to a normal tab
 * next to the other one, and the panel asks for the shortcut.
 * Never move a split tab with `tabs.move`: Chrome silently breaks the split.
 */

/** `Tab.splitViewId` when the tab is in a split view, else null. */
export function splitIdOf(tab: chrome.tabs.Tab): number | null {
  const id = (tab as chrome.tabs.Tab & { splitViewId?: number }).splitViewId
  return typeof id === 'number' && id >= 0 ? id : null
}

/** The other tab of a split view, if the tab is in one. */
export async function splitPartner(tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab | null> {
  const split = splitIdOf(tab)
  if (split === null || tab.windowId === undefined) return null
  const tabs = await chrome.tabs.query({ windowId: tab.windowId })
  return tabs.find((t) => t.id !== tab.id && splitIdOf(t) === split) ?? null
}

export interface Opened {
  tab: chrome.tabs.Tab
  /** True if Chrome put the two tabs side by side. */
  split: boolean
}

/**
 * Opens `url` beside `next`, on the left or the right (original left,
 * translation right). With the Split View API the two end up side by side;
 * without it the new tab opens next to `next`.
 */
export async function openBeside(next: chrome.tabs.Tab, url: string, where: 'left' | 'right' = 'left'): Promise<Opened> {
  const base = { url, windowId: next.windowId, index: where === 'left' ? next.index : next.index + 1, active: false }
  if (next.id !== undefined && splitIdOf(next) === null) {
    try {
      const tab = await chrome.tabs.create({ ...base, splitWithTabId: next.id } as chrome.tabs.CreateProperties)
      // Some Chrome versions accept the property without splitting; check.
      const fresh = await chrome.tabs.get(tab.id!)
      if (splitIdOf(fresh) !== null) return { tab: fresh, split: true }
      const createSplit = (chrome.tabs as unknown as { createSplit?: (ids: [number, number]) => Promise<number> }).createSplit
      if (createSplit) {
        await createSplit([tab.id!, next.id])
        return { tab: await chrome.tabs.get(tab.id!), split: true }
      }
      return { tab: fresh, split: false }
    } catch {
      // Unknown property (Chrome before 155): fall through.
    }
  }
  return { tab: await chrome.tabs.create(base), split: false }
}

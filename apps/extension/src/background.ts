/**
 * Service worker. The side panel is registered for the whole window (manifest
 * `side_panel.default_path`), so it stays open when the reviewer clicks into
 * the other half of the split view. Clicking the toolbar icon opens it.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

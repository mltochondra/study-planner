// ============================================================
// Study Planner — background.js (service worker)
// ============================================================
// The service worker does NOT hold or save your entries.
// Chrome kills it after ~30 seconds of idle, so anything kept in
// a variable here would vanish. chrome.storage.local is the real
// home of the data; the popup writes to it directly.
//
// The service worker's job is the stuff that has to happen while
// the popup is CLOSED. Job #1: keep the toolbar badge showing how
// many entries you have planned.
//
// Rule for service workers: register every listener at the top
// level, synchronously. Chrome wakes the worker for an event and
// only finds listeners that were attached on startup.
// ============================================================

const BADGE_BG   = "#7cd4fd";   // same blue as the card stripe
const BADGE_TEXT = "#101828";   // same navy as the popup background

function updateBadge(entries) {
  // Only count entries with actual text, so a blank in-progress
  // card doesn't bump the number.
  const n = Array.isArray(entries)
    ? entries.filter((e) => e && typeof e.text === "string" && e.text !== "").length
    : 0;

  chrome.action.setBadgeText({ text: n === 0 ? "" : n > 99 ? "99+" : String(n) });
}

async function refreshBadge() {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT });   // Chrome 110+

  const { entries } = await chrome.storage.local.get("entries");
  updateBadge(entries);
}

// Badge state isn't guaranteed to survive a browser restart,
// so rebuild it on install/update and on every browser startup.
chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);

// Storage is the shared bus: whenever the popup saves, the
// worker hears about it here. No messaging needed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.entries) {
    updateBadge(changes.entries.newValue);
  }
});

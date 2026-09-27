// ============================================================
// Study Planner — background.js (service worker)
// ============================================================
// The service worker does NOT hold your entries. Chrome kills it after
// ~30 seconds of idle, so anything kept in a variable here would vanish.
// chrome.storage.local is the real home of the data.
//
// What the worker owns is everything that must happen while the popup
// is CLOSED:
//   1. the toolbar badge
//   2. the focus timer (alarms fire even with the popup shut)
//   3. turning website blocking on and off
//   4. the finish chime, via an offscreen document
//
// Rule for service workers: register every listener at the top level,
// synchronously. Chrome wakes the worker for an event and only finds
// listeners that were attached on startup.
// ============================================================

import { getBlocklist, isBlockedUrl } from "./domains.js";

const BADGE_BG    = "#7cd4fd";   // card-stripe blue
const BADGE_TEXT  = "#101828";   // popup navy
const TIMER_BG    = "#32d583";   // Split-button green, so a running timer looks different
const RULE_ID     = 1;   // one dynamic rule holds every blocked domain
const DONE_ALARM  = "timer-done";
const TICK_ALARM  = "timer-tick";

// ---------- Timer state ----------
// Stored as a TIMESTAMP, same principle as the elapsed clocks: the
// alarm fires the event, but the countdown itself is endsAt - now.
// Nothing has to be running for the time to pass.
//   timer -> { endsAt: number, minutes: number } | null

const getTimer = async () => (await chrome.storage.local.get("timer")).timer ?? null;

const isRunning = (timer) => timer !== null && timer.endsAt > Date.now();

// ---------- Blocking (layer 1: the network) ----------
// Static rulesets can only be turned on and off; their contents are
// fixed at build time. A user-editable list needs DYNAMIC rules, which
// we write at runtime. One rule carries every domain, so switching
// blocking on or off is a single add or remove.
async function setBlocking(on) {
  try {
    // Always clear first. Adding a rule id that already exists throws,
    // and "remove then add" is also how we rebuild after an edit.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
    if (!on) return;

    const domains = await getBlocklist();
    if (domains.length === 0) return;   // an empty list blocks nothing

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: RULE_ID,
        priority: 1,
        action: { type: "block" },
        condition: { requestDomains: domains, resourceTypes: ["main_frame"] },
      }],
    });
  } catch (err) {
    console.error("Couldn't toggle blocking:", err);
  }
}

// ---------- Tab enforcement (layer 2) ----------
// Why this exists: declarativeNetRequest only sees NETWORK requests.
// Sites like YouTube install their own service worker, so revisiting
// them can be served straight from that cache with no network request
// at all — nothing for the rule to block. Same story for back/forward
// cache and restored tabs. So we also watch tab URLs, which change no
// matter where the page came from.
async function enforceTab(tabId, url, domains) {
  if (!isBlockedUrl(url, domains)) return;
  try {
    await chrome.tabs.update(tabId, {
      url: chrome.runtime.getURL(`blocked.html?from=${encodeURIComponent(url)}`),
    });
  } catch (err) {
    console.error("Couldn't redirect blocked tab:", err);
  }
}

// Called when a timer starts: tabs already sitting on a blocked site
// don't fire a navigation event, so sweep them once up front.
async function sweepTabs() {
  try {
    const domains = await getBlocklist();
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined && tab.url) await enforceTab(tab.id, tab.url, domains);
    }
  } catch (err) {
    console.error("Couldn't sweep tabs:", err);
  }
}

// ---------- Chime ----------
// A service worker has no DOM, so it cannot play audio. An offscreen
// document is a hidden page the worker can create purely to do DOM
// things. It plays the tone, then closes itself.
//
// Chrome allows exactly ONE offscreen document per extension, and
// creating it is async. Two overlapping calls can therefore both look,
// both see nothing, and both try to create one — the second throws.
// This promise guard makes the second caller wait on the FIRST call's
// promise instead of starting its own.
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;

  if (creating) return creating;          // someone else is already making it

  creating = chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a chime when the study timer finishes.",
    })
    .catch((err) => {
      // The document closing itself leaves a brief window where it is
      // gone from getContexts but not yet gone from Chrome's bookkeeping.
      // If that is what we hit, the document exists and we can just use it.
      if (!String(err).includes("single offscreen document")) throw err;
    })
    .finally(() => { creating = null; });

  return creating;
}

async function playChime() {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "play-chime" });
  } catch (err) {
    console.error("Couldn't play chime:", err);
  }
}

// ---------- Badge ----------
// While the timer runs the badge shows minutes left; otherwise it falls
// back to the number of planned entries.
async function refreshBadge() {
  const timer = await getTimer();

  if (isRunning(timer)) {
    const mins = Math.ceil((timer.endsAt - Date.now()) / 60000);
    chrome.action.setBadgeBackgroundColor({ color: TIMER_BG });
    chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT });
    chrome.action.setBadgeText({ text: `${mins}m` });
    return;
  }

  const { entries } = await chrome.storage.local.get("entries");
  const n = Array.isArray(entries)
    ? entries.filter((e) => e && typeof e.text === "string" && e.text !== "").length
    : 0;

  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT });
  chrome.action.setBadgeText({ text: n === 0 ? "" : n > 99 ? "99+" : String(n) });
}

// ---------- Timer control ----------

async function startTimer(minutes) {
  const endsAt = Date.now() + minutes * 60000;
  await chrome.storage.local.set({ timer: { endsAt, minutes } });

  // One alarm for the finish, one repeating alarm to keep the badge
  // honest. Chrome floors periodInMinutes at 1 for unpacked extensions.
  await chrome.alarms.clear(DONE_ALARM);
  chrome.alarms.create(DONE_ALARM, { when: endsAt });
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });

  await setBlocking(true);
  await sweepTabs();
  await refreshBadge();
  return { endsAt, minutes };
}

// finished=true means the clock ran out; false means the user stopped early.
//
// DONE_ALARM and the one-minute TICK_ALARM can both notice the clock has
// run out at nearly the same moment. A storage check alone does NOT fix
// that: both would read "still running" before either had written the
// removal, and you'd hear the chime twice. Async code needs a guard that
// exists from the moment the first caller STARTS, not once it finishes —
// so the second caller awaits the first one's promise and returns.
let ending = null;

function endTimer(finished) {
  if (ending) return ending;
  ending = finishTimer(finished).finally(() => { ending = null; });
  return ending;
}

async function finishTimer(finished) {
  // Also check storage, which covers the case where the worker was
  // restarted between the two alarms and the in-memory guard was lost.
  const timer = await getTimer();
  const alreadyEnded = timer === null;

  await chrome.alarms.clear(DONE_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await chrome.storage.local.remove("timer");
  await setBlocking(false);
  await refreshBadge();
  if (finished && !alreadyEnded) await playChime();
}

// Truth check, run on startup/install and whenever the worker wakes:
// storage and the blocking state must agree with the wall clock.
async function syncTimer() {
  const timer = await getTimer();
  if (isRunning(timer)) {
    chrome.alarms.create(DONE_ALARM, { when: timer.endsAt });
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
    await setBlocking(true);
  } else if (timer !== null) {
    await endTimer(false);   // expired while the browser was closed: clean up quietly
  } else {
    await setBlocking(false);
  }
  await refreshBadge();
}

// ---------- Listeners (all registered at top level) ----------

chrome.runtime.onInstalled.addListener(async () => {
  await getBlocklist();   // seeds the default list on first install
  await syncTimer();
});
chrome.runtime.onStartup.addListener(syncTimer);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === DONE_ALARM) await endTimer(true);
  else if (alarm.name === TICK_ALARM) {
    const timer = await getTimer();
    if (isRunning(timer)) await refreshBadge();
    else await endTimer(true);   // missed the exact moment; finish now
  }
});

// Layer 2 in action. Fires on every tab navigation, including ones the
// network never saw. The timer check happens per-event rather than by
// adding/removing the listener, because a sleeping worker has to be able
// to wake up and find this listener already registered.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? (changeInfo.status === "loading" ? tab.url : null);
  if (!url) return;
  const timer = await getTimer();
  if (!isRunning(timer)) return;
  await enforceTab(tabId, url, await getBlocklist());
});

// The popup asks the worker to start/stop, because only the worker
// should own alarms and blocking. Entries still go straight to storage.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "start-timer") {
    startTimer(msg.minutes).then(sendResponse);
    return true;              // keep the channel open for the async reply
  }
  if (msg?.type === "stop-timer") {
    endTimer(false).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;               // not ours (e.g. play-chime, meant for offscreen)
});

// Entry edits still reach the badge through storage, no messaging needed.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.entries || changes.timer) refreshBadge();

  // Edited the blocklist while a timer is running? Rebuild the network
  // rule now, rather than leaving the old one in force until the next
  // session. The tab layer needs no such nudge — it reads storage on
  // every navigation.
  if (changes.blocklist) {
    const timer = await getTimer();
    if (isRunning(timer)) {
      await setBlocking(true);
      // ...and bounce anything already open on a site you just added.
      // Without this, blocking a site mid-session leaves the tab you
      // were looking at sitting there, which reads as "it didn't work".
      await sweepTabs();
    }
  }
});

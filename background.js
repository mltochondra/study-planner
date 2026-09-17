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

const BADGE_BG    = "#7cd4fd";   // card-stripe blue
const BADGE_TEXT  = "#101828";   // popup navy
const TIMER_BG    = "#32d583";   // Study-button green, so a running timer looks different
const RULESET_ID  = "blocklist";
const DONE_ALARM  = "timer-done";
const TICK_ALARM  = "timer-tick";

// ---------- Blocked domains ----------
// Mirrors rules.json for now. declarativeNetRequest can only stop
// requests that actually hit the network; this list powers the second
// layer below, which watches tabs instead. When the editable
// whitelist/blacklist lands, both layers will read one dynamic source.
const BLOCKED_DOMAINS = [
  "youtube.com", "instagram.com", "tiktok.com", "x.com", "twitter.com",
  "facebook.com", "reddit.com", "netflix.com", "twitch.tv", "discord.com",
  "snapchat.com", "pinterest.com", "9gag.com", "chess.com",
];

// Matches the domain and its subdomains (www.youtube.com, m.youtube.com),
// but never a lookalike like notyoutube.com — hence the dot check.
function isBlockedUrl(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// ---------- Timer state ----------
// Stored as a TIMESTAMP, same principle as the elapsed clocks: the
// alarm fires the event, but the countdown itself is endsAt - now.
// Nothing has to be running for the time to pass.
//   timer -> { endsAt: number, minutes: number } | null

const getTimer = async () => (await chrome.storage.local.get("timer")).timer ?? null;

const isRunning = (timer) => timer !== null && timer.endsAt > Date.now();

// ---------- Blocking ----------
// Enable/disable the whole static ruleset. Enabled state PERSISTS across
// browser restarts, so it must be re-synced on startup — otherwise a
// crash mid-session could leave you locked out of YouTube forever.
// Funny for about four minutes, then not.
async function setBlocking(on) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      on ? { enableRulesetIds: [RULESET_ID] } : { disableRulesetIds: [RULESET_ID] }
    );
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
async function enforceTab(tabId, url) {
  if (!isBlockedUrl(url)) return;
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
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined && tab.url) await enforceTab(tab.id, tab.url);
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

chrome.runtime.onInstalled.addListener(syncTimer);
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
  if (isRunning(timer)) await enforceTab(tabId, url);
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.entries || changes.timer)) refreshBadge();
});

// ============================================================
// Study Planner — popup.js (v1.4: editable blocklist)
// ============================================================
// STATE is the source of truth; render() projects it onto the DOM.
// Every change to state is mirrored into chrome.storage.local, and
// on open we load from storage BEFORE the first render.
//
// Storage keys (separate because they change at different speeds):
//   entries -> [{ id, text, level, priority, createdAt, studiedAt }]
//                                    saved on add / save / delete / level / split
//   draft   -> { id, text, priority } saved on every keystroke while editing
//   timer   -> { endsAt, minutes }    owned by the service worker
//   blocklist -> ["youtube.com", ...]  edited here, enforced by the worker
//
// The draft key is what makes this safe: a popup closes the instant
// you click outside it, and there is no reliable "about to close"
// event to save on. So we never wait for one.
// ============================================================

// ---------- Bloom's Taxonomy ----------
// One table drives the dropdown, the colours, and the tooltips.
// accent = saturated, for the card stripe.
// soft   = lighter, because saturated red/green on navy is hard to read.
const LEVELS = [
  { id: "remember",   label: "Remember",   accent: "#f04438", soft: "#fda29b", blurb: "Retain and recall information" },
  { id: "understand", label: "Understand", accent: "#f79009", soft: "#fdb022", blurb: "Grasp the meaning of something" },
  { id: "apply",      label: "Apply",      accent: "#ffe600", soft: "#fde272", blurb: "Use existing knowledge in new contexts" },
  { id: "analyze",    label: "Analyze",    accent: "#17b26a", soft: "#6ce9a6", blurb: "Explore relationships, causes, and connections" },
  { id: "evaluate",   label: "Evaluate",   accent: "#29abe2", soft: "#7cd4fd", blurb: "Make judgments based on sound analysis" },
  { id: "create",     label: "Create",     accent: "#6172f3", soft: "#a4bcfd", blurb: "Use existing information to make something new" },
];

const DEFAULT_LEVEL = "remember";
const levelById = new Map(LEVELS.map((l) => [l.id, l]));
const getLevel  = (id) => levelById.get(id) ?? levelById.get(DEFAULT_LEVEL);

import {
  normalizeDomain,
  getBlocklist,
  saveBlocklist,
} from "./domains.js";

// ---------- Priority ----------
// Rank drives the sort order: lower rank floats to the top.
// Deliberately NO colour here. Bloom already owns every hue on the card,
// so a second palette would just fight it. Priority gets the two channels
// Bloom isn't using: vertical position, and how thick the stripe is.
const PRIORITIES = [
  { id: "lethal",    label: "Lethal",    rank: 0, stripe: "6px", blurb: "Do this or something breaks" },
  { id: "necessary", label: "Necessary", rank: 1, stripe: "3px", blurb: "Has to happen, but not today" },
  { id: "todo",      label: "To Do",     rank: 2, stripe: "1px", blurb: "Worth doing when there's room" },
];

// New entries start Necessary, not To Do: a brand-new card would
// otherwise be born at the very bottom of the list, below everything
// you already wrote. Necessary is the honest neutral — you promote to
// Lethal or demote to To Do from there. One constant to change.
const DEFAULT_PRIORITY = "necessary";
const prioById = new Map(PRIORITIES.map((p) => [p.id, p]));
const getPriority = (id) => prioById.get(id) ?? prioById.get(DEFAULT_PRIORITY);

// Sorts a COPY, and Array.sort is stable, so entries of equal priority
// keep the order they already had — newest first, as before.
const sortedEntries = () =>
  [...entries].sort((a, b) => getPriority(a.priority).rank - getPriority(b.priority).rank);

// ---------- Time ----------
// We store TIMESTAMPS (a moment), never elapsed counters (a duration).
// A counter would need something running to increment it, and a service
// worker sleeps after ~30s while a closed browser runs nothing at all.
// An elapsed time is just Date.now() minus a stored moment, computed at
// the instant we draw it — so the clock "keeps ticking" with the
// extension entirely shut down. Wall time does the work; we just read it.

const HOUR = 3600000;
const DAY  = 86400000;

function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const days  = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return "<1h";
}

const createdLabel = (entry) => `Created ${formatSpan(Date.now() - entry.createdAt)} ago`;

const elapsedLabel = (entry) =>
  entry.studiedAt === null
    ? "Never studied"
    : `${formatSpan(Date.now() - entry.studiedAt)} elapsed`;

// ---------- State ----------
const entries = [];      // see the storage shape at the top of this file
let editingId = null;    // id of the card in edit mode, or null
let draftText = "";      // live contents of the open editor
let draftPriority = DEFAULT_PRIORITY;   // priority being edited, not yet committed

// ---------- DOM references ----------
const listEl    = document.getElementById("list");
const headingEl = document.getElementById("heading");
const addBtn    = document.getElementById("addBtn");
const timerBar  = document.getElementById("timerBar");
const minutesEl = document.getElementById("minutes");
const startBtn  = document.getElementById("startBtn");
const stopBtn   = document.getElementById("stopBtn");
const countdown = document.getElementById("countdown");
const gearBtn   = document.getElementById("gearBtn");
const settingsEl   = document.getElementById("settings");
const siteInput    = document.getElementById("siteInput");
const addSiteBtn   = document.getElementById("addSiteBtn");
const addCurrentBtn = document.getElementById("addCurrentBtn");
const siteStatus   = document.getElementById("siteStatus");
const siteListEl   = document.getElementById("siteList");
const blockNote    = document.getElementById("blockNote");

// ---------- Helpers ----------
const findEntry   = (id) => entries.find((e) => e.id === id);
const removeEntry = (id) => {
  const i = entries.findIndex((e) => e.id === id);
  if (i !== -1) entries.splice(i, 1);
};

// ---------- Storage ----------

async function saveEntries() {
  try {
    await chrome.storage.local.set({ entries });
  } catch (err) {
    console.error("Couldn't save entries:", err);
  }
}

async function saveDraft() {
  try {
    if (editingId === null) await chrome.storage.local.remove("draft");
    else await chrome.storage.local.set({
      draft: { id: editingId, text: draftText, priority: draftPriority },
    });
  } catch (err) {
    console.error("Couldn't save draft:", err);
  }
}

async function load() {
  let saved = [];
  let draft = null;
  try {
    const got = await chrome.storage.local.get(["entries", "draft", "timer"]);
    saved = got.entries ?? [];
    draft = got.draft ?? null;
    timerEndsAt = got.timer?.endsAt > Date.now() ? got.timer.endsAt : null;
  } catch (err) {
    console.error("Couldn't load entries:", err);
  }

  // Never trust storage blindly: keep only well-formed entries, drop
  // blank cards unless one is being drafted, and migrate entries saved
  // before levels existed by defaulting them to Remember.
  if (Array.isArray(saved)) {
    for (const e of saved) {
      const wellFormed = e && typeof e.id === "string" && typeof e.text === "string";
      if (!wellFormed) continue;
      if (e.text === "" && e.id !== draft?.id) continue;
      entries.push({
        id: e.id,
        text: e.text,
        level: levelById.has(e.level) ? e.level : DEFAULT_LEVEL,
        // Entries saved before priorities existed all become Necessary.
        // Because they land on one rank and the sort is stable, upgrading
        // rearranges nothing — the list you had is the list you get.
        priority: prioById.has(e.priority) ? e.priority : DEFAULT_PRIORITY,
        // Entries saved before timestamps existed get "now" as their
        // birthday. It's a lie, but it's the only honest guess available,
        // and it beats rendering "NaNd NaNh ago".
        createdAt: typeof e.createdAt === "number" ? e.createdAt : Date.now(),
        studiedAt: typeof e.studiedAt === "number" ? e.studiedAt : null,
      });
    }
  }

  // Reopen the editor exactly where you left it
  const drafted = draft && typeof draft.text === "string" ? findEntry(draft.id) : null;
  if (drafted) {
    editingId = draft.id;
    draftText = draft.text;
    draftPriority = prioById.has(draft.priority) ? draft.priority : drafted.priority;
  }
}

// ---------- Actions ----------

// Write the open draft into state.
// Empty draft rules:
//   - brand-new card (never saved)  -> discard it, no ghost cards
//   - existing card cleared out     -> revert to its old text
function commitEdit() {
  if (editingId === null) return;

  const entry = findEntry(editingId);
  const text = draftText.trim();

  if (entry) {
    if (text !== "")            entry.text = text;
    else if (entry.text === "") removeEntry(entry.id);
    // Priority is a separate field, so it lands even when the text was
    // left blank and reverted. This is the moment the card changes rank
    // and moves — never mid-sentence.
    if (findEntry(entry.id)) entry.priority = draftPriority;
  }

  editingId = null;
  draftText = "";
  draftPriority = DEFAULT_PRIORITY;
  saveEntries();
  saveDraft();
}

function addEntry() {
  commitEdit();
  const entry = {
    id: crypto.randomUUID(),
    text: "",
    level: DEFAULT_LEVEL,
    priority: DEFAULT_PRIORITY,
    createdAt: Date.now(),
    studiedAt: null,
  };
  entries.unshift(entry);              // newest first within its rank
  editingId = entry.id;
  draftText = "";
  draftPriority = DEFAULT_PRIORITY;
  saveEntries();
  saveDraft();
  render();
}

function startEdit(id) {
  commitEdit();
  const entry = findEntry(id);
  if (!entry) return render();
  editingId = id;
  draftText = entry.text;
  draftPriority = entry.priority;
  saveDraft();
  render();
}

function saveEdit() {
  commitEdit();
  render();
}

function deleteEntry(id) {
  commitEdit();
  removeEntry(id);
  saveEntries();
  render();
}

// Changing the level must NOT commit the open draft — you should be
// able to retag a card mid-sentence and keep typing.
function setLevel(id, levelId) {
  const entry = findEntry(id);
  if (!entry || !levelById.has(levelId)) return;
  entry.level = levelId;
  saveEntries();
  render();
}

// Priority is edited into the DRAFT, exactly like the text, and only
// written to the entry on commit. That is what keeps the list from
// rearranging itself under your cursor: the sort reads entry.priority,
// which cannot change while the editor is open.
function setDraftPriority(priorityId) {
  if (!prioById.has(priorityId)) return;
  draftPriority = priorityId;
  saveDraft();
  render();
}

// Deliberately manual: pressing Split stamps "now" and the elapsed
// read-out restarts from zero. No scheduler, no due dates, no nagging —
// you look at the number and decide. Like setLevel, this does not
// commit the open draft.
function markStudied(id) {
  const entry = findEntry(id);
  if (!entry) return;
  entry.studiedAt = Date.now();
  saveEntries();
  render();
}

// ---------- Render (state -> DOM) ----------

// One builder for both dropdowns. They differ only in their option
// table, their current value and their label — everything visual is the
// shared .picker class plus a modifier.
function buildPicker({ kind, options, value, ariaLabel }) {
  const wrap = document.createElement("span");
  wrap.className = `picker ${kind}`;

  const select = document.createElement("select");
  select.setAttribute("aria-label", ariaLabel);

  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt.id;
    option.textContent = opt.label;
    option.title = opt.blurb;
    select.append(option);
  }
  select.value = value;
  select.title = options.find((o) => o.id === value)?.blurb ?? "";

  wrap.append(select);
  return wrap;
}

const buildLevelPicker = (entry) =>
  buildPicker({
    kind: "level",
    options: LEVELS,
    value: getLevel(entry.level).id,
    ariaLabel: "Bloom's Taxonomy level",
  });

// Only ever built inside the edit card — the view card is already busy.
const buildPriorityPicker = () =>
  buildPicker({
    kind: "prio",
    options: PRIORITIES,
    value: getPriority(draftPriority).id,
    ariaLabel: "Priority rank",
  });

// The colours ride on the card as custom properties, so the CSS never
// has to know the level names.
function paint(card, entry) {
  const level = getLevel(entry.level);
  card.style.setProperty("--accent", level.accent);
  card.style.setProperty("--accent-soft", level.soft);
  // Bloom picks the stripe's colour, priority picks its thickness.
  // Two independent facts, one element, no extra pixels.
  card.style.setProperty("--stripe", getPriority(entry.priority).stripe);
}

function buildViewCard(entry) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = entry.id;
  paint(card, entry);

  const row = document.createElement("div");
  row.className = "row";

  const q = document.createElement("div");
  q.className = "q";
  q.textContent = entry.text;          // textContent: safe by construction

  const del = document.createElement("button");
  del.className = "del-btn";
  del.type = "button";
  del.textContent = "×";
  del.title = "Delete entry";
  del.setAttribute("aria-label", "Delete entry");

  row.append(q, buildLevelPicker(entry), del);

  // Meta row: created / elapsed / Split.
  // (The button's class and the studiedAt key keep their old names on
  // purpose: renaming the storage key would orphan every saved split.)
  // The two time spans carry their timestamp in a data attribute so the
  // 60s tick can refresh their text without rebuilding the whole list.
  const meta = document.createElement("div");
  meta.className = "meta";

  const created = document.createElement("span");
  created.className = "created";
  created.dataset.created = entry.createdAt;
  created.textContent = createdLabel(entry);

  const elapsed = document.createElement("span");
  elapsed.className = "elapsed";
  if (entry.studiedAt === null) elapsed.classList.add("never");
  else elapsed.dataset.studied = entry.studiedAt;
  elapsed.textContent = elapsedLabel(entry);

  const study = document.createElement("button");
  study.className = "study-btn";
  study.type = "button";
  study.textContent = "Split";
  study.title = "Split: mark the lap and restart the elapsed clock";

  meta.append(created, elapsed, study);
  card.append(row, meta);
  return card;
}

function buildEditCard(entry) {
  const card = document.createElement("div");
  card.className = "card editing";
  card.dataset.id = entry.id;
  paint(card, entry);
  // The card doesn't move until you save, but the stripe thickens right
  // away, so the choice isn't invisible until then.
  card.style.setProperty("--stripe", getPriority(draftPriority).stripe);

  // Both pickers sit in a bar above the textarea, so you can set them
  // on a brand-new card before it has any text. Priority lives here and
  // nowhere else: the view card has no room left, and rank is a decision
  // worth making while you are already thinking about the entry.
  const bar = document.createElement("div");
  bar.className = "edit-bar";
  bar.append(buildPriorityPicker(), buildLevelPicker(entry));

  const input = document.createElement("textarea");
  input.className = "q-input";
  input.placeholder = "What are you studying?";
  input.value = draftText;             // the draft, not entry.text
  input.rows = 2;

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Enter saves, Shift+Enter adds a new line";

  const save = document.createElement("button");
  save.className = "save-btn";
  save.type = "button";
  save.textContent = "Save";

  card.append(bar, input, hint, save);
  return card;
}

function render() {
  listEl.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing planned yet. Hit + to add your first entry.";
    listEl.append(empty);
  }

  // Walk the sorted copy and drop a small header in whenever the rank
  // changes. Because the list is sorted, each rank appears exactly once,
  // so this needs no grouping pass — just "did it change since the last
  // card?".
  let lastPriority = null;
  const sorted = sortedEntries();

  for (const entry of sorted) {
    const prio = getPriority(entry.priority);
    if (prio.id !== lastPriority) {
      const head = document.createElement("div");
      head.className = `group ${prio.id}`;
      head.textContent = `${prio.label} · ${sorted.filter((e) => getPriority(e.priority).id === prio.id).length}`;
      listEl.append(head);
      lastPriority = prio.id;
    }
    listEl.append(entry.id === editingId ? buildEditCard(entry) : buildViewCard(entry));
  }

  const n = entries.filter((e) => e.text !== "").length;
  headingEl.textContent = n === 0 ? "Study planner" : `Study planner (${n})`;

  const input = listEl.querySelector(".q-input");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollIntoView({ block: "nearest" });
  }
}

// ---------- Events ----------

addBtn.addEventListener("click", addEntry);

// One delegated click handler; specific targets before the general one.
listEl.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.closest(".picker"))   return;   // the dropdowns handle themselves
  if (e.target.closest(".study-btn")) return markStudied(id);
  if (e.target.closest(".del-btn"))  return deleteEntry(id);
  if (e.target.closest(".save-btn")) return saveEdit();
  if (card.classList.contains("editing")) return;
  startEdit(id);
});

listEl.addEventListener("change", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  if (e.target.matches(".picker.level select")) return setLevel(card.dataset.id, e.target.value);
  if (e.target.matches(".picker.prio select"))  return setDraftPriority(e.target.value);
});

// Every keystroke goes to state AND to disk. No re-render,
// so the cursor stays put.
listEl.addEventListener("input", (e) => {
  if (!e.target.matches(".q-input")) return;
  draftText = e.target.value;
  saveDraft();
});

// Enter saves; Shift+Enter is a newline; IME composition is left alone.
listEl.addEventListener("keydown", (e) => {
  if (!e.target.matches(".q-input")) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    saveEdit();
  }
});

// ---------- Timer ----------
// The popup never owns the timer; the service worker does, because
// alarms and site blocking have to keep working with this window shut.
// Here we only send two commands and draw the remaining time, which is
// endsAt minus now — the same timestamp trick as the elapsed clocks.

let timerEndsAt = null;   // ms, or null when idle

function drawTimer() {
  const left = timerEndsAt === null ? 0 : timerEndsAt - Date.now();

  if (left <= 0) {
    timerEndsAt = null;
    timerBar.classList.remove("running");
    return;
  }

  timerBar.classList.add("running");
  const total = Math.ceil(left / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  countdown.textContent = `${mm}:${ss}`;
}

async function startTimer() {
  const minutes = Math.min(180, Math.max(1, Math.round(Number(minutesEl.value) || 25)));
  minutesEl.value = minutes;
  try {
    const res = await chrome.runtime.sendMessage({ type: "start-timer", minutes });
    timerEndsAt = res?.endsAt ?? Date.now() + minutes * 60000;
  } catch (err) {
    console.error("Couldn't start timer:", err);
  }
  drawTimer();
}

async function stopTimer() {
  try {
    await chrome.runtime.sendMessage({ type: "stop-timer" });
  } catch (err) {
    console.error("Couldn't stop timer:", err);
  }
  timerEndsAt = null;
  drawTimer();
}

startBtn.addEventListener("click", startTimer);
stopBtn.addEventListener("click", stopTimer);

// Redraw every second while open. The countdown is derived, never
// decremented, so a popup reopened 10 minutes later is instantly correct.
setInterval(drawTimer, 1000);

// If the worker ends the timer while the popup sits open, storage tells us.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.timer) return;
  timerEndsAt = changes.timer.newValue?.endsAt ?? null;
  drawTimer();
});

// ---------- Blocked sites ----------
// The list itself lives in storage and is shared with the service worker
// through domains.js. This half is only the editor.

let blocklist = [];

function setStatus(text, tone = "") {
  siteStatus.textContent = text;
  siteStatus.className = `status ${tone}`;
}

function renderSites() {
  siteListEl.replaceChildren();

  if (blocklist.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing blocked. Add a site above, and timers will keep you off it.";
    siteListEl.append(empty);
  }

  for (const domain of blocklist) {
    const row = document.createElement("div");
    row.className = "site";
    row.dataset.domain = domain;

    const name = document.createElement("span");
    name.textContent = domain;        // textContent: the user typed this

    const del = document.createElement("button");
    del.className = "del-btn";
    del.type = "button";
    del.textContent = "×";
    del.title = `Stop blocking ${domain}`;
    del.setAttribute("aria-label", `Stop blocking ${domain}`);

    row.append(name, del);
    siteListEl.append(row);
  }

  blockNote.textContent =
    blocklist.length === 0
      ? "nothing blocked yet"
      : `blocks ${blocklist.length} site${blocklist.length === 1 ? "" : "s"} while running`;
}

async function commitSites(next, message, tone) {
  blocklist = await saveBlocklist(next);   // sorts and de-duplicates
  renderSites();
  setStatus(message, tone);
}

// Everything the user types goes through normalizeDomain, so "youtube.com",
// "www.youtube.com" and a pasted watch URL all land as the same entry.
async function addSite(raw, { from = "typed" } = {}) {
  const domain = normalizeDomain(raw);

  if (!domain) {
    setStatus(
      from === "tab"
        ? "That tab isn't a normal website — nothing to block."
        : `"${raw.trim()}" doesn't look like a web address.`,
      "bad",
    );
    return;
  }
  if (blocklist.includes(domain)) {
    setStatus(`${domain} is already on the list.`, "");
    return;
  }

  await commitSites([...blocklist, domain], `Blocking ${domain}.`, "good");
  siteInput.value = "";
}

async function addCurrentSite() {
  try {
    // lastFocusedWindow, not currentWindow: the popup itself can count as
    // the current window, and then we'd read the wrong tab.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return setStatus("Couldn't read the current tab.", "bad");
    await addSite(tab.url, { from: "tab" });
  } catch (err) {
    console.error("Couldn't read the current tab:", err);
    setStatus("Couldn't read the current tab.", "bad");
  }
}

async function removeSite(domain) {
  await commitSites(blocklist.filter((d) => d !== domain), `${domain} unblocked.`, "");
}

function showSettings(on) {
  document.body.classList.toggle("in-settings", on);
  settingsEl.hidden = !on;
  headingEl.textContent = on ? "Blocked sites" : "Study planner";
  if (on) {
    setStatus("");
    renderSites();
    siteInput.focus();
  } else {
    render();            // repaint the planner heading and list
  }
}

gearBtn.addEventListener("click", () => showSettings(!document.body.classList.contains("in-settings")));
addSiteBtn.addEventListener("click", () => addSite(siteInput.value));
addCurrentBtn.addEventListener("click", addCurrentSite);

siteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) addSite(siteInput.value);
});

siteListEl.addEventListener("click", (e) => {
  const row = e.target.closest(".site");
  if (row && e.target.closest(".del-btn")) removeSite(row.dataset.domain);
});

// ---------- Tick ----------
// Repaint just the time strings once a minute so a popup left open
// doesn't freeze at the moment it was drawn. It rewrites text only —
// no re-render — so an open editor keeps its cursor exactly where it is.
function tickTimes() {
  for (const el of listEl.querySelectorAll(".created")) {
    el.textContent = `Created ${formatSpan(Date.now() - Number(el.dataset.created))} ago`;
  }
  for (const el of listEl.querySelectorAll(".elapsed[data-studied]")) {
    el.textContent = `${formatSpan(Date.now() - Number(el.dataset.studied))} elapsed`;
  }
}

setInterval(tickTimes, 60000);

// ---------- Boot ----------
// Load first, render second: no flash of "Nothing planned yet"
// while storage is still answering.
addBtn.disabled = true;
load().then(async () => {
  addBtn.disabled = false;
  render();
  drawTimer();
  blocklist = await getBlocklist();
  renderSites();               // fills in the "blocks N sites" note
});

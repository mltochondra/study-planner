// ============================================================
// Study Planner — popup.js (v0.4: Bloom's Taxonomy levels)
// ============================================================
// STATE is the source of truth; render() projects it onto the DOM.
// Every change to state is mirrored into chrome.storage.local, and
// on open we load from storage BEFORE the first render.
//
// Storage keys (separate because they change at different speeds):
//   entries -> [{ id, text, level }]  saved on add / save / delete / level
//   draft   -> { id, text }           saved on every keystroke while editing
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

// ---------- State ----------
const entries = [];      // [{ id: string, text: string, level: string }]
let editingId = null;    // id of the card in edit mode, or null
let draftText = "";      // live contents of the open editor

// ---------- DOM references ----------
const listEl    = document.getElementById("list");
const headingEl = document.getElementById("heading");
const addBtn    = document.getElementById("addBtn");

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
    else await chrome.storage.local.set({ draft: { id: editingId, text: draftText } });
  } catch (err) {
    console.error("Couldn't save draft:", err);
  }
}

async function load() {
  let saved = [];
  let draft = null;
  try {
    ({ entries: saved = [], draft = null } = await chrome.storage.local.get(["entries", "draft"]));
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
      });
    }
  }

  // Reopen the editor exactly where you left it
  if (draft && typeof draft.text === "string" && findEntry(draft.id)) {
    editingId = draft.id;
    draftText = draft.text;
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
  }

  editingId = null;
  draftText = "";
  saveEntries();
  saveDraft();
}

function addEntry() {
  commitEdit();
  const entry = { id: crypto.randomUUID(), text: "", level: DEFAULT_LEVEL };
  entries.unshift(entry);              // newest on top, right under the + button
  editingId = entry.id;
  draftText = "";
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

// ---------- Render (state -> DOM) ----------

function buildLevelPicker(entry) {
  const wrap = document.createElement("span");
  wrap.className = "level";

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Bloom's Taxonomy level");
  select.title = getLevel(entry.level).blurb;

  for (const level of LEVELS) {
    const option = document.createElement("option");
    option.value = level.id;
    option.textContent = level.label;
    select.append(option);
  }
  select.value = getLevel(entry.level).id;

  wrap.append(select);
  return wrap;
}

// The colours ride on the card as custom properties, so the CSS never
// has to know the level names.
function paint(card, entry) {
  const level = getLevel(entry.level);
  card.style.setProperty("--accent", level.accent);
  card.style.setProperty("--accent-soft", level.soft);
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
  card.append(row);
  return card;
}

function buildEditCard(entry) {
  const card = document.createElement("div");
  card.className = "card editing";
  card.dataset.id = entry.id;
  paint(card, entry);

  // Level picker sits in its own bar above the textarea, so you can
  // set the level on a brand-new card before it has any text.
  const bar = document.createElement("div");
  bar.className = "edit-bar";
  bar.append(buildLevelPicker(entry));

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

  for (const entry of entries) {
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

  if (e.target.closest(".level"))    return;   // the dropdown handles itself
  if (e.target.closest(".del-btn"))  return deleteEntry(id);
  if (e.target.closest(".save-btn")) return saveEdit();
  if (card.classList.contains("editing")) return;
  startEdit(id);
});

listEl.addEventListener("change", (e) => {
  if (!e.target.matches(".level select")) return;
  const card = e.target.closest(".card");
  if (card) setLevel(card.dataset.id, e.target.value);
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

// ---------- Boot ----------
// Load first, render second: no flash of "Nothing planned yet"
// while storage is still answering.
addBtn.disabled = true;
load().then(() => {
  addBtn.disabled = false;
  render();
});

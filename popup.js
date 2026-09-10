// ============================================================
// Study Planner — popup.js (v0.3: saved to chrome.storage.local)
// ============================================================
// STATE is the source of truth; render() projects it onto the DOM.
// Every change to state is mirrored into chrome.storage.local, and
// on open we load from storage BEFORE the first render.
//
// Storage keys (separate because they change at different speeds):
//   entries -> [{ id, text }]   saved on add / save / delete
//   draft   -> { id, text }     saved on every keystroke while editing
//
// The draft key is what makes this safe: a popup closes the instant
// you click outside it, and there is no reliable "about to close"
// event to save on. So we never wait for one. The draft is already
// on disk, and reopening puts you back inside the card, mid-sentence.
// ============================================================

// ---------- State ----------
const entries = [];      // [{ id: string, text: string }]
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

  // Never trust storage blindly: keep only well-formed entries,
  // and drop blank cards unless they're the one being drafted.
  if (Array.isArray(saved)) {
    for (const e of saved) {
      const wellFormed = e && typeof e.id === "string" && typeof e.text === "string";
      if (wellFormed && (e.text !== "" || e.id === draft?.id)) entries.push(e);
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
  const entry = { id: crypto.randomUUID(), text: "" };
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

// ---------- Render (state -> DOM) ----------

function buildViewCard(entry) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = entry.id;

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

  row.append(q, del);
  card.append(row);
  return card;
}

function buildEditCard(entry) {
  const card = document.createElement("div");
  card.className = "card editing";
  card.dataset.id = entry.id;

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

  card.append(input, hint, save);
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

  if (e.target.closest(".del-btn"))  return deleteEntry(id);
  if (e.target.closest(".save-btn")) return saveEdit();
  if (card.classList.contains("editing")) return;
  startEdit(id);
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

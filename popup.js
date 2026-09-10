// ============================================================
// Study Planner — popup.js (v0.2: entry cards)
// ============================================================
// STATE is the source of truth; render() projects it onto the DOM.
// A card has two modes:
//   view  -> text + delete button, click anywhere to edit
//   edit  -> textarea + Save (amber border)
// Only one card can be in edit mode at a time: editingId.
// ============================================================

// ---------- State ----------
const entries = [];      // [{ id: number, text: string }]
let nextId = 1;
let editingId = null;    // id of the card currently in edit mode, or null

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

// ---------- Actions ----------

// Pull the draft out of the open editor and write it to state.
// Rules for an empty draft:
//   - brand-new card (never saved)  -> discard it, no ghost cards
//   - existing card cleared out     -> revert to its old text
//     (deleting is the × button's job, not the Save button's)
function commitEdit() {
  if (editingId === null) return;

  const entry = findEntry(editingId);
  const input = listEl.querySelector(".q-input");
  const draft = input ? input.value.trim() : "";

  if (entry) {
    if (draft !== "")           entry.text = draft;
    else if (entry.text === "") removeEntry(entry.id);
  }
  editingId = null;
}

function addEntry() {
  commitEdit();                        // don't lose whatever's being typed
  const entry = { id: nextId++, text: "" };
  entries.unshift(entry);              // newest on top, right under the + button
  editingId = entry.id;
  render();
}

function startEdit(id) {
  commitEdit();
  editingId = id;
  render();
}

function saveEdit() {
  commitEdit();
  render();
}

function deleteEntry(id) {
  commitEdit();
  removeEntry(id);
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
  input.value = entry.text;
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

  const n = entries.length;
  headingEl.textContent = n === 0 ? "Study planner" : `Study planner (${n})`;

  // Put the cursor at the end of the open editor
  const input = listEl.querySelector(".q-input");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollIntoView({ block: "nearest" });
  }
}

// ---------- Events ----------

addBtn.addEventListener("click", addEntry);

// One delegated click handler for every card.
// Order matters: specific targets (buttons) before the general one (card).
listEl.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = Number(card.dataset.id);

  if (e.target.closest(".del-btn"))  return deleteEntry(id);
  if (e.target.closest(".save-btn")) return saveEdit();
  if (card.classList.contains("editing")) return;  // clicks inside the editor are for typing
  startEdit(id);
});

// Enter saves; Shift+Enter falls through to a normal newline.
// isComposing guard: don't hijack Enter while an IME (e.g. Korean) is mid-syllable.
listEl.addEventListener("keydown", (e) => {
  if (!e.target.matches(".q-input")) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    saveEdit();
  }
});

// ---------- Boot ----------
render();

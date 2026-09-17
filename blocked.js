// ============================================================
// Study Planner — blocked.js
// ============================================================
// The page a blocked tab gets sent to. It reads the timer straight
// from storage (the same endsAt timestamp everything else uses) and
// counts down, then offers a way back to where you were headed.
//
// Why a button and not a reload: this page's own URL is blocked.html,
// so reloading it just re-renders this page. The site you actually
// wanted survives only in the ?from= query string, and getting back
// means navigating there explicitly.
// ============================================================

const clockEl    = document.getElementById("clock");
const headlineEl = document.getElementById("headline");
const hostEl     = document.getElementById("host");
const noteEl     = document.getElementById("note");
const continueBtn = document.getElementById("continueBtn");

let endsAt = null;
let target = null;   // validated URL we're allowed to send the tab back to

// The ?from= value is just text in a URL, and anyone can craft a link
// to this page. So parse it and accept it ONLY if it's ordinary http(s);
// otherwise a hand-made link could point the button at something like a
// javascript: URL and use our own click handler to run it.
try {
  const from = new URLSearchParams(location.search).get("from");
  if (from) {
    const parsed = new URL(from);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      target = parsed.href;
      hostEl.textContent = parsed.hostname;
    }
  }
} catch { /* malformed URL: leave target null, the button stays hidden */ }

function draw() {
  const left = endsAt === null ? 0 : endsAt - Date.now();

  if (left > 0) {
    document.body.classList.remove("done");
    const total = Math.ceil(left / 1000);
    clockEl.textContent =
      `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    headlineEl.textContent = "Focus timer running";
    noteEl.textContent =
      "This site is on your blocklist until the timer ends. You can stop the timer from the Study Planner popup if you really need to.";
    continueBtn.hidden = true;
    return;
  }

  document.body.classList.add("done");
  clockEl.textContent = "00:00";
  headlineEl.textContent = "Timer's done — you're free";

  if (target) {
    continueBtn.textContent = `Continue to ${hostEl.textContent}`;
    continueBtn.hidden = false;
    noteEl.textContent = "";
  } else {
    noteEl.textContent = "You can close this tab.";
  }
}

// Deliberately NOT automatic. The timer ending shouldn't fling you onto
// a social feed you were only half-committed to visiting 25 minutes ago;
// going back should be a decision you make on purpose.
// replace() instead of assign() so this page doesn't linger in history —
// otherwise the Back button would drop you right back onto it.
continueBtn.addEventListener("click", () => {
  // Hidden isn't the same as disabled: a hidden button can still be
  // clicked programmatically, so the handler re-checks the clock itself
  // rather than trusting the UI state to enforce the rule.
  if (continueBtn.hidden || !target) return;
  if (endsAt !== null && endsAt > Date.now()) return;
  location.replace(target);
});

chrome.storage.local.get("timer").then(({ timer }) => {
  endsAt = timer?.endsAt ?? null;
  draw();
});

// Stopping the timer from the popup updates this page immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.timer) return;
  endsAt = changes.timer.newValue?.endsAt ?? null;
  draw();
});

setInterval(draw, 1000);

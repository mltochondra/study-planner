// ============================================================
// Study Planner — offscreen.js
// ============================================================
// Synthesises the finish chime with the Web Audio API instead of
// shipping an .mp3: no binary asset, no licensing question, and the
// whole sound is six lines of arithmetic.
// ============================================================

// Two notes, a rising fifth: A5 then E6.
const NOTES = [
  { freq: 880.00, start: 0.00, length: 0.35 },
  { freq: 1318.51, start: 0.28, length: 0.55 },
];

let closeTimer = null;

function chime() {
  const ctx = new AudioContext();
  const now = ctx.currentTime;

  for (const note of NOTES) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = note.freq;

    // Fade in fast, decay smoothly. A raw on/off square edge would
    // click audibly — that pop is the speaker being asked to jump
    // instantly from silence to full amplitude.
    const t = now + note.start;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + note.length);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + note.length + 0.05);
  }

  // Close the page once the sound has finished; the worker will make a
  // fresh one next time. An idle offscreen document is wasted memory.
  // Any queued close from a previous chime is cancelled first, so a
  // second chime can't be cut off mid-note by the earlier timer.
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => window.close(), 1500);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "play-chime") chime();
});

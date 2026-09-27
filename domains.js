// ============================================================
// Study Planner — domains.js
// ============================================================
// The single source of truth for "what counts as a blocked site".
//
// Until now this knowledge lived in TWO places: rules.json (the network
// layer) and a const array in background.js (the tab layer). Two copies
// of one fact is a bug with a delay on it — the day they disagree, a
// site is half-blocked and nothing in the code says which half is wrong.
// Now the list lives in storage, and the rules for reading it live here,
// imported by both the popup and the service worker.
//
// This file is why the manifest says "type": "module" — plain service
// worker scripts cannot import.
// ============================================================

// Seeded into storage on first install. After that, storage wins and
// this array is only history.
export const DEFAULT_BLOCKLIST = [
  "9gag.com", "chess.com", "discord.com", "facebook.com", "instagram.com",
  "netflix.com", "pinterest.com", "reddit.com", "snapchat.com", "tiktok.com",
  "twitch.tv", "twitter.com", "x.com", "youtube.com",
];

// Hostnames that would break the extension or the browser if blocked.
const NEVER_BLOCK = ["localhost", "chrome.google.com", "chromewebstore.google.com"];

// A deliberately loose shape check: letters/digits/dashes in labels, at
// least one dot, and a final label that looks like a TLD. It is not a
// full public-suffix parser, and it doesn't need to be — the worst case
// is a junk entry the user can delete.
const DOMAIN_SHAPE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Turn whatever the user typed into a bare domain, or null if it can't be one.
 * Accepts "youtube.com", "www.youtube.com", "https://youtube.com/watch?v=x",
 * "  YouTube.COM  " — all of which are the same site to a person, and all of
 * which are different strings to a computer. Normalising at the door means
 * nothing downstream has to wonder which spelling it got.
 */
export function normalizeDomain(input) {
  if (typeof input !== "string") return null;

  let text = input.trim().toLowerCase();
  if (text === "") return null;

  // Give the URL parser a protocol to chew on if there isn't one.
  let host;
  try {
    host = new URL(text.includes("://") ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }

  // "www." is noise: nobody means "block www.youtube.com but not
  // m.youtube.com". Subdomain matching handles the rest.
  host = host.replace(/^www\./, "");

  if (!DOMAIN_SHAPE.test(host)) return null;
  if (NEVER_BLOCK.includes(host)) return null;
  return host;
}

/**
 * Does this URL land on a blocked site?
 * Matches the domain and its subdomains (m.youtube.com), but never a
 * lookalike (notyoutube.com) or a suffix trick (youtube.com.evil.net) —
 * which is exactly what a naive `includes()` would let through.
 */
export function isBlockedUrl(url, domains) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Read the list, seeding defaults the first time. Always returns an array. */
export async function getBlocklist() {
  try {
    const { blocklist } = await chrome.storage.local.get("blocklist");
    if (Array.isArray(blocklist)) return blocklist.filter((d) => typeof d === "string");
    await chrome.storage.local.set({ blocklist: DEFAULT_BLOCKLIST });
    return [...DEFAULT_BLOCKLIST];
  } catch (err) {
    console.error("Couldn't read blocklist:", err);
    return [...DEFAULT_BLOCKLIST];
  }
}

/** Write the list back, de-duplicated and sorted so it reads like a list. */
export async function saveBlocklist(domains) {
  const clean = [...new Set(domains)].sort();
  await chrome.storage.local.set({ blocklist: clean });
  return clean;
}

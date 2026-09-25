// js/notifications.js — Section 13 (new): a stable, self-contained
// notification system for the web client. No push/service-worker backend
// is required — everything here works purely from the open tab, using:
//
//   1. The Notification Web API for OS-level popups (asked for once,
//      politely, only after the user has signed in — never on page load).
//   2. A live "unread" badge dot next to each contact row + a running
//      total in the document title ("(3) VaultChatt II") so the tab
//      itself tells you something arrived even if it's in a background
//      tab or minimized.
//   3. A small canvas-drawn badge baked onto the favicon, for browsers
//      that keep the title but hide it (pinned tabs).
//   4. A short WebAudio chime (synthesized — no audio file to fetch/host)
//      played on new-message arrival, throttled so a burst of messages
//      doesn't turn into a machine-gun.
//   5. Persistence in IndexedDB (`settings` store, key "unread:<uid>")
//      so unread counts survive a reload — same durability guarantee as
//      the rest of the app's local state (Section 14).
//
// All state is per-contact-uid; the caller (app.js) decides *when* to
// bump a count (message from someone whose conversation isn't currently
// open) and when to clear it (opening that conversation).

import { idb } from "./idb.js";

const UNREAD_PREFIX = "unread:";
let unreadCounts = new Map(); // uid -> count, hydrated from idb on init
let onChangeCallback = null;
let audioCtx = null;
let lastChimeAt = 0;
const CHIME_MIN_GAP_MS = 1200;

const faviconLinks = () =>
  Array.from(document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]'));
let baseFaviconImage = null; // cached Image() of the un-badged icon

export async function initNotifications() {
  const stored = await idb.get("settings", "unreadCounts").catch(() => null);
  if (stored && typeof stored === "object") {
    unreadCounts = new Map(Object.entries(stored));
  }
  await preloadBaseFavicon();
  renderBadges();
}

function preloadBaseFavicon() {
  return new Promise((resolve) => {
    const link = faviconLinks()[0];
    if (!link) return resolve();
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      baseFaviconImage = img;
      resolve();
    };
    img.onerror = () => resolve();
    img.src = link.href;
  });
}

async function persist() {
  await idb.put("settings", Object.fromEntries(unreadCounts), "unreadCounts");
}

// Called by app.js whenever the badge counts change, so it can re-paint
// contact-row dots and the requests-section counter live.
export function onUnreadChange(cb) {
  onChangeCallback = cb;
}

export function getUnreadCount(uid) {
  return unreadCounts.get(uid) || 0;
}

export function getTotalUnread() {
  let total = 0;
  for (const n of unreadCounts.values()) total += n;
  return total;
}

export async function bumpUnread(uid, by = 1) {
  unreadCounts.set(uid, (unreadCounts.get(uid) || 0) + by);
  await persist();
  renderBadges();
}

export async function clearUnread(uid) {
  if (!unreadCounts.has(uid)) return;
  unreadCounts.delete(uid);
  await persist();
  renderBadges();
}

function renderBadges() {
  const total = getTotalUnread();
  document.title = total > 0 ? `(${total > 99 ? "99+" : total}) VaultChatt II` : "VaultChatt II — Terminal";
  paintFaviconBadge(total);
  if (onChangeCallback) onChangeCallback(unreadCounts);
}

function paintFaviconBadge(total) {
  if (!baseFaviconImage) return;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(baseFaviconImage, 0, 0, size, size);

  if (total > 0) {
    const r = 20;
    const cx = size - r * 0.65;
    const cy = r * 0.65;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ff4d6d";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#080c14";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 26px 'Rajdhani', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(total > 9 ? "9+" : String(total), cx, cy + 1);
  }

  const dataUrl = canvas.toDataURL("image/png");
  faviconLinks().forEach((link) => (link.href = dataUrl));
}

// ─── OS notification permission (asked once, after sign-in, not on load) ──

export function notificationsSupported() {
  return "Notification" in window;
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch (_) {
    return Notification.permission;
  }
}

// ─── Firing a notification for an incoming message ────────────────────────
// `onClick` should focus the tab and open the right conversation.

export function notifyIncomingMessage({ fromName, preview, isNewSender, onClick }) {
  playChime();

  if (!notificationsSupported() || Notification.permission !== "granted") return;
  // Don't spam a popup for a tab the user is actively looking at.
  if (document.visibilityState === "visible") return;

  const title = isNewSender ? `New message request · ${fromName}` : fromName;
  const n = new Notification(title, {
    body: preview,
    icon: "icon-192.png",
    badge: "icon-96.png",
    tag: `vc-${fromName}`, // collapses rapid repeats from the same person
    renotify: true,
  });
  n.onclick = () => {
    window.focus();
    if (onClick) onClick();
    n.close();
  };
}

// ─── Synth chime (no audio asset needed) ───────────────────────────────────

function playChime() {
  const now = Date.now();
  if (now - lastChimeAt < CHIME_MIN_GAP_MS) return;
  lastChimeAt = now;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + i * 0.09);
      gain.gain.linearRampToValueAtTime(0.09, t0 + i * 0.09 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + i * 0.09);
      osc.stop(t0 + i * 0.09 + 0.24);
    });
  } catch (_) {
    /* audio not available (autoplay policy, unsupported browser) — silent fail */
  }
}

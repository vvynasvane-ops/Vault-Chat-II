// js/appearance.js
//
// Sections 8, 9, 10, 11 — chat wallpaper, home background, dark/light mode,
// and font customization. All settings live in IndexedDB (per-device, like
// SharedPreferences on Android) and are applied through CSS custom
// properties on <html>, so every screen re-themes automatically — nothing
// is hardcoded per-screen (mirrors the shared BaseActivity approach).

import { idb } from "./idb.js";

const SETTINGS_KEY = "appearance";

export const FONT_FAMILIES = {
  Default: "'Rajdhani', sans-serif",
  Medium: "'Rajdhani', sans-serif",
  Condensed: "'Rajdhani', sans-serif",
  Light: "'Rajdhani', sans-serif",
  Black: "'Rajdhani', sans-serif",
  Serif: "Georgia, 'Times New Roman', serif",
  Monospace: "'Courier New', Consolas, monospace",
  Casual: "'Comic Sans MS', cursive",
};

export const FONT_WEIGHTS = {
  Light: 300,
  Regular: 400,
  Medium: 500,
  Bold: 700,
};

export const FONT_COLORS = [
  { name: "Default", value: "" },
  { name: "Cyan", value: "#00e5ff" },
  { name: "White", value: "#f4fbff" },
  { name: "Violet", value: "#b58bff" },
  { name: "Mint", value: "#22ffb0" },
  { name: "Amber", value: "#ffc266" },
  { name: "Rose", value: "#ff8fa8" },
  { name: "Slate", value: "#9db2c4" },
  { name: "Coral", value: "#ff8a65" },
  { name: "Sky", value: "#7dd3fc" },
];

const DEFAULTS = {
  theme: "dark", // "dark" | "light"
  fontFamily: "Default",
  fontWeight: "Regular",
  fontSizePct: 100, // 85–135
  fontColor: "", // "" = no override, keep each screen's own color
  accent: "", // "" = theme default; otherwise "#rrggbb" from the RGB mixer
  // ── Chat Studio ──
  bubbleMine: "", // "" = theme default; otherwise "#rrggbb" for your bubbles
  bubbleTheirs: "", // "" = theme default; otherwise "#rrggbb" for their bubbles
  chatTint: "", // "" = none; otherwise "#rrggbb" wash over the chat area
  bubbleShape: "shard", // see BUBBLE_SHAPES
  bubbleFx: "none", // see BUBBLE_FX
  scrim: "", // "" = auto-dim wallpapers for readability; otherwise 0–90 (%)
  chatPreset: "", // id of the last preset applied (highlight only)
};

export const BUBBLE_SHAPES = [
  { id: "shard", name: "Shard" },
  { id: "round", name: "Round" },
  { id: "cloud", name: "Cloud" },
  { id: "leaf", name: "Leaf" },
  { id: "sharp", name: "Sharp" },
];

export const BUBBLE_FX = [
  { id: "none", name: "Plain" },
  { id: "glow", name: "Glow" },
  { id: "shimmer", name: "Shimmer" },
];

// One tap re-themes the whole chat: your bubbles, theirs, the wash behind
// them, the shape, the effect and the app accent.
export const CHAT_PRESETS = [
  { id: "default", name: "♻️ Default", mine: "", theirs: "", tint: "", accent: "", shape: "shard", fx: "none" },
  { id: "neon-dusk", name: "🌌 Neon Dusk", mine: "#7c5cff", theirs: "#1b1640", tint: "#5b3fd6", accent: "#a78bff", shape: "shard", fx: "shimmer" },
  { id: "sakura", name: "🌸 Sakura", mine: "#ec5f8f", theirs: "#3a1c2c", tint: "#d6457a", accent: "#ff8fb3", shape: "leaf", fx: "none" },
  { id: "deep-ocean", name: "🌊 Deep Ocean", mine: "#0e8fb8", theirs: "#0a2433", tint: "#0b6e96", accent: "#3fd4ff", shape: "cloud", fx: "glow" },
  { id: "matrix", name: "🟩 Matrix", mine: "#17a84f", theirs: "#07150c", tint: "#11803a", accent: "#39ff7a", shape: "sharp", fx: "glow" },
  { id: "solar-flare", name: "🔥 Solar Flare", mine: "#ff7a1a", theirs: "#301d0e", tint: "#c45500", accent: "#ffb15c", shape: "round", fx: "glow" },
  { id: "glacier", name: "🧊 Glacier", mine: "#3f8fe8", theirs: "#e8f2ff", tint: "#5aa8ff", accent: "#3f8fe8", shape: "round", fx: "none" },
  { id: "royal-gold", name: "👑 Royal Gold", mine: "#b8862a", theirs: "#26200f", tint: "#8a6414", accent: "#e3b04b", shape: "leaf", fx: "shimmer" },
  { id: "ink-paper", name: "🖋️ Ink & Paper", mine: "#2c2c36", theirs: "#f2efe6", tint: "#8a8a96", accent: "", shape: "sharp", fx: "none" },
];

let cache = null;
let lastSettings = null;
let wallLum = 0.5; // measured brightness (0–1) of the current chat wallpaper

export async function loadAppearance() {
  if (cache) return cache;
  const stored = await idb.get("settings", SETTINGS_KEY);
  cache = { ...DEFAULTS, ...(stored || {}) };
  return cache;
}

export async function saveAppearance(partial) {
  cache = { ...(cache || DEFAULTS), ...partial };
  // Apply first so the UI never waits on (or breaks because of) storage.
  applyAppearance(cache);
  try {
    await idb.put("settings", cache, SETTINGS_KEY);
  } catch (err) {
    console.warn("Could not persist appearance settings:", err);
  }
  return cache;
}

export async function resetAppearanceText() {
  // "Reset text style to default" — restores family/weight/size/color only,
  // leaves the dark/light theme choice untouched.
  return saveAppearance({
    fontFamily: DEFAULTS.fontFamily,
    fontWeight: DEFAULTS.fontWeight,
    fontSizePct: DEFAULTS.fontSizePct,
    fontColor: DEFAULTS.fontColor,
  });
}

// Applies live, across every screen, via CSS variables read by style.css —
// no per-screen wiring needed, and no screen can be missed.
export function applyAppearance(settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  const fam = FONT_FAMILIES[settings.fontFamily] || FONT_FAMILIES.Default;
  // In Ancient mode the stock (Rajdhani) choices follow the era's own typeface.
  const eraFont = root.dataset.era === "ancient" && fam.includes("Rajdhani");
  root.style.setProperty("--user-font-family", eraFont ? "var(--font-body)" : fam);
  root.style.setProperty("--user-font-weight", String(FONT_WEIGHTS[settings.fontWeight] ?? 400));
  root.style.setProperty("--user-font-scale", String(Math.max(0.85, Math.min(1.35, settings.fontSizePct / 100))));
  root.style.setProperty("--user-font-color", settings.fontColor || "inherit");
  root.classList.toggle("font-color-override", !!settings.fontColor);
  applyAccent(settings.accent, settings.theme);
  lastSettings = settings;
  applyChatTheme(settings);
  updateScrim();
}

// ─── Accent colour (RGB mixer) ───────────────────────────────────────────
// One colour drives the glow/border/highlight variables, so every screen
// re-tints live. An empty value removes the overrides and the theme's own
// palette comes back untouched.

const ACCENT_VARS = ["--cyan", "--cyan-dim", "--cyan-glow", "--border", "--plasma-glow", "--accent-rgb"];

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function applyAccent(hex, theme) {
  const root = document.documentElement;
  const rgb = parseHex(hex);
  if (!rgb) {
    ACCENT_VARS.forEach((v) => root.style.removeProperty(v));
    root.classList.remove("has-accent");
    return;
  }
  // Light mode needs a deeper tone to stay readable on white panels.
  const k = theme === "light" ? 0.78 : 1;
  const [r, g, b] = rgb.map((c) => Math.round(c * k));
  const [dr, dg, db] = [r, g, b].map((c) => Math.round(c * 0.62));
  root.style.setProperty("--cyan", `rgb(${r}, ${g}, ${b})`);
  root.style.setProperty("--cyan-dim", `rgb(${dr}, ${dg}, ${db})`);
  root.style.setProperty("--cyan-glow", `rgba(${r}, ${g}, ${b}, 0.38)`);
  root.style.setProperty("--border", `rgba(${r}, ${g}, ${b}, 0.26)`);
  root.style.setProperty("--plasma-glow", `rgba(${r}, ${g}, ${b}, 0.45)`);
  root.style.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  root.classList.add("has-accent");
}

export async function initAppearance() {
  const settings = await loadAppearance();
  applyAppearance(settings);
  return settings;
}


// ─── Chat Studio: bubble colours, tint, shape, effect, readability ───────
// Messages must stay legible on ANY wallpaper, so bubbles always get an
// (almost) opaque backing and their text colour is chosen by contrast math,
// never by guesswork. The wallpaper itself is dimmed/lightened automatically
// from its measured brightness unless the person sets the dimming manually.

function relLum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// White or near-black, whichever has the higher contrast on this colour.
function textOn(rgb) {
  const L = relLum(rgb);
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.054 ? "#ffffff" : "#0b0d14";
}

const scale = (rgb, k) => rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * k))));
const toward = (rgb, to, t) => rgb.map((c, i) => Math.round(c + (to[i] - c) * t));
const CHAT_VARS = [
  "--bubble-mine-1", "--bubble-mine-2", "--bubble-mine-text", "--bubble-mine-glow",
  "--bubble-theirs-bg", "--bubble-theirs-text", "--chat-tint-rgb", "--wp-rgb",
];

const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hexToRgb = (h) => parseHex(h) || [255, 255, 255];

// Nudge both gradient ends until the text reaches WCAG AA (4.5:1) on each.
function ensureContrast(c1, c2, textHex) {
  const text = hexToRgb(textHex);
  const darkenText = textHex === "#ffffff";
  for (let i = 0; i < 8; i++) {
    if (contrast(c1, text) >= 4.5 && contrast(c2, text) >= 4.5) break;
    c1 = darkenText ? scale(c1, 0.88) : toward(c1, [255, 255, 255], 0.2);
    c2 = darkenText ? scale(c2, 0.88) : toward(c2, [255, 255, 255], 0.2);
  }
  return [c1, c2];
}

export function applyChatTheme(settings) {
  const root = document.documentElement;
  const light = settings.theme === "light";

  // Your bubbles: explicit colour > derived from the accent > theme default
  const custom = parseHex(settings.bubbleMine);
  const fromAccent = parseHex(settings.accent);
  const mine = custom || fromAccent;
  if (mine) {
    let c1 = custom ? mine : scale(mine, 0.72);
    let c2 = custom ? scale(mine, 0.55) : scale(mine, 0.45);
    const textHex = textOn(scale(mine, custom ? 0.78 : 0.58));
    [c1, c2] = ensureContrast(c1, c2, textHex);
    root.style.setProperty("--bubble-mine-1", `rgb(${c1.join(",")})`);
    root.style.setProperty("--bubble-mine-2", `rgb(${c2.join(",")})`);
    root.style.setProperty("--bubble-mine-text", textHex);
    root.style.setProperty("--bubble-mine-glow", `rgba(${mine.join(",")}, 0.55)`);
    root.classList.add("has-bubble-mine");
  } else {
    ["--bubble-mine-1", "--bubble-mine-2", "--bubble-mine-text", "--bubble-mine-glow"].forEach((v) => root.style.removeProperty(v));
    root.classList.remove("has-bubble-mine");
  }

  // Their bubbles
  const theirs = parseHex(settings.bubbleTheirs);
  if (theirs) {
    root.style.setProperty("--bubble-theirs-bg", `rgba(${theirs.join(",")}, 0.95)`);
    root.style.setProperty("--bubble-theirs-text", textOn(theirs));
    root.classList.add("has-bubble-theirs");
  } else {
    root.style.removeProperty("--bubble-theirs-bg");
    root.style.removeProperty("--bubble-theirs-text");
    root.classList.remove("has-bubble-theirs");
  }

  // Chat tint (also colours the wallpaper dimming layer)
  const tint = parseHex(settings.chatTint);
  if (tint) {
    root.style.setProperty("--chat-tint-rgb", tint.join(", "));
    root.style.setProperty("--wp-rgb", (light ? toward(tint, [255, 255, 255], 0.88) : scale(tint, 0.16)).join(", "));
    root.classList.add("has-chat-tint");
  } else {
    root.style.removeProperty("--chat-tint-rgb");
    root.style.removeProperty("--wp-rgb");
    root.classList.remove("has-chat-tint");
  }

  root.dataset.bubble = BUBBLE_SHAPES.some((x) => x.id === settings.bubbleShape) ? settings.bubbleShape : "shard";
  root.dataset.bubbleFx = BUBBLE_FX.some((x) => x.id === settings.bubbleFx) ? settings.bubbleFx : "none";
}

// Dimming layer strength over the chat wallpaper (0–0.9)
export function updateScrim() {
  const root = document.documentElement;
  const s = lastSettings || DEFAULTS;
  const manual = s.scrim === "" || s.scrim === null || s.scrim === undefined ? NaN : Number(s.scrim);
  let v;
  if (Number.isFinite(manual)) {
    v = manual / 100;
  } else if (s.theme === "light") {
    v = 0.4 + (1 - wallLum) * 0.35; // dark photo on a light UI → lighten more
  } else {
    v = 0.3 + wallLum * 0.4; // bright photo on a dark UI → darken more
  }
  root.style.setProperty("--wp-scrim", String(Math.max(0, Math.min(0.9, v)).toFixed(2)));
}

async function measureLuminance(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, 24, 24);
    if (bmp.close) bmp.close();
    const d = ctx.getImageData(0, 0, 24, 24).data;
    const all = [];
    for (let i = 0; i < d.length; i += 4) all.push(relLum([d[i], d[i + 1], d[i + 2]]));
    all.sort((a, b) => a - b);
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const p85 = all[Math.floor(all.length * 0.85)];
    // Bright pockets matter as much as the average for text legibility
    return Math.max(0, Math.min(1, mean * 0.6 + p85 * 0.4));
  } catch (_) {
    return 0.5;
  }
}

// ─── Wallpapers (Section 8 — per chat, Section 9 — home screen) ──────────
// Stabilized storage: the picked image is copied into IndexedDB (this app's
// own private storage) rather than only holding a reference to the original
// file, so it survives reloads. If a stored wallpaper is ever unreadable,
// callers should fail safe and just clear the setting (see applyWallpaper).

export async function setWallpaper(key, file) {
  await idb.put("wallpapers", file, key);
}

export async function clearWallpaper(key) {
  await idb.delete("wallpapers", key);
}

export async function applyWallpaper(key, targetEl) {
  try {
    const blob = await idb.get("wallpapers", key);
    if (blob) {
      const url = URL.createObjectURL(blob);
      const prev = targetEl._wpUrl;
      targetEl.style.backgroundImage = `url(${url})`;
      targetEl.classList.add("has-wallpaper");
      // The chat log layers [vignette + dimming + image] in one background (see
      // future.css). A background belongs to the box, not the scrolling
      // content, so the dimming can never scroll away from the picture.
      targetEl.style.setProperty("--wp-image", `url("${url}")`);
      targetEl._wpUrl = url;
      if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1000); // don't leak old images
      if (targetEl.classList.contains("message-log")) {
        wallLum = await measureLuminance(blob);
        updateScrim();
      }
      return true;
    }
  } catch (_) {
    // Fail-safe: referenced file missing/unreadable — quietly clear it
    // instead of showing a broken image or crashing (Section 14).
    await clearWallpaper(key).catch(() => {});
  }
  targetEl.style.backgroundImage = "";
  targetEl.style.removeProperty("--wp-image");
  targetEl.classList.remove("has-wallpaper");
  if (targetEl._wpUrl) {
    URL.revokeObjectURL(targetEl._wpUrl);
    targetEl._wpUrl = null;
  }
  if (targetEl.classList.contains("message-log")) {
    wallLum = 0.5;
    updateScrim();
  }
  return false;
}

// ─── Contact prefs: favourite / mute (Section 2, local-only) ────────────

export async function getContactPrefs(uid) {
  return (await idb.get("settings", `contactPrefs:${uid}`)) || { favorite: false, muted: false };
}

export async function setContactPrefs(uid, prefs) {
  const current = await getContactPrefs(uid);
  const merged = { ...current, ...prefs };
  await idb.put("settings", merged, `contactPrefs:${uid}`);
  return merged;
}

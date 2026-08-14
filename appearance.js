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
};

let cache = null;

export async function loadAppearance() {
  if (cache) return cache;
  const stored = await idb.get("settings", SETTINGS_KEY);
  cache = { ...DEFAULTS, ...(stored || {}) };
  return cache;
}

export async function saveAppearance(partial) {
  cache = { ...(cache || DEFAULTS), ...partial };
  await idb.put("settings", cache, SETTINGS_KEY);
  applyAppearance(cache);
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
  root.style.setProperty("--user-font-family", FONT_FAMILIES[settings.fontFamily] || FONT_FAMILIES.Default);
  root.style.setProperty("--user-font-weight", String(FONT_WEIGHTS[settings.fontWeight] ?? 400));
  root.style.setProperty("--user-font-scale", String(Math.max(0.85, Math.min(1.35, settings.fontSizePct / 100))));
  root.style.setProperty("--user-font-color", settings.fontColor || "inherit");
  root.classList.toggle("font-color-override", !!settings.fontColor);
}

export async function initAppearance() {
  const settings = await loadAppearance();
  applyAppearance(settings);
  return settings;
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
      targetEl.style.backgroundImage = `url(${url})`;
      targetEl.classList.add("has-wallpaper");
      return true;
    }
  } catch (_) {
    // Fail-safe: referenced file missing/unreadable — quietly clear it
    // instead of showing a broken image or crashing (Section 14).
    await clearWallpaper(key).catch(() => {});
  }
  targetEl.style.backgroundImage = "";
  targetEl.classList.remove("has-wallpaper");
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

// era.js — "Time travel": flips the whole UI between the Year-7026 future
// theme and Ancient mode (≈ 5,000 years back, 2974 BCE: sandstone, gold,
// lapis and terracotta). Works on both the sign-in page and the chat page.
//
// Markup stays declarative: any element carrying [data-era-toggle] becomes a
// time-travel button. The choice is kept in localStorage ("vc_era") so it is
// applied on the very next load, and it syncs across open tabs.

import { loadAppearance, applyAppearance } from "./appearance.js";

const KEY = "vc_era";
const YEAR_FUTURE = 7026;
const YEAR_ANCIENT = -2974; // 5,000 years before 2026
const root = document.documentElement;
const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let busy = false;

function getStoredEra() {
  try {
    return localStorage.getItem(KEY) === "ancient" ? "ancient" : "future";
  } catch (_) {
    return "future";
  }
}

function storeEra(era) {
  try {
    localStorage.setItem(KEY, era);
  } catch (_) {}
}

function fmtYear(y) {
  const r = Math.round(y);
  return r > 0 ? `${r} CE` : `${Math.max(1, -r)} BCE`;
}

// Flavour text that changes with the era. Originals are remembered and
// restored exactly when you return to the future.
const LABELS = { "ZONE": "REALM", "LINK UPTIME": "REIGN", "CHANNEL": "SEAL" };
const origText = new WeakMap();

function swapLabels(ancient) {
  document.querySelectorAll(".hud-stat .k").forEach((el) => {
    if (ancient) {
      if (!origText.has(el)) origText.set(el, el.textContent);
      const base = origText.get(el);
      if (LABELS[base]) el.textContent = LABELS[base];
    } else if (origText.has(el)) {
      el.textContent = origText.get(el);
      origText.delete(el);
    }
  });
  document.querySelectorAll(".hud-greeting").forEach((el) => {
    el.childNodes.forEach((n) => {
      if (n.nodeType !== 3) return;
      if (ancient && n.data.includes("SECURE LINK ONLINE")) {
        origText.set(n, n.data);
        n.data = n.data.replace("SECURE LINK ONLINE", "THE SEAL HOLDS");
      } else if (!ancient && origText.has(n)) {
        n.data = origText.get(n);
        origText.delete(n);
      }
    });
  });
  const input = document.getElementById("message-input");
  if (input) {
    if (ancient) {
      if (input.dataset.eraPh === undefined) input.dataset.eraPh = input.placeholder;
      input.placeholder = "Carve your message in clay…";
    } else if (input.dataset.eraPh !== undefined) {
      input.placeholder = input.dataset.eraPh;
      delete input.dataset.eraPh;
    }
  }
}

function updateButtons(era) {
  document.querySelectorAll("[data-era-toggle]").forEach((b) => {
    if (era === "ancient") {
      b.textContent = `🚀 Return to ${YEAR_FUTURE}`;
      b.title = "Travel back to the future";
    } else {
      b.textContent = `🏺 Ancient mode · ${fmtYear(YEAR_ANCIENT)}`;
      b.title = "Travel 5,000 years into the past";
    }
    b.setAttribute("aria-pressed", era === "ancient" ? "true" : "false");
  });
}

function apply(era) {
  const ancient = era === "ancient";
  root.dataset.era = ancient ? "ancient" : "future";
  swapLabels(ancient);
  updateButtons(era);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute("content", ancient ? "#15100a" : "#05040d");
  });
  window.dispatchEvent(new CustomEvent("eraChanged", { detail: { era: root.dataset.era } }));
}

// Fonts and accent-derived colours follow the era (chat page only).
async function refreshAppearance() {
  if (!document.getElementById("app-shell")) return;
  try {
    // Never let a slow/blocked storage read hold the switch hostage.
    const settings = await Promise.race([loadAppearance(), new Promise((r) => setTimeout(() => r(null), 1500))]);
    if (settings) applyAppearance(settings);
  } catch (_) {}
}

// A small pill that fades in and out after the change: "2974 BCE · Ancient mode".
function showPill(era) {
  document.querySelectorAll(".era-pill").forEach((n) => n.remove());
  const pill = document.createElement("div");
  pill.className = "era-pill";
  pill.setAttribute("aria-hidden", "true");
  pill.textContent = era === "ancient" ? `${fmtYear(YEAR_ANCIENT)} · Ancient mode` : `${fmtYear(YEAR_FUTURE)} · Future mode`;
  document.body.appendChild(pill);
  requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.add("show")));
  setTimeout(() => pill.classList.remove("show"), 1700);
  setTimeout(() => pill.remove(), 2400);
}

// Smooth change: the browser snapshots the old page, we swap the theme
// underneath, and the new page dissolves in over it (no rings, no loops).
// Browsers without View Transitions get a gentle colour morph instead.
function travel(toEra) {
  if (busy) return;
  busy = true;
  // Watchdog: whatever happens, the button works again after a few seconds.
  setTimeout(() => {
    busy = false;
  }, 4000);

  const swap = async () => {
    try {
      storeEra(toEra);
      apply(toEra);
      await refreshAppearance();
    } catch (err) {
      console.warn("Era switch problem:", err);
    }
  };
  const finish = () => {
    root.classList.remove("era-morph");
    busy = false;
    showPill(toEra);
  };

  if (reduceMotion()) {
    swap().finally(() => {
      busy = false;
    });
    return;
  }

  if (typeof document.startViewTransition === "function") {
    try {
      const vt = document.startViewTransition(swap);
      vt.finished.catch(() => {}).finally(finish);
      return;
    } catch (_) {
      /* fall through to the morph */
    }
  }

  root.classList.add("era-morph");
  swap().finally(() => setTimeout(finish, 900));
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("[data-era-toggle]");
  if (!btn) return;
  e.preventDefault();
  travel(root.dataset.era === "ancient" ? "future" : "ancient");
});

window.addEventListener("storage", (e) => {
  if (e.key === KEY && !busy) {
    apply(getStoredEra());
    refreshAppearance();
  }
});

apply(getStoredEra());

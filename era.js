// era.js — "Time travel": flips the whole UI between the Year-7026 future
// theme and Ancient mode (≈ 5,000 years back, 2974 BCE: sandstone, gold,
// lapis and terracotta). Works on both the sign-in page and the chat page.
//
// Markup stays declarative: any element carrying [data-era-toggle] becomes a
// time-travel button. The choice is kept in localStorage ("vc_era") so it is
// applied on the very next load, and it syncs across open tabs.

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
  return r > 0 ? `${r} CE` : `${1 - r > 0 ? 1 - r : 1} BCE`;
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
  // Fonts follow the era unless a specific family was picked (chat page only).
  if (document.getElementById("app-shell")) {
    import("./appearance.js")
      .then((m) => m.loadAppearance().then((s) => m.applyAppearance(s)))
      .catch(() => {});
  }
  window.dispatchEvent(new CustomEvent("eraChanged", { detail: { era: root.dataset.era } }));
}

// The "wormhole": a full-screen year counter that spins through the centuries,
// swaps the theme while the screen is covered, then fades away.
function warp(toEra) {
  if (busy) return;
  busy = true;
  const toAncient = toEra === "ancient";
  const from = toAncient ? YEAR_FUTURE : YEAR_ANCIENT;
  const to = toAncient ? YEAR_ANCIENT : YEAR_FUTURE;

  if (reduceMotion()) {
    storeEra(toEra);
    apply(toEra);
    busy = false;
    return;
  }

  const o = document.createElement("div");
  o.className = `era-warp ${toAncient ? "to-ancient" : "to-future"}`;
  o.setAttribute("aria-hidden", "true");
  o.innerHTML =
    '<div class="era-warp-rings"></div>' +
    '<div class="era-warp-year"></div>' +
    '<div class="era-warp-sub"></div>';
  document.body.appendChild(o);
  const yearEl = o.querySelector(".era-warp-year");
  const subEl = o.querySelector(".era-warp-sub");
  subEl.textContent = toAncient
    ? "Travelling 10,000 years into the past…"
    : "Returning to the future…";
  yearEl.textContent = fmtYear(from);

  const DURATION = 1700;
  const start = performance.now();
  let swapped = false;

  function step(now) {
    const t = Math.min(1, (now - start) / DURATION);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    yearEl.textContent = fmtYear(from + (to - from) * e);
    if (!swapped && t >= 0.55) {
      swapped = true;
      storeEra(toEra);
      apply(toEra);
    }
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      yearEl.textContent = fmtYear(to);
      o.classList.add("out");
      setTimeout(() => {
        o.remove();
        busy = false;
      }, 520);
    }
  }
  requestAnimationFrame(step);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("[data-era-toggle]");
  if (!btn) return;
  e.preventDefault();
  warp(root.dataset.era === "ancient" ? "future" : "ancient");
});

window.addEventListener("storage", (e) => {
  if (e.key === KEY && !busy) apply(getStoredEra());
});

apply(getStoredEra());

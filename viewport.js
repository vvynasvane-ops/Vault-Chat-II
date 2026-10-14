// viewport.js — keeps the app glued to the *visible* viewport.
//
// The gap between the message bar and the keyboard on phones had three causes:
//   1. The layout was sized to 100dvh, which on most mobile browsers does NOT
//      shrink when the on-screen keyboard opens — the browser instead scrolls
//      the page, leaving a strip of empty space between composer and keyboard.
//   2. The composer kept `env(safe-area-inset-bottom)` padding (the home-bar
//      allowance) even while the keyboard covered that area.
//   3. Tapping Send blurred the field, so the keyboard collapsed and reopened.
//
// This module measures window.visualViewport (the part of the page actually
// visible above the keyboard), publishes it as CSS variables, and flags
// html.kb-open so the stylesheet can drop the extra padding.

const root = document.documentElement;
const vv = window.visualViewport;
const log = document.getElementById("message-log");

let baseline = 0; // tallest viewport seen in this orientation = "keyboard closed"
let orient = window.innerWidth > window.innerHeight ? "l" : "p";
let stickToBottom = true;

if (log) {
  log.addEventListener(
    "scroll",
    () => {
      stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
    },
    { passive: true }
  );
}

function isTextEntry(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !["checkbox", "radio", "range", "file", "button", "submit"].includes(el.type);
}

function sync() {
  const h = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;

  const nowOrient = window.innerWidth > window.innerHeight ? "l" : "p";
  if (nowOrient !== orient) {
    orient = nowOrient;
    baseline = 0;
  }
  baseline = Math.max(baseline, h + top, window.innerHeight);

  const kb = Math.max(0, baseline - (h + top));
  const open = kb > 110 && (isTextEntry(document.activeElement) || kb > 180);

  root.style.setProperty("--app-h", `${Math.round(h)}px`);
  root.style.setProperty("--app-top", `${Math.round(top)}px`);
  root.style.setProperty("--kb", `${open ? Math.round(kb) : 0}px`);
  root.classList.add("vv-ready");
  root.classList.toggle("kb-open", open);

  // The page itself must never scroll — only the message log does.
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);

  if (log && stickToBottom) {
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }
}

let raf = 0;
function schedule() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(sync);
}

if (vv) {
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
}
window.addEventListener("resize", schedule);
window.addEventListener("orientationchange", () => {
  baseline = 0;
  setTimeout(schedule, 250);
});

// The keyboard animates in over ~250ms; re-measure while it settles.
document.addEventListener("focusin", () => {
  [0, 80, 250, 500].forEach((ms) => setTimeout(schedule, ms));
});
document.addEventListener("focusout", () => {
  [0, 120, 350].forEach((ms) => setTimeout(schedule, ms));
});

sync();

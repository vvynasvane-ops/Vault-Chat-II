// noautofill.js — keeps browser / password-manager autofill OUT of every field
// that isn't a genuine credential field.
//
// Why this exists: browsers decide what to autofill from page-wide heuristics
// (field ids, placeholders, "a text box sitting before a password box"). On
// VaultChatt that meant a saved email or password could be dropped into the
// username box, the display-name box, the contact search, the ID-code box…
//
// Defence in depth, because no single trick works in every browser:
//   1. Every non-credential field gets autocomplete="off" (password-type
//      fields get "new-password", which browsers never fill with a saved login),
//      an opaque name, and the opt-out flags honoured by 1Password, LastPass
//      and Bitwarden.
//   2. A CSS animation hook (see style.css) fires `animationstart` the instant
//      the browser autofills one of those fields, and we wipe the value.
//   3. A few timed sweeps + focus/pageshow checks catch late fills.
//
// A field opts back IN with data-autofill="allow" (only the sign-in email and
// password on index.html, and only while in sign-in mode).

const NON_TEXT = new Set([
  "checkbox", "radio", "range", "file", "button", "submit", "reset",
  "image", "color", "hidden",
]);

function isField(el) {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function isAutofilled(el) {
  // Chrome/Safari/Edge use :-webkit-autofill, Firefox + modern Chrome :autofill.
  // They must be tested separately: one unknown selector voids a whole list.
  for (const sel of [":-webkit-autofill", ":autofill"]) {
    try {
      if (el.matches(sel)) return true;
    } catch (_) { /* selector unsupported here */ }
  }
  return false;
}

export function guardField(el) {
  if (!isField(el)) return;
  const type = (el.getAttribute("type") || "text").toLowerCase();
  if (NON_TEXT.has(type)) return;

  if (el.dataset.autofill === "allow") {
    // A real credential field: let the browser help, drop our opt-out flags.
    el.removeAttribute("data-lpignore");
    el.removeAttribute("data-1p-ignore");
    el.removeAttribute("data-bwignore");
    el.removeAttribute("data-form-type");
    return;
  }

  el.setAttribute("autocomplete", type === "password" ? "new-password" : "off");
  el.setAttribute("data-lpignore", "true");
  el.setAttribute("data-1p-ignore", "true");
  el.setAttribute("data-bwignore", "true");
  el.setAttribute("data-form-type", "other");
  // An opaque name: "username"/"email"-looking names are what heuristics key on.
  if (!el.name || !el.name.startsWith("vc-")) {
    el.name = "vc-" + Math.random().toString(36).slice(2, 10);
  }
}

function wipeIfAutofilled(el) {
  if (!isField(el) || el.dataset.autofill === "allow") return;
  if (el.dataset.vcTouched === "1") return; // the person is typing here — hands off
  if (isAutofilled(el) && el.value !== "") {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (isAutofilled(el)) {
    // Chrome hides the filled value from scripts until a gesture; resetting
    // it still clears the visible fill.
    el.value = "";
  }
}

function sweep() {
  document.querySelectorAll("input, textarea").forEach(wipeIfAutofilled);
}

export function refreshAutofillGuard() {
  document.querySelectorAll("input, textarea").forEach(guardField);
  sweep();
}

function markTouched(e) {
  const el = e.target;
  if (isField(el)) el.dataset.vcTouched = "1";
}

function init() {
  refreshAutofillGuard();

  // Real user input marks the field as "theirs" so we never wipe typed text.
  ["keydown", "beforeinput", "paste", "cut", "drop", "compositionstart"].forEach((evt) =>
    document.addEventListener(evt, markTouched, true)
  );
  document.addEventListener(
    "input",
    (e) => {
      if (isField(e.target) && e.target.value === "") delete e.target.dataset.vcTouched;
    },
    true
  );

  // The CSS hook in style.css starts this animation the moment a browser fills a field.
  document.addEventListener(
    "animationstart",
    (e) => {
      if (e.animationName === "vc-autofill-start") wipeIfAutofilled(e.target);
    },
    true
  );

  document.addEventListener("focusin", (e) => wipeIfAutofilled(e.target));
  window.addEventListener("pageshow", sweep); // back/forward-cache restores
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sweep();
  });

  // Late fills (password managers can take a couple of seconds).
  [0, 120, 400, 1000, 2200, 4000].forEach((ms) => setTimeout(sweep, ms));

  // Fields added later (dialogs, dynamic rows) and mode switches on the auth page.
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") {
        guardField(m.target);
        continue;
      }
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (isField(n)) guardField(n);
        n.querySelectorAll?.("input, textarea").forEach(guardField);
      });
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-autofill"],
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

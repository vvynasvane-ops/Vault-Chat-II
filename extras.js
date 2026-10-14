// extras.js — composer polish + three new features for the web terminal.
//
//   1. DRAFT SAVER     — unsent text is remembered per conversation, so
//                        switching chats (or a refresh) never eats a message.
//   2. CHAT SEARCH     — find any word in the open conversation, highlight
//                        every hit, hop between them.
//   3. VAULT LOCK      — optional PIN screen with auto-lock, plus a privacy
//                        shield that blurs the app in the task switcher.
//
// Also: auto-growing message box, Enter-to-send on desktop, the "+" tool tray
// on phones, and keeping the keyboard open when Send is tapped.

const $ = (id) => document.getElementById(id);

const els = {
  input: $("message-input"),
  form: $("message-form"),
  log: $("message-log"),
  appShell: $("app-shell"),
  contactList: $("contact-list"),
};

// Hooks supplied by app.js (see initExtras).
let ctx = {
  getActiveUid: () => null,
  isEditing: () => false,
  signOut: null,
  toast: () => {},
};

export function initExtras(c) {
  ctx = { ...ctx, ...c };
}

// ═══════════════════════════════════════════════════════════════════════
// Composer: auto-grow, Enter-to-send, keyboard stays up, "+" tool tray
// ═══════════════════════════════════════════════════════════════════════

export function autoGrowComposer() {
  const t = els.input;
  if (!t) return;
  t.style.height = "auto";
  const max = parseFloat(getComputedStyle(t).maxHeight) || 160;
  const border = t.offsetHeight - t.clientHeight;
  const want = t.scrollHeight + border;
  t.style.height = `${Math.min(want, max)}px`;
  t.style.overflowY = want > max ? "auto" : "hidden";
}

function setupComposer() {
  if (!els.input || !els.form) return;
  const submitBtn = els.form.querySelector('button[type="submit"]');

  els.input.addEventListener("input", onComposerInput);

  // Desktop (mouse + physical keyboard): Enter sends, Shift+Enter = new line.
  // Phones keep Enter as a new line — the Send button is right there.
  els.input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    e.preventDefault();
    if (submitBtn && !submitBtn.disabled) {
      if (els.form.requestSubmit) els.form.requestSubmit();
      else els.form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
  });

  // Tapping Send must not steal focus — otherwise the keyboard collapses and
  // re-opens on every message (the visible "jump" between bar and keyboard).
  const keepFocus = (e) => e.preventDefault();
  ["pointerdown", "mousedown"].forEach((evt) => {
    submitBtn?.addEventListener(evt, keepFocus);
    $("btn-tools")?.addEventListener(evt, keepFocus);
  });

  // "+" tray (phones)
  const toggle = $("btn-tools");
  const tray = $("composer-tools");
  const closeTray = () => {
    els.form.classList.remove("tools-open");
    toggle?.setAttribute("aria-expanded", "false");
  };
  toggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = els.form.classList.toggle("tools-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  tray?.addEventListener("click", (e) => {
    if (e.target.closest("button")) setTimeout(closeTray, 0);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#composer-tools, #btn-tools")) closeTray();
  });

  autoGrowComposer();
  window.addEventListener("resize", autoGrowComposer);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Draft saver
// ═══════════════════════════════════════════════════════════════════════

const DRAFT_PREFIX = "vc_draft:";
let draftTimer = null;
let pendingDraft = null; // { uid, text } — captured at typing time, so a fast chat-switch can't cross wires

function flushDraft() {
  clearTimeout(draftTimer);
  if (pendingDraft) {
    saveDraft(pendingDraft.uid, pendingDraft.text);
    pendingDraft = null;
  }
}

function onComposerInput() {
  autoGrowComposer();
  const uid = ctx.getActiveUid();
  if (!uid || ctx.isEditing()) return; // an edit isn't a draft
  if (pendingDraft && pendingDraft.uid !== uid) flushDraft(); // never drop the other chat's text
  pendingDraft = { uid, text: els.input.value };
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 250);
}

function saveDraft(uid, text) {
  try {
    if (text.trim()) localStorage.setItem(DRAFT_PREFIX + uid, text);
    else localStorage.removeItem(DRAFT_PREFIX + uid);
  } catch (_) {}
  markDrafts();
}

function restoreDraft(uid) {
  let text = "";
  try {
    text = localStorage.getItem(DRAFT_PREFIX + uid) || "";
  } catch (_) {}
  els.input.value = text;
  els.input.dispatchEvent(new Event("input", { bubbles: true })); // refresh Send + height
}

export function afterSend(uid) {
  clearTimeout(draftTimer);
  if (pendingDraft && pendingDraft.uid === uid) pendingDraft = null;
  try {
    localStorage.removeItem(DRAFT_PREFIX + uid);
  } catch (_) {}
  els.input.dispatchEvent(new Event("input", { bubbles: true })); // re-sync Send button + height
  markDrafts();
}

export function afterEditEnd(uid) {
  restoreDraft(uid); // bring back whatever was being typed before the edit
}

export function clearAllDrafts() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(DRAFT_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) {}
}

function markDrafts() {
  document.querySelectorAll("#contact-list .contact-row").forEach((row) => {
    let has = false;
    try {
      has = !!localStorage.getItem(DRAFT_PREFIX + row.dataset.uid);
    } catch (_) {}
    row.classList.toggle("has-draft", has);
  });
}

function watchContactList() {
  if (!els.contactList) return;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      markDrafts();
    });
  }).observe(els.contactList, { childList: true });
}

export function onConversationOpened(uid) {
  flushDraft(); // save whatever was being typed in the chat we're leaving
  closeSearch();
  restoreDraft(uid);
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Search in conversation
// ═══════════════════════════════════════════════════════════════════════

const search = {
  bar: $("chat-search-bar"),
  input: $("chat-search-input"),
  count: $("chat-search-count"),
  prev: $("chat-search-prev"),
  next: $("chat-search-next"),
  close: $("chat-search-close"),
  hits: [],
  cur: -1,
  timer: null,
};

function clearMarks() {
  els.log?.querySelectorAll("mark.hit").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
  search.hits = [];
  search.cur = -1;
}

function runSearch() {
  clearMarks();
  const q = search.input.value.trim().toLowerCase();
  if (q) {
    els.log.querySelectorAll(".bubble-text:not(.tombstone)").forEach((el) => {
      const text = el.textContent;
      const lower = text.toLowerCase();
      let idx = lower.indexOf(q);
      if (idx < 0) return;
      const frag = document.createDocumentFragment();
      let last = 0;
      while (idx >= 0) {
        frag.append(text.slice(last, idx));
        const mark = document.createElement("mark");
        mark.className = "hit";
        mark.textContent = text.slice(idx, idx + q.length);
        frag.append(mark);
        search.hits.push(mark);
        last = idx + q.length;
        idx = lower.indexOf(q, last);
      }
      frag.append(text.slice(last));
      el.textContent = "";
      el.append(frag);
    });
  }
  if (search.hits.length) goToHit(search.hits.length - 1); // newest first
  else updateCount();
}

function updateCount() {
  const total = search.hits.length;
  search.count.textContent = total ? `${search.cur + 1}/${total}` : search.input.value.trim() ? "0" : "";
  search.prev.disabled = search.next.disabled = total < 2;
}

function goToHit(i) {
  const total = search.hits.length;
  if (!total) return updateCount();
  search.hits[search.cur]?.classList.remove("hit-current");
  search.cur = (i + total) % total;
  const m = search.hits[search.cur];
  m.classList.add("hit-current");
  m.scrollIntoView({ block: "center", behavior: "smooth" });
  updateCount();
}

export function openSearch() {
  if (!search.bar) return;
  search.bar.classList.remove("hidden");
  search.input.focus();
  search.input.select();
}

export function closeSearch() {
  if (!search.bar || search.bar.classList.contains("hidden")) return;
  search.bar.classList.add("hidden");
  search.input.value = "";
  clearMarks();
  updateCount();
}

function setupSearch() {
  if (!search.bar) return;
  search.input.addEventListener("input", () => {
    clearTimeout(search.timer);
    search.timer = setTimeout(runSearch, 160);
  });
  search.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToHit(search.cur + (e.shiftKey ? 1 : -1)); // Enter = older, Shift+Enter = newer
    } else if (e.key === "Escape") closeSearch();
  });
  search.prev.addEventListener("click", () => goToHit(search.cur - 1));
  search.next.addEventListener("click", () => goToHit(search.cur + 1));
  search.close.addEventListener("click", closeSearch);
  $("btn-search-chat")?.addEventListener("click", openSearch);
  $("btn-tool-search")?.addEventListener("click", openSearch);
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Vault Lock — PIN screen, auto-lock, privacy shield
// ═══════════════════════════════════════════════════════════════════════
// Honest scope: this is a *screen* lock. It hides the app and gates the UI,
// like an app-lock on a phone. It does not re-encrypt what is stored locally.

const LOCK_KEY = "vc_lock_v1";
const LOCK_UNTIL_KEY = "vc_lock_until";
const PBKDF2_ITER = 250000;
const AWAY_GRACE_MS = 3000;

const lock = {
  screen: $("lock-screen"),
  dots: $("pin-dots"),
  pad: $("keypad"),
  msg: $("lock-msg"),
  title: $("lock-title"),
  cancel: $("lock-cancel"),
  signout: $("btn-lock-signout"),
  dialog: $("lock-dialog"),
  locked: false,
  mode: "unlock", // unlock | verify-current | create | confirm
  after: null, // what to do once verify-current succeeds: "change" | "remove"
  buffer: "",
  pending: "",
  idleTimer: null,
  hiddenAt: 0,
  suppressUntil: 0,
  cooldownTimer: null,
};

export function isVaultLocked() {
  return lock.locked;
}

function getCfg() {
  try {
    return JSON.parse(localStorage.getItem(LOCK_KEY) || "null");
  } catch (_) {
    return null;
  }
}
function saveCfg(cfg) {
  localStorage.setItem(LOCK_KEY, JSON.stringify(cfg));
}
const hasPin = () => !!getCfg()?.hash;

// ── hashing ──
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin, saltBytes, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return b64(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: iter }, key, 256)
  );
}
async function makeRecord(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), iter: PBKDF2_ITER, hash: await derive(pin, salt, PBKDF2_ITER), len: pin.length };
}
async function verifyPin(pin) {
  const cfg = getCfg();
  if (!cfg?.hash) return false;
  const h = await derive(pin, unb64(cfg.salt), cfg.iter || PBKDF2_ITER);
  let diff = h.length ^ cfg.hash.length;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ (cfg.hash.charCodeAt(i) || 0);
  return diff === 0;
}

// ── overlay rendering ──
function maxLen() {
  return lock.mode === "unlock" || lock.mode === "verify-current" ? getCfg()?.len || 8 : 8;
}

function renderDots() {
  const n = maxLen();
  lock.dots.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const d = document.createElement("i");
    if (i < lock.buffer.length) d.className = "on";
    lock.dots.appendChild(d);
  }
}

function setMessage(text, kind = "") {
  lock.msg.textContent = text;
  lock.msg.dataset.kind = kind;
}

function showOverlay(mode, opts = {}) {
  lock.mode = mode;
  lock.after = opts.after || null;
  lock.buffer = "";
  lock.pending = "";
  const titles = {
    unlock: "VAULT SEALED",
    "verify-current": "VERIFY PIN",
    create: "CREATE PIN",
    confirm: "CONFIRM PIN",
  };
  const prompts = {
    unlock: "Enter your PIN to unlock",
    "verify-current": "Enter your current PIN",
    create: "Choose 4–8 digits, then tap ✓",
    confirm: "Enter the same PIN again",
  };
  lock.title.textContent = titles[mode];
  setMessage(prompts[mode]);
  lock.cancel.classList.toggle("hidden", mode === "unlock");
  lock.signout.classList.toggle("hidden", mode !== "unlock");
  lock.screen.classList.remove("hidden");
  lock.screen.dataset.mode = mode;
  renderDots();
  checkCooldown();
}

function hideOverlay() {
  lock.screen.classList.add("hidden");
  lock.buffer = "";
}

function press(d) {
  if (lock.screen.classList.contains("hidden") || inCooldown()) return;
  if (lock.buffer.length >= maxLen()) return;
  lock.buffer += d;
  renderDots();
  navigator.vibrate?.(8);
  if ((lock.mode === "unlock" || lock.mode === "verify-current") && lock.buffer.length === maxLen()) submit();
}

function backspace() {
  lock.buffer = lock.buffer.slice(0, -1);
  renderDots();
}

function shake(text) {
  setMessage(text, "error");
  lock.screen.classList.remove("shake");
  void lock.screen.offsetWidth;
  lock.screen.classList.add("shake");
  navigator.vibrate?.([30, 40, 30]);
  lock.buffer = "";
  renderDots();
}

// ── brute-force pacing (UI-level) ──
let fails = 0;
const untilTs = () => Number(localStorage.getItem(LOCK_UNTIL_KEY) || 0);
const inCooldown = () => Date.now() < untilTs();

function checkCooldown() {
  clearInterval(lock.cooldownTimer);
  if (!inCooldown()) {
    lock.pad.classList.remove("disabled");
    return;
  }
  lock.pad.classList.add("disabled");
  const tick = () => {
    const left = Math.ceil((untilTs() - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(lock.cooldownTimer);
      lock.pad.classList.remove("disabled");
      setMessage("Enter your PIN to unlock");
    } else setMessage(`Too many attempts — wait ${left}s`, "error");
  };
  tick();
  lock.cooldownTimer = setInterval(tick, 500);
}

async function submit() {
  if (inCooldown()) return;
  const pin = lock.buffer;

  if (lock.mode === "create") {
    if (pin.length < 4) return shake("PIN needs at least 4 digits");
    lock.pending = pin;
    lock.mode = "confirm";
    lock.buffer = "";
    lock.title.textContent = "CONFIRM PIN";
    setMessage("Enter the same PIN again");
    lock.screen.dataset.mode = "confirm";
    renderDots();
    return;
  }

  if (lock.mode === "confirm") {
    if (pin !== lock.pending) {
      lock.mode = "create";
      lock.title.textContent = "CREATE PIN";
      lock.screen.dataset.mode = "create";
      return shake("PINs didn't match — start again");
    }
    const old = getCfg() || {};
    saveCfg({
      ...(await makeRecord(pin)),
      timeoutMs: old.timeoutMs ?? 300000,
      shield: old.shield ?? true,
    });
    hideOverlay();
    ctx.toast("Vault Lock is on");
    refreshLockDialog();
    resetIdle();
    return;
  }

  // unlock / verify-current
  if (!pin) return;
  if (await verifyPin(pin)) {
    fails = 0;
    localStorage.removeItem(LOCK_UNTIL_KEY);
    if (lock.mode === "unlock") return unlockNow();
    if (lock.after === "change") return showOverlay("create");
    if (lock.after === "remove") {
      localStorage.removeItem(LOCK_KEY);
      hideOverlay();
      clearTimeout(lock.idleTimer);
      ctx.toast("Vault Lock removed");
      refreshLockDialog();
    }
    return;
  }
  fails++;
  if (fails >= 5) {
    const wait = Math.min(300, 30 * 2 ** Math.floor((fails - 5) / 1)) * 1000;
    localStorage.setItem(LOCK_UNTIL_KEY, String(Date.now() + wait));
    shake("Incorrect PIN");
    checkCooldown();
  } else shake(`Incorrect PIN · ${5 - fails} left`);
}

// ── lock / unlock ──
export function lockNow() {
  if (!hasPin()) {
    ctx.toast("Set a PIN first");
    openLockDialog();
    return;
  }
  if (lock.locked) return;
  lock.locked = true;
  document.querySelectorAll(".dialog-backdrop").forEach((d) => d.classList.add("hidden"));
  $("msg-context-menu")?.classList.add("hidden");
  $("chat-menu")?.classList.add("hidden");
  els.form?.classList.remove("tools-open");
  document.activeElement?.blur?.();
  document.body.classList.add("vault-locked");
  els.appShell?.setAttribute("inert", "");
  els.appShell?.setAttribute("aria-hidden", "true");
  clearTimeout(lock.idleTimer);
  showOverlay("unlock");
}

function unlockNow() {
  lock.locked = false;
  hideOverlay();
  document.body.classList.remove("vault-locked");
  els.appShell?.removeAttribute("inert");
  els.appShell?.removeAttribute("aria-hidden");
  resetIdle();
}

function cancelOverlay() {
  if (lock.mode === "unlock") return;
  hideOverlay();
}

// ── idle + visibility ──
function resetIdle() {
  clearTimeout(lock.idleTimer);
  const cfg = getCfg();
  if (!cfg || lock.locked) return;
  if (cfg.timeoutMs > 0) lock.idleTimer = setTimeout(lockNow, cfg.timeoutMs);
}

function setupLockEvents() {
  ["pointerdown", "keydown", "touchstart", "wheel"].forEach((evt) =>
    document.addEventListener(evt, () => !lock.locked && resetIdle(), { passive: true, capture: true })
  );

  // Opening a file/camera picker backgrounds the page — don't lock on the way back.
  document.addEventListener(
    "click",
    (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "file") {
        lock.suppressUntil = Date.now() + 180000;
      }
    },
    true
  );

  document.addEventListener("visibilitychange", () => {
    const cfg = getCfg();
    if (!cfg) return;
    if (document.hidden) {
      lock.hiddenAt = Date.now();
      if (cfg.shield !== false) document.body.classList.add("privacy-shield");
      return;
    }
    document.body.classList.remove("privacy-shield");
    if (!lock.locked && lock.hiddenAt && Date.now() > lock.suppressUntil) {
      const away = Date.now() - lock.hiddenAt;
      if (cfg.timeoutMs === 0 && away >= AWAY_GRACE_MS) lockNow();
      else if (cfg.timeoutMs > 0 && away >= cfg.timeoutMs) lockNow();
    }
    lock.hiddenAt = 0;
    resetIdle();
  });

  // Hardware keyboard on the lock screen.
  document.addEventListener(
    "keydown",
    (e) => {
      if (lock.screen.classList.contains("hidden")) return;
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") backspace();
      else if (e.key === "Enter") submit();
      else if (e.key === "Escape") cancelOverlay();
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
}

function buildKeypad() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];
  lock.pad.innerHTML = "";
  keys.forEach((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "key" + (k === "⌫" || k === "✓" ? " key-fn" : "");
    b.textContent = k;
    b.setAttribute("aria-label", k === "⌫" ? "Delete" : k === "✓" ? "Confirm" : k);
    b.addEventListener("click", () => (k === "⌫" ? backspace() : k === "✓" ? submit() : press(k)));
    lock.pad.appendChild(b);
  });
}

// ── settings dialog ──
function refreshLockDialog() {
  if (!lock.dialog) return;
  const cfg = getCfg();
  $("lock-status").textContent = cfg
    ? "Vault Lock is ON. Your PIN is required to open VaultChatt on this device."
    : "Vault Lock is OFF. Create a PIN to hide your chats behind a lock screen on this device.";
  $("btn-lock-setpin").textContent = cfg ? "Change PIN" : "Create PIN";
  $("btn-lock-now").classList.toggle("hidden", !cfg);
  $("btn-lock-remove").classList.toggle("hidden", !cfg);
  $("lock-options").classList.toggle("hidden", !cfg);
  if (cfg) {
    $("lock-timeout").value = String(cfg.timeoutMs ?? 300000);
    $("lock-shield").checked = cfg.shield !== false;
  }
}

export function openLockDialog() {
  refreshLockDialog();
  lock.dialog?.classList.remove("hidden");
}

function setupLockDialog() {
  if (!lock.dialog) return;
  $("btn-vault-lock")?.addEventListener("click", openLockDialog);
  $("btn-tool-lock")?.addEventListener("click", () => (hasPin() ? lockNow() : openLockDialog()));

  $("btn-lock-setpin").addEventListener("click", () => {
    lock.dialog.classList.add("hidden");
    if (hasPin()) showOverlay("verify-current", { after: "change" });
    else showOverlay("create");
  });
  $("btn-lock-now").addEventListener("click", () => {
    lock.dialog.classList.add("hidden");
    lockNow();
  });
  $("btn-lock-remove").addEventListener("click", () => {
    lock.dialog.classList.add("hidden");
    showOverlay("verify-current", { after: "remove" });
  });
  $("lock-timeout").addEventListener("change", (e) => {
    const cfg = getCfg();
    if (!cfg) return;
    cfg.timeoutMs = Number(e.target.value);
    saveCfg(cfg);
    resetIdle();
  });
  $("lock-shield").addEventListener("change", (e) => {
    const cfg = getCfg();
    if (!cfg) return;
    cfg.shield = e.target.checked;
    saveCfg(cfg);
  });

  lock.cancel.addEventListener("click", cancelOverlay);
  lock.signout.addEventListener("click", async () => {
    if (!confirm("Signing out removes your PIN from this device and ends this session. Continue?")) return;
    localStorage.removeItem(LOCK_KEY);
    localStorage.removeItem(LOCK_UNTIL_KEY);
    if (ctx.signOut) await ctx.signOut();
    else $("btn-logout")?.click();
  });
}

// ═══════════════════════════════════════════════════════════════════════
// boot
// ═══════════════════════════════════════════════════════════════════════

function boot() {
  setupComposer();
  setupSearch();
  watchContactList();
  markDrafts();

  if (lock.screen) {
    buildKeypad();
    setupLockEvents();
    setupLockDialog();
    refreshLockDialog();

    // Just typed the password on the sign-in page? Don't ask for a PIN straight away.
    const fresh = sessionStorage.getItem("vc_unlock_once") === "1";
    sessionStorage.removeItem("vc_unlock_once");
    if (hasPin() && !fresh) lockNow();
    else resetIdle();
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();

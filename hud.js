// hud.js — the "mission clock": live time, date, zone, greeting, welcome line,
// session uptime, the orbital ring, and the one-per-session boot splash.
//
// Markup stays declarative. Anything tagged data-hud="…" is kept live:
//   time · weekday · weekday-short · date · tz · greeting · uptime
// [data-hud-name]    → the operator's display name
// [data-hud-welcome] → typewriter "WELCOME, NAME" line
// [data-hud-ring]    → SVG orbital ring (seconds / minutes / hours of the day)
// Click or tap any clock to flip between 24h and 12h.

const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const startedAt = Date.now();
let use12h = localStorage.getItem("vc_hud_12h") === "1";
let operatorName = "";
let typedFor = null;
let typeTimer = null;

// ─── helpers ───────────────────────────────────────────────────────────

function cachedName() {
  try {
    const s = JSON.parse(localStorage.getItem("vc_session") || "null");
    return (s && (s.displayName || s.username)) || "";
  } catch (_) {
    return "";
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function greetingFor(d) {
  const h = d.getHours();
  if (h < 5) return "Night watch";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Late-night link";
}

function zoneLabel(d) {
  let city = "";
  let off = "";
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    city = tz.split("/").pop().replace(/_/g, " ");
  } catch (_) {}
  const mins = -d.getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "−";
  const abs = Math.abs(mins);
  off = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? ":" + pad(abs % 60) : ""}`;
  return city ? `${city} · ${off}` : off;
}

function timeHtml(d) {
  let h = d.getHours();
  let suffix = "";
  if (use12h) {
    suffix = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
  }
  const main = use12h ? String(h) : pad(h);
  return (
    `${main}:${pad(d.getMinutes())}<span class="hud-sec">:${pad(d.getSeconds())}</span>` +
    (suffix ? `<span class="hud-ampm">${suffix}</span>` : "")
  );
}

// ─── orbital ring ──────────────────────────────────────────────────────

const RINGS = { sec: 86, min: 76, hr: 66 };

function buildRing(host) {
  if (host.querySelector("svg")) return;
  let ticks = "";
  for (let i = 0; i < 60; i++) {
    const long = i % 5 === 0;
    ticks += `<line x1="100" y1="${long ? 6 : 9}" x2="100" y2="${long ? 15 : 13}" transform="rotate(${i * 6} 100 100)" class="${long ? "tick tick-long" : "tick"}"/>`;
  }
  const circ = (r) => (2 * Math.PI * r).toFixed(2);
  host.insertAdjacentHTML(
    "afterbegin",
    `<svg class="hud-ring-svg" viewBox="0 0 200 200" aria-hidden="true">
       <g>${ticks}</g>
       <circle class="ring-track" cx="100" cy="100" r="${RINGS.sec}"/>
       <circle class="ring-track" cx="100" cy="100" r="${RINGS.min}"/>
       <circle class="ring-track" cx="100" cy="100" r="${RINGS.hr}"/>
       <circle class="ring-arc ring-hr"  cx="100" cy="100" r="${RINGS.hr}"  stroke-dasharray="${circ(RINGS.hr)}"  stroke-dashoffset="${circ(RINGS.hr)}"/>
       <circle class="ring-arc ring-min" cx="100" cy="100" r="${RINGS.min}" stroke-dasharray="${circ(RINGS.min)}" stroke-dashoffset="${circ(RINGS.min)}"/>
       <circle class="ring-arc ring-sec" cx="100" cy="100" r="${RINGS.sec}" stroke-dasharray="${circ(RINGS.sec)}" stroke-dashoffset="${circ(RINGS.sec)}"/>
       <g class="ring-orbit"><circle cx="100" cy="14" r="3.6"/></g>
     </svg>`
  );
}

function updateRing(host, d) {
  const set = (cls, r, frac) => {
    const el = host.querySelector(cls);
    if (!el) return;
    const c = 2 * Math.PI * r;
    el.style.strokeDashoffset = String(c * (1 - frac));
  };
  const s = d.getSeconds() + d.getMilliseconds() / 1000;
  const m = d.getMinutes() + s / 60;
  const h = d.getHours() + m / 60;
  set(".ring-sec", RINGS.sec, Math.max(0.004, Math.floor(s) / 60));
  set(".ring-min", RINGS.min, m / 60);
  set(".ring-hr", RINGS.hr, h / 24);
  const orbit = host.querySelector(".ring-orbit");
  if (orbit) orbit.style.transform = `rotate(${Math.floor(s) * 6}deg)`;
}

// ─── typewriter welcome ────────────────────────────────────────────────

function typeWelcome(force = false) {
  const targets = $$("[data-hud-welcome]");
  if (!targets.length) return;
  const text = operatorName ? `WELCOME, ${operatorName.toUpperCase()}` : "WELCOME, OPERATOR";
  if (!force && typedFor === text) return;
  typedFor = text;
  clearInterval(typeTimer);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    targets.forEach((el) => (el.textContent = text));
    return;
  }
  let i = 0;
  typeTimer = setInterval(() => {
    i++;
    targets.forEach((el) => {
      el.textContent = text.slice(0, i);
      el.classList.toggle("typing", i < text.length);
    });
    if (i >= text.length) clearInterval(typeTimer);
  }, 55);
}

// ─── the tick ──────────────────────────────────────────────────────────

function render() {
  const d = new Date();
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const weekdayShort = d.toLocaleDateString(undefined, { weekday: "short" });
  const date = d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  const up = Math.floor((Date.now() - startedAt) / 1000);
  const uptime = `${pad(Math.floor(up / 3600))}:${pad(Math.floor((up % 3600) / 60))}:${pad(up % 60)}`;

  const vals = {
    time: null, // html
    weekday: weekday.toUpperCase(),
    "weekday-short": weekdayShort.toUpperCase(),
    date: date.toUpperCase(),
    tz: zoneLabel(d).toUpperCase(),
    greeting: greetingFor(d).toUpperCase(),
    uptime,
  };
  const t = timeHtml(d);

  $$("[data-hud]").forEach((el) => {
    const k = el.dataset.hud;
    if (k === "time") el.innerHTML = t;
    else if (k in vals) el.textContent = vals[k];
  });
  $$("[data-hud-name]").forEach((el) => (el.textContent = operatorName || "Operator"));
  $$("[data-hud-ring]").forEach((host) => {
    buildRing(host);
    updateRing(host, d);
  });
}

function loop() {
  render();
  setTimeout(loop, 1000 - (Date.now() % 1000) + 5); // stay on the second boundary
}

// ─── public API ────────────────────────────────────────────────────────

export function setOperatorName(name) {
  operatorName = (name || "").trim();
  render();
  typeWelcome();
}

export function runBootSplash() {
  const splash = document.getElementById("boot-splash");
  if (!splash) return;
  if (sessionStorage.getItem("vc_booted") === "1" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    splash.remove();
    return;
  }
  sessionStorage.setItem("vc_booted", "1");
  const name = (operatorName || cachedName() || "Operator").toUpperCase();
  const lines = [
    "> HANDSHAKE ............ OK",
    "> X25519 KEYPAIR ....... LOADED",
    "> AES-256-GCM .......... ARMED",
    `> WELCOME, ${name}`,
  ];
  const out = splash.querySelector(".boot-lines");
  splash.classList.remove("hidden");
  let n = 0;
  const step = () => {
    if (!splash.isConnected) return;
    if (n < lines.length) {
      const p = document.createElement("p");
      p.textContent = lines[n++];
      out.appendChild(p);
      setTimeout(step, 340);
    } else {
      setTimeout(close, 450);
    }
  };
  const close = () => {
    splash.classList.add("leaving");
    setTimeout(() => splash.remove(), 450);
  };
  splash.addEventListener("click", close, { once: true });
  step();
}

function init() {
  operatorName = cachedName();
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-hud='time']")) {
      use12h = !use12h;
      localStorage.setItem("vc_hud_12h", use12h ? "1" : "0");
      render();
    }
  });
  loop();
  typeWelcome(true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

// chat-studio.js — the "Chat studio" and "Font colour" sections of the
// Appearance panel: theme presets, a reusable RGB mixer (used for the accent,
// your bubbles, their bubbles, the chat tint AND the font colour), bubble
// shape + effect, wallpaper dimming, and a live preview that proves messages
// stay readable on any background.
//
// Everything is applied live through appearance.js (CSS variables on <html>)
// and saved with a short debounce, so dragging a slider never hammers storage.

import {
  loadAppearance,
  saveAppearance,
  applyAppearance,
  parseHex,
  rgbToHex,
  contrastRatio,
  CHAT_PRESETS,
  BUBBLE_SHAPES,
  BUBBLE_FX,
} from "./appearance.js";

const QUICK_COLORS = ["#6ff2dc", "#00e5ff", "#a78bff", "#ff5c8a", "#ffd48a", "#7dff6b", "#ff8a3d", "#4d7cff"];
const FONT_QUICK = ["#ffffff", "#f4fbff", "#ffe9a8", "#ffc266", "#ff8fa8", "#b58bff", "#22ffb0", "#7dd3fc", "#9db2c4", "#111111"];
const FALLBACKS = { accent: "#6ff2dc", bubbleMine: "#0a7f9c", bubbleTheirs: "#18133a", chatTint: "#3a2a8f" };
const TARGET_KEYS = Object.keys(FALLBACKS);

const $ = (id) => document.getElementById(id);

// "rgb(1, 2, 3)" / "#abc123" → "#rrggbb" (or "")
function cssToHex(value) {
  const v = String(value || "").trim();
  if (parseHex(v)) return rgbToHex(...parseHex(v));
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?/i.exec(v);
  if (!m) return "";
  if (m[4] !== undefined && Number(m[4]) === 0) return ""; // fully transparent
  return rgbToHex(+m[1], +m[2], +m[3]);
}

// ─── Reusable RGB mixer ──────────────────────────────────────────────────
// Builds its own markup inside `host`; fires onInput(hex) for every change
// from the user and never when you call paint() (so it can't feed back).

function createMixer(host, { quick = QUICK_COLORS, resetLabel = "Reset", sample = false, onInput, onReset }) {
  host.textContent = "";
  const root = document.createElement("div");
  root.className = "rgb-mixer";
  root.innerHTML = `
    <div class="rgb-preview-row">
      <div class="rgb-preview" aria-hidden="true"></div>
      <input class="rgb-hex" type="text" maxlength="7" spellcheck="false" autocomplete="off" autocapitalize="none" aria-label="Hex colour" placeholder="#6ff2dc" />
      <input class="rgb-native" type="color" value="#6ff2dc" aria-label="Pick a colour" title="Open colour wheel" />
    </div>
    <label class="rgb-row"><span class="rgb-chan r">R</span><input class="rgb-slider rgb-r" type="range" min="0" max="255" value="0" aria-label="Red" /><output>0</output></label>
    <label class="rgb-row"><span class="rgb-chan g">G</span><input class="rgb-slider rgb-g" type="range" min="0" max="255" value="0" aria-label="Green" /><output>0</output></label>
    <label class="rgb-row"><span class="rgb-chan b">B</span><input class="rgb-slider rgb-b" type="range" min="0" max="255" value="0" aria-label="Blue" /><output>0</output></label>
    ${sample ? '<div class="font-sample">The quick brown fox jumps over the lazy dog · 0123456789</div><div class="font-ratio"></div>' : ""}
    <div class="color-grid mixer-quick" aria-label="Quick colours"></div>
    <button type="button" class="btn-secondary full-width mixer-reset"></button>`;
  host.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const sl = { r: q(".rgb-r"), g: q(".rgb-g"), b: q(".rgb-b") };
  const out = { r: sl.r.nextElementSibling, g: sl.g.nextElementSibling, b: sl.b.nextElementSibling };
  const chip = q(".rgb-preview");
  const hexInput = q(".rgb-hex");
  const nativeInput = q(".rgb-native");
  const sampleEl = q(".font-sample");
  const ratioEl = q(".font-ratio");
  q(".mixer-reset").textContent = resetLabel;

  let lastUserInput = 0;

  function paint(hex, { fromHexField = false } = {}) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const clean = rgbToHex(...rgb);
    ["r", "g", "b"].forEach((k, i) => {
      sl[k].value = rgb[i];
      out[k].textContent = rgb[i];
    });
    chip.style.background = clean;
    nativeInput.value = clean;
    if (!fromHexField) hexInput.value = clean;
    // Slider tracks must beat the global `input { background … !important }`
    const track = (el, a, b) => el.style.setProperty("background", `linear-gradient(90deg, ${a}, ${b})`, "important");
    track(sl.r, `rgb(0,${rgb[1]},${rgb[2]})`, `rgb(255,${rgb[1]},${rgb[2]})`);
    track(sl.g, `rgb(${rgb[0]},0,${rgb[2]})`, `rgb(${rgb[0]},255,${rgb[2]})`);
    track(sl.b, `rgb(${rgb[0]},${rgb[1]},0)`, `rgb(${rgb[0]},${rgb[1]},255)`);
    if (sampleEl) paintSample(clean);
    return clean;
  }

  // Font colour: show real text on the real page background + a contrast score
  function paintSample(hex) {
    const bg = cssToHex(getComputedStyle(document.body).backgroundColor) || "#05040d";
    sampleEl.style.background = bg;
    sampleEl.style.color = hex;
    const ratio = contrastRatio(hex, bg);
    const label = ratio >= 7 ? "Excellent" : ratio >= 4.5 ? "Good" : ratio >= 3 ? "Low — may strain your eyes" : "Hard to read";
    ratioEl.textContent = `Readability ${ratio.toFixed(1)}:1 · ${label}`;
    ratioEl.classList.toggle("ok", ratio >= 4.5);
    ratioEl.classList.toggle("bad", ratio < 3);
  }

  const user = (hex, opts) => {
    const clean = paint(hex, opts);
    if (!clean) return;
    lastUserInput = Date.now();
    onInput?.(clean);
  };

  quick.forEach((hex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "color-swatch";
    b.title = hex;
    b.style.background = hex;
    b.addEventListener("click", () => user(hex));
    q(".mixer-quick").appendChild(b);
  });

  ["r", "g", "b"].forEach((k) => sl[k].addEventListener("input", () => user(rgbToHex(sl.r.value, sl.g.value, sl.b.value))));
  hexInput.addEventListener("input", () => {
    const v = hexInput.value.trim();
    const full = v.startsWith("#") ? v : `#${v}`;
    if (parseHex(full)) user(full, { fromHexField: true });
  });
  hexInput.addEventListener("blur", () => {
    hexInput.value = rgbToHex(sl.r.value, sl.g.value, sl.b.value);
  });
  nativeInput.addEventListener("input", () => user(nativeInput.value));
  q(".mixer-reset").addEventListener("click", () => onReset?.());

  return {
    el: root,
    paint,
    // true while the person is actively dragging/typing (don't fight them)
    busy: () => Date.now() - lastUserInput < 700,
  };
}

export async function setupChatStudio() {
  const studioHost = $("studio-mixer");
  const fontHost = $("font-mixer");
  const presetBox = $("studio-presets");
  const shapeBox = $("studio-shapes");
  const fxBox = $("studio-fx");
  const scrimSlider = $("scrim-slider");
  const scrimVal = $("scrim-val");
  const scrimAuto = $("btn-scrim-auto");
  const resetStudio = $("btn-reset-studio");
  const chatPreview = $("chat-preview");
  const tabs = Array.from(document.querySelectorAll(".rgb-tab"));
  if (!studioHost || !presetBox || !shapeBox || !fxBox || !scrimSlider || !scrimVal || !scrimAuto || !resetStudio || !tabs.length) return;

  let cur = await loadAppearance();
  let target = "accent";
  const timers = {};

  const defaultFor = (key) => {
    if (key === "accent") return cssToHex(getComputedStyle(document.documentElement).getPropertyValue("--cyan")) || FALLBACKS.accent;
    return FALLBACKS[key];
  };
  const valueOf = (key) => (parseHex(cur[key]) ? rgbToHex(...parseHex(cur[key])) : defaultFor(key));
  const defaultFont = () => cssToHex(getComputedStyle(document.body).color) || "#e6e2ff";
  const fontValue = () => (parseHex(cur.fontColor) ? rgbToHex(...parseHex(cur.fontColor)) : defaultFont());

  // Persist (debounced per field). Values are captured now so switching
  // tabs mid-drag can never write a colour into the wrong field.
  function scheduleSave(partial, delay = 250) {
    const k = Object.keys(partial).join(",");
    clearTimeout(timers[k]);
    timers[k] = setTimeout(async () => {
      try {
        cur = await saveAppearance(partial);
      } catch (e) {
        console.warn("save failed", e);
      }
      paintTabDots();
      markPresets();
    }, delay);
  }

  // ── studio mixer (accent / bubbles / tint) ──
  const studio = createMixer(studioHost, {
    quick: QUICK_COLORS,
    resetLabel: "Reset this colour",
    onInput(hex) {
      const key = target;
      applyAppearance({ ...cur, [key]: hex, chatPreset: "" }); // instant preview everywhere
      scheduleSave({ [key]: hex, chatPreset: "" });
      const dot = tabs.find((t) => t.dataset.target === key)?.querySelector("i");
      if (dot) dot.style.setProperty("--dot", hex);
    },
    async onReset() {
      clearTimeout(timers[`${target},chatPreset`]);
      cur = await saveAppearance({ [target]: "", chatPreset: "" });
      studio.paint(defaultFor(target));
      paintTabDots();
      markPresets();
    },
  });

  // ── font colour mixer ──
  let font = null;
  if (fontHost) {
    font = createMixer(fontHost, {
      quick: FONT_QUICK,
      resetLabel: "Reset font colour",
      sample: true,
      onInput(hex) {
        applyAppearance({ ...cur, fontColor: hex });
        scheduleSave({ fontColor: hex });
      },
      async onReset() {
        clearTimeout(timers.fontColor);
        cur = await saveAppearance({ fontColor: "" });
        font.paint(defaultFont());
      },
    });
    font.paint(fontValue());
  }

  function paintTabDots() {
    tabs.forEach((t) => {
      const dot = t.querySelector("i");
      if (dot) dot.style.setProperty("--dot", valueOf(t.dataset.target));
    });
  }

  function markPresets() {
    presetBox.querySelectorAll(".studio-preset").forEach((b) => b.classList.toggle("selected", b.dataset.id === cur.chatPreset));
    shapeBox.querySelectorAll(".studio-chip").forEach((b) => b.classList.toggle("selected", b.dataset.id === (cur.bubbleShape || "shard")));
    fxBox.querySelectorAll(".studio-chip").forEach((b) => b.classList.toggle("selected", b.dataset.id === (cur.bubbleFx || "none")));
    const manual = cur.scrim !== "" && cur.scrim !== null && cur.scrim !== undefined && Number.isFinite(Number(cur.scrim));
    if (manual) {
      scrimSlider.value = Number(cur.scrim);
      scrimVal.textContent = `${Math.round(Number(cur.scrim))}%`;
    } else {
      const auto = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--wp-scrim"));
      if (Number.isFinite(auto)) scrimSlider.value = Math.round(auto * 100);
      scrimVal.textContent = "Auto";
    }
    scrimAuto.classList.toggle("selected", !manual);
  }

  function selectTarget(key) {
    if (!TARGET_KEYS.includes(key)) return;
    target = key;
    tabs.forEach((t) => {
      const on = t.dataset.target === key;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    studio.paint(valueOf(key));
  }

  // ── presets, shapes, effects ──
  CHAT_PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "studio-preset";
    b.dataset.id = p.id;
    const m = parseHex(p.mine) ? p.mine : "#0a7f9c";
    const t = parseHex(p.theirs) ? p.theirs : "#1b1640";
    b.innerHTML = '<span class="sp-swatch"></span><span class="sp-name"></span>';
    b.querySelector(".sp-swatch").style.background = `linear-gradient(90deg, ${t} 0 38%, ${m} 38%)`;
    b.querySelector(".sp-name").textContent = p.name;
    b.addEventListener("click", async () => {
      Object.keys(timers).forEach((k) => clearTimeout(timers[k]));
      cur = await saveAppearance({
        bubbleMine: p.mine,
        bubbleTheirs: p.theirs,
        chatTint: p.tint,
        accent: p.accent,
        bubbleShape: p.shape,
        bubbleFx: p.fx,
        chatPreset: p.id,
      });
      selectTarget(target);
      paintTabDots();
      markPresets();
    });
    presetBox.appendChild(b);
  });

  const chips = (box, list, field) =>
    list.forEach((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "studio-chip";
      b.dataset.id = item.id;
      b.textContent = item.name;
      b.addEventListener("click", async () => {
        cur = await saveAppearance({ [field]: item.id, chatPreset: "" });
        markPresets();
      });
      box.appendChild(b);
    });
  chips(shapeBox, BUBBLE_SHAPES, "bubbleShape");
  chips(fxBox, BUBBLE_FX, "bubbleFx");

  tabs.forEach((t) => t.addEventListener("click", () => selectTarget(t.dataset.target)));

  scrimSlider.addEventListener("input", () => {
    const n = Number(scrimSlider.value);
    scrimVal.textContent = `${n}%`;
    applyAppearance({ ...cur, scrim: n });
    scheduleSave({ scrim: n }, 250);
  });
  scrimAuto.addEventListener("click", async () => {
    clearTimeout(timers.scrim);
    cur = await saveAppearance({ scrim: "" });
    markPresets();
  });

  resetStudio.addEventListener("click", async () => {
    Object.keys(timers).forEach((k) => clearTimeout(timers[k]));
    cur = await saveAppearance({
      accent: "", bubbleMine: "", bubbleTheirs: "", chatTint: "",
      bubbleShape: "shard", bubbleFx: "none", scrim: "", chatPreset: "",
    });
    selectTarget(target);
    paintTabDots();
    markPresets();
  });

  if (chatPreview) {
    chatPreview.addEventListener("click", () => {
      chatPreview.dataset.bg = String((Number(chatPreview.dataset.bg || 0) + 1) % 4);
    });
  }

  // Something else saved (font swatches, theme switch, a preset…) → re-sync
  // our controls, unless the person is mid-drag on them.
  window.addEventListener("appearanceSaved", async () => {
    try {
      cur = await loadAppearance();
    } catch (_) {
      return;
    }
    if (!studio.busy()) studio.paint(valueOf(target));
    if (font && !font.busy()) font.paint(fontValue());
    paintTabDots();
    markPresets();
  });

  // Era / theme flips change the defaults and the sample's page background
  window.addEventListener("eraChanged", () => {
    paintTabDots();
    if (!studio.busy()) studio.paint(valueOf(target));
    if (font && !font.busy()) font.paint(fontValue());
  });

  selectTarget("accent");
  paintTabDots();
  markPresets();
}

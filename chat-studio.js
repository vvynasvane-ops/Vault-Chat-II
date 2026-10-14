// chat-studio.js — the "Chat studio" section of the Appearance panel:
// theme presets, an RGB mixer that can target the accent / your bubbles /
// their bubbles / the chat tint, bubble shape + effect, wallpaper dimming,
// and a live preview that proves messages stay readable on any background.
//
// Everything is applied live through appearance.js (CSS variables on <html>)
// and saved with a short debounce, so dragging a slider never hammers storage.

import {
  loadAppearance,
  saveAppearance,
  applyAppearance,
  parseHex,
  rgbToHex,
  CHAT_PRESETS,
  BUBBLE_SHAPES,
  BUBBLE_FX,
} from "./appearance.js";

const QUICK_COLORS = ["#6ff2dc", "#00e5ff", "#a78bff", "#ff5c8a", "#ffd48a", "#7dff6b", "#ff8a3d", "#4d7cff"];
const FALLBACKS = { accent: "#6ff2dc", bubbleMine: "#0a7f9c", bubbleTheirs: "#18133a", chatTint: "#3a2a8f" };
const TARGET_KEYS = Object.keys(FALLBACKS);

const $ = (id) => document.getElementById(id);

// "rgb(1, 2, 3)" / "#abc123" → "#rrggbb" (or "")
function cssToHex(value) {
  const v = String(value || "").trim();
  if (parseHex(v)) return rgbToHex(...parseHex(v));
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(v);
  return m ? rgbToHex(+m[1], +m[2], +m[3]) : "";
}

export async function setupChatStudio() {
  const sl = { r: $("rgb-r"), g: $("rgb-g"), b: $("rgb-b") };
  const out = { r: $("rgb-r-val"), g: $("rgb-g-val"), b: $("rgb-b-val") };
  const preview = $("rgb-preview");
  const hexInput = $("rgb-hex");
  const nativeInput = $("rgb-native");
  const quickBox = $("rgb-presets");
  const resetBtn = $("btn-reset-accent");
  const presetBox = $("studio-presets");
  const shapeBox = $("studio-shapes");
  const fxBox = $("studio-fx");
  const scrimSlider = $("scrim-slider");
  const scrimVal = $("scrim-val");
  const scrimAuto = $("btn-scrim-auto");
  const resetStudio = $("btn-reset-studio");
  const chatPreview = $("chat-preview");
  const tabs = Array.from(document.querySelectorAll(".rgb-tab"));
  if (!sl.r || !sl.g || !sl.b || !preview || !hexInput || !nativeInput || !quickBox || !presetBox || !tabs.length) return;

  let cur = await loadAppearance();
  let target = "accent";
  const timers = {};

  // ── value helpers ──
  const defaultFor = (key) => {
    if (key === "accent") return cssToHex(getComputedStyle(document.documentElement).getPropertyValue("--cyan")) || FALLBACKS.accent;
    return FALLBACKS[key];
  };
  const valueOf = (key) => (parseHex(cur[key]) ? rgbToHex(...parseHex(cur[key])) : defaultFor(key));

  function paint(hex, { fromHexField = false } = {}) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const clean = rgbToHex(...rgb);
    ["r", "g", "b"].forEach((k, i) => {
      sl[k].value = rgb[i];
      if (out[k]) out[k].textContent = rgb[i];
    });
    preview.style.background = clean;
    nativeInput.value = clean;
    if (!fromHexField) hexInput.value = clean;
    // Slider tracks must beat the global `input { background … !important }`
    const track = (el, a, b) => el.style.setProperty("background", `linear-gradient(90deg, ${a}, ${b})`, "important");
    track(sl.r, `rgb(0,${rgb[1]},${rgb[2]})`, `rgb(255,${rgb[1]},${rgb[2]})`);
    track(sl.g, `rgb(${rgb[0]},0,${rgb[2]})`, `rgb(${rgb[0]},255,${rgb[2]})`);
    track(sl.b, `rgb(${rgb[0]},${rgb[1]},0)`, `rgb(${rgb[0]},${rgb[1]},255)`);
    return clean;
  }

  function paintTabDots() {
    tabs.forEach((t) => {
      const key = t.dataset.target;
      const dot = t.querySelector("i");
      if (dot) dot.style.setProperty("--dot", valueOf(key));
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

  function live(hex, opts) {
    const clean = paint(hex, opts);
    if (!clean) return;
    const key = target;
    applyAppearance({ ...cur, [key]: clean, chatPreset: "" }); // instant preview everywhere
    scheduleSave({ [key]: clean, chatPreset: "" });
    const dot = tabs.find((t) => t.dataset.target === key)?.querySelector("i");
    if (dot) dot.style.setProperty("--dot", clean);
  }

  function selectTarget(key) {
    if (!TARGET_KEYS.includes(key)) return;
    target = key;
    tabs.forEach((t) => {
      const on = t.dataset.target === key;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    paint(valueOf(key));
  }

  // ── build static UI ──
  QUICK_COLORS.forEach((hex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "color-swatch";
    b.title = hex;
    b.style.background = hex;
    b.addEventListener("click", () => live(hex));
    quickBox.appendChild(b);
  });

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

  // ── events ──
  tabs.forEach((t) => t.addEventListener("click", () => selectTarget(t.dataset.target)));

  const onSlider = () => live(rgbToHex(sl.r.value, sl.g.value, sl.b.value));
  ["r", "g", "b"].forEach((k) => sl[k].addEventListener("input", onSlider));

  hexInput.addEventListener("input", () => {
    const v = hexInput.value.trim();
    const full = v.startsWith("#") ? v : `#${v}`;
    if (parseHex(full)) live(full, { fromHexField: true });
  });
  hexInput.addEventListener("blur", () => {
    hexInput.value = rgbToHex(sl.r.value, sl.g.value, sl.b.value);
  });
  nativeInput.addEventListener("input", () => live(nativeInput.value));

  resetBtn.addEventListener("click", async () => {
    clearTimeout(timers[`${target},chatPreset`]);
    cur = await saveAppearance({ [target]: "", chatPreset: "" });
    paint(defaultFor(target));
    paintTabDots();
    markPresets();
  });

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

  // Keep the panel in sync when the era or theme flips underneath it
  window.addEventListener("eraChanged", () => {
    paintTabDots();
    selectTarget(target);
  });

  selectTarget("accent");
  paintTabDots();
  markPresets();
}

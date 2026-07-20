/*! Background Begone | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-begone */
import { removeBackground, loadSession } from "./cutout.js?v=1.0.1";

const $ = (id) => document.getElementById(id);
const results = $("results");
const resultBody = $("result-body");
const alerts = $("alerts");
const compareStage = $("compare-stage");
const imgBefore = $("img-before");
const imgAfter = $("img-after");
const divider = $("compare-divider");
const downloadBtn = $("download");
const restartBtn = $("restart");
const resultSize = $("result-size");
const uploadBtn = $("upload");
const sampleBtn = $("sample");
const fileInput = $("file-input");
const progress = $("progress");
const progressFill = $("progress-fill");
const progressLabel = $("progress-label");
const toolCard = $("tool-card");

function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---- the wipe divider, same physics as the rest of the suite ----
let wipePct = 55;
function setWipe(pct) {
  wipePct = Math.max(0, Math.min(100, pct));
  compareStage.style.setProperty("--wipe", wipePct + "%");
  divider.setAttribute("aria-valuenow", String(Math.round(wipePct)));
  divider.setAttribute("aria-valuetext", Math.round(wipePct) + "% of the original shown");
}
function pctFromClientX(clientX) {
  const rect = compareStage.getBoundingClientRect();
  return rect.width ? ((clientX - rect.left) / rect.width) * 100 : wipePct;
}
let dragging = false;
compareStage.addEventListener("pointerdown", (e) => {
  dragging = true;
  compareStage.setPointerCapture?.(e.pointerId);
  divider.focus?.({ preventScroll: true });
  setWipe(pctFromClientX(e.clientX));
  e.preventDefault();
});
compareStage.addEventListener("pointermove", (e) => { if (dragging) setWipe(pctFromClientX(e.clientX)); });
compareStage.addEventListener("pointerup", () => { dragging = false; });
compareStage.addEventListener("pointercancel", () => { dragging = false; });
divider.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 10 : 2;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") { setWipe(wipePct - step); e.preventDefault(); }
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") { setWipe(wipePct + step); e.preventDefault(); }
  else if (e.key === "Home") { setWipe(0); e.preventDefault(); }
  else if (e.key === "End") { setWipe(100); e.preventDefault(); }
});

// ---- preview background chips ----
const previewBg = document.querySelector(".preview-bg");
if (previewBg) {
  const setBg = (mode, active) => {
    previewBg.querySelectorAll(".bg-opt").forEach((b) => {
      const on = b === active;
      b.classList.toggle("is-active", on);
      if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", String(on));
    });
    if (mode === "checker") compareStage.classList.remove("solid");
    else { compareStage.style.setProperty("--preview-bg", mode); compareStage.classList.add("solid"); }
  };
  previewBg.querySelectorAll("button.bg-opt").forEach((btn) => btn.addEventListener("click", () => {
    if (btn.classList.contains("is-active")) return;
    setBg(btn.dataset.bg, btn);
  }));
  const bgCustom = $("bg-custom");
  if (bgCustom) {
    const chip = bgCustom.closest(".bg-opt");
    chip.addEventListener("click", () => setBg(bgCustom.value, chip));
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBg(bgCustom.value, chip); bgCustom.click(); }
    });
    bgCustom.addEventListener("input", () => setBg(bgCustom.value, chip));
  }
  const initialBg = previewBg.querySelector("button.bg-opt.is-active");
  if (initialBg) setBg(initialBg.dataset.bg, initialBg);
}

// ---- the tool flow ----
let beforeUrl = null;
let afterUrl = null;
let resultBlob = null;
let resultName = "cutout.png";
let busy = false;

const STAGE_LABELS = {
  download: (p) => `Summoning the model… ${Math.round(p * 100)}%`,
  compile: () => "Warming up the wand…",
  model: () => "Finding your subject…",
  refine: () => "Perfecting the edges…",
  encode: () => "Wrapping your PNG…",
};

function showProgress(stage, p) {
  progress.hidden = false;
  const label = STAGE_LABELS[stage];
  if (label) progressLabel.textContent = label(p);
  // download has honest percent; the other stages sweep to keep motion honest
  if (stage === "download") {
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = Math.round(p * 90) + "%";
  } else if (stage === "encode" && p === 1) {
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = "100%";
  } else {
    progressFill.classList.add("indeterminate");
  }
}
function hideProgress() {
  progress.hidden = true;
  progressFill.classList.remove("indeterminate");
  progressFill.style.width = "0%";
}

function alertMsg(kind, text) {
  results.hidden = false;
  alerts.innerHTML = `<div class="alert ${kind}" role="status">${text}</div>`;
}

async function processFile(file) {
  if (busy) return;
  if (file.type && !file.type.startsWith("image/")) {
    alertMsg("info", "That does not look like an image. Drop a JPG, PNG, or WebP.");
    return;
  }
  // Decode through an <img>, not createImageBitmap: drawImage of an <img>
  // honors EXIF orientation on every engine, so a portrait phone photo comes
  // out upright instead of sideways on browsers that hand back raw pixels.
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    if (!img.naturalWidth) throw new Error("empty image");
  } catch {
    URL.revokeObjectURL(url);
    alertMsg("info", "That image could not be read. It may be corrupted or in a format this browser cannot decode.");
    return;
  }
  busy = true;
  toolCard.classList.add("working");
  uploadBtn.disabled = true;
  sampleBtn.disabled = true;
  alerts.innerHTML = "";
  try {
    const { blob } = await removeBackground(img, { width: img.naturalWidth, height: img.naturalHeight }, showProgress);
    resultBlob = blob;
    const base = (file.name || "").replace(/\.[^./\\]+$/, "");
    resultName = base ? base + "-cutout.png" : "cutout.png";
    if (beforeUrl) URL.revokeObjectURL(beforeUrl);
    if (afterUrl) URL.revokeObjectURL(afterUrl);
    beforeUrl = url;
    afterUrl = URL.createObjectURL(blob);
    imgBefore.src = beforeUrl;
    imgAfter.src = afterUrl;
    results.hidden = false;
    resultBody.hidden = false;
    downloadBtn.disabled = false;
    resultSize.textContent = formatBytes(blob.size);
    setWipe(55);
    resultBody.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    // Let the filled bar rest at 100% for a beat before it clears.
    setTimeout(hideProgress, 350);
  } catch (e) {
    URL.revokeObjectURL(url);
    alertMsg("info", "The background could not be removed: " + String(e.message || e));
    hideProgress();
  } finally {
    busy = false;
    toolCard.classList.remove("working");
    uploadBtn.disabled = false;
    sampleBtn.disabled = false;
  }
}

uploadBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) processFile(file);
  fileInput.value = "";
});

sampleBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("./assets/sample-dog.jpg");
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    processFile(new File([blob], "sample-dog.jpg", { type: "image/jpeg" }));
  } catch {
    alertMsg("info", "The sample could not be loaded. Try your own photo instead.");
  }
});

restartBtn.addEventListener("click", () => {
  resultBody.hidden = true;
  results.hidden = true;
  alerts.innerHTML = "";
  downloadBtn.disabled = true;
  // Keep focus on the logical next action rather than dropping it to <body>.
  uploadBtn.focus({ preventScroll: true });
  toolCard.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

downloadBtn.addEventListener("click", () => {
  if (!resultBlob) return;
  const a = document.createElement("a");
  a.href = afterUrl;
  a.download = resultName;
  a.click();
});

// Drop a photo anywhere on the page: the tool card lights up as the drop zone
// and a stray drop can never navigate the page away to the file.
let dragDepth = 0;
const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  toolCard.classList.add("dropping");
});
addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; toolCard.classList.remove("dropping"); }
});
addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
addEventListener("drop", (e) => {
  dragDepth = 0;
  toolCard.classList.remove("dropping");
  if (!isFileDrag(e)) return;
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

// Paste works too: an image copied from anywhere lands straight in the tool.
addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) { e.preventDefault(); processFile(file); }
      return;
    }
  }
});

// Warm the model download as soon as the visitor shows intent, so the wait
// happens while they are still picking a file. warm() passes no progress sink,
// so a later processFile() takes over the bar mid-download and the percentage
// keeps climbing from wherever the warm fetch had reached.
let warmed = false;
const warm = () => {
  if (warmed) return;
  warmed = true;
  loadSession().catch(() => { warmed = false; });
};
uploadBtn.addEventListener("pointerenter", warm);
addEventListener("dragenter", (e) => { if (isFileDrag(e)) warm(); });

// -------- color picker popover --------
// The same picker as the rest of the suite: replaces the browser's built-in
// color dialog for the custom preview background chip.
let closeColorPicker = () => {};
(() => {
  const hasEye = "EyeDropper" in window;
  const pop = document.createElement("div");
  pop.className = "cp";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Color picker");
  pop.hidden = true;
  pop.innerHTML = `
    <div class="cp-sv" role="slider" tabindex="0" aria-label="Saturation and brightness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><div class="cp-dot"></div></div>
    <div class="cp-row">
      ${hasEye ? `<button type="button" class="cp-eye" aria-label="Pick a color from the screen"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.9.9a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.9.9Z"/></svg></button>` : ""}
      <span class="cp-chip" aria-hidden="true"></span>
      <div class="cp-hue" role="slider" tabindex="0" aria-label="Hue" aria-valuemin="0" aria-valuemax="360" aria-valuenow="0"><div class="cp-dot"></div></div>
    </div>
    <label class="cp-hex">Hex<input type="text" spellcheck="false" autocapitalize="off" autocomplete="off"></label>`;
  document.body.appendChild(pop);
  const sv = pop.querySelector(".cp-sv"), svDot = sv.firstElementChild;
  const hue = pop.querySelector(".cp-hue"), hueDot = hue.firstElementChild;
  const chip = pop.querySelector(".cp-chip");
  const hexField = pop.querySelector(".cp-hex input");
  const eye = pop.querySelector(".cp-eye");

  let anchor = null, h = 0, s = 100, v = 100;

  const shortHex = (hex) => {
    const m = /^#(.)\1(.)\2(.)\3$/.exec(hex);
    return m ? "#" + m[1] + m[2] + m[3] : hex;
  };
  const colorToHex = (t) => {
    const x = t.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(x)) return x;
    if (/^#[0-9a-f]{3}$/.test(x)) return "#" + x[1] + x[1] + x[2] + x[2] + x[3] + x[3];
    if (/^#[0-9a-f]{8}$/.test(x)) return x.slice(0, 7);
    if (/^#[0-9a-f]{4}$/.test(x)) return "#" + x[1] + x[1] + x[2] + x[2] + x[3] + x[3];
    return null;
  };
  const hexToRgb = (hex) => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  });

  const hsvToHex = () => {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round((v / 100) * (1 - (s / 100) * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
    };
    return "#" + [f(5), f(3), f(1)].map((n) => n.toString(16).padStart(2, "0")).join("");
  };
  const setFromHex = (hex) => {
    const { r, g, b } = hexToRgb(hex);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d) {
      const hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (hh * 60 + 360) % 360;
    }
    s = max ? (d / max) * 100 : 0;
    v = (max / 255) * 100;
  };

  const paint = () => {
    const hex = hsvToHex();
    pop.style.setProperty("--cp-h", String(Math.round(h)));
    svDot.style.left = s + "%";
    svDot.style.top = 100 - v + "%";
    hueDot.style.left = (h / 360) * 100 + "%";
    chip.style.background = hex;
    sv.setAttribute("aria-valuenow", String(Math.round(v)));
    sv.setAttribute("aria-valuetext", `Saturation ${Math.round(s)}%, brightness ${Math.round(v)}%, ${shortHex(hex)}`);
    hue.setAttribute("aria-valuenow", String(Math.round(h)));
    hue.setAttribute("aria-valuetext", `${Math.round(h)} degrees, ${shortHex(hex)}`);
    if (document.activeElement !== hexField) hexField.value = shortHex(hex);
    return hex;
  };
  const apply = () => {
    if (anchor && !anchor.isConnected) { close(); return; }
    const hex = paint();
    if (!anchor) return;
    anchor.value = hex;
    anchor.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const place = () => {
    if (!anchor || !anchor.isConnected || anchor.getClientRects().length === 0) { close(); return; }
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vv = window.visualViewport;
    const vpTop = vv ? vv.offsetTop : 0;
    const vpH = vv ? vv.height : innerHeight;
    pop.style.left = Math.min(Math.max(10, r.left + r.width / 2 - pw / 2), Math.max(10, innerWidth - pw - 10)) + "px";
    let top = r.bottom + 10;
    if (top + ph > vpTop + vpH - 10) top = r.top - ph - 10;
    if (top < vpTop + 10) top = Math.max(vpTop + 10, Math.min(vpTop + vpH - ph - 10, r.bottom + 10));
    pop.style.top = top + "px";
  };

  let downAt = null;
  const onDocDown = (e) => {
    downAt = null;
    if (pop.contains(e.target) || e.target === anchor) return;
    const wrap = anchor?.closest("label, .swatch-wrap");
    if (wrap && wrap.contains(e.target)) return;
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onDocUp = (e) => {
    if (!downAt) return;
    const tap = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 10;
    downAt = null;
    if (tap) close();
  };
  const onDocCancel = () => { downAt = null; };
  const onKey = (e) => { if (e.key === "Escape") { const a = anchor; close(); a?.focus(); } };
  const onScroll = () => place();
  function close() {
    if (pop.hidden) return;
    const a = anchor, hadFocus = pop.contains(document.activeElement);
    pop.hidden = true;
    anchor = null;
    downAt = null;
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("pointerup", onDocUp, true);
    document.removeEventListener("pointercancel", onDocCancel, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", onScroll, true);
    removeEventListener("resize", onScroll);
    visualViewport?.removeEventListener("resize", onScroll);
    visualViewport?.removeEventListener("scroll", onScroll);
    if (hadFocus && a?.isConnected) setTimeout(() => {
      if (document.activeElement === document.body) a.focus({ preventScroll: true });
    }, 0);
  }
  function open(input) {
    anchor = input;
    setFromHex(colorToHex(input.value || "#000000") || "#000000");
    paint();
    pop.hidden = false;
    place();
    sv.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("pointerup", onDocUp, true);
    document.addEventListener("pointercancel", onDocCancel, true);
    document.addEventListener("keydown", onKey, true);
    addEventListener("scroll", onScroll, { capture: true, passive: true });
    addEventListener("resize", onScroll);
    visualViewport?.addEventListener("resize", onScroll);
    visualViewport?.addEventListener("scroll", onScroll);
  }
  closeColorPicker = close;

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "color") return;
    e.preventDefault();
    if (anchor === t && !pop.hidden) close();
    else open(t);
  }, true);

  const drag = (el, move) => {
    let activeId = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || activeId !== null) return;
      activeId = e.pointerId;
      e.preventDefault();
      el.focus({ preventScroll: true });
      try { el.setPointerCapture(e.pointerId); } catch { /* no live pointer to capture */ }
      move(e);
      const onMove = (ev) => { if (ev.pointerId === activeId) move(ev); };
      const onUp = (ev) => {
        if (ev.pointerId !== activeId) return;
        activeId = null;
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    });
  };
  const frac = (el, x) => Math.max(0, Math.min(1, (x - el.getBoundingClientRect().left) / el.getBoundingClientRect().width));
  drag(sv, (e) => {
    const r = sv.getBoundingClientRect();
    s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100;
    v = 100 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 100;
    apply();
  });
  drag(hue, (e) => { h = Math.min(359.9, frac(hue, e.clientX) * 360); apply(); });

  sv.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") s = Math.max(0, s - step);
    else if (e.key === "ArrowRight") s = Math.min(100, s + step);
    else if (e.key === "ArrowUp") v = Math.min(100, v + step);
    else if (e.key === "ArrowDown") v = Math.max(0, v - step);
    else return;
    e.preventDefault();
    apply();
  });
  hue.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 12 : 4;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") h = (h - step + 360) % 360;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") h = (h + step) % 360;
    else return;
    e.preventDefault();
    apply();
  });

  hexField.addEventListener("input", () => {
    const t = hexField.value.trim();
    if (!t) return;
    const hex = colorToHex(t) || (t.startsWith("#") ? null : colorToHex("#" + t));
    if (!hex) return;
    setFromHex(hex);
    apply();
  });
  hexField.addEventListener("blur", () => { hexField.value = shortHex(hsvToHex()); });

  eye?.addEventListener("click", async () => {
    try {
      const r = await new EyeDropper().open();
      setFromHex(colorToHex(r.sRGBHex) || r.sRGBHex);
      apply();
    } catch { /* picking was cancelled */ }
  });

  pop.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = [sv, eye, hue, hexField].filter(Boolean);
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  });
})();

// -------- sponsor button magic (sparkle rim + floating hearts) --------
// The tooltip bubble itself is pure CSS; this builds the sparkle layer sized
// to the bubble's real box and streams hearts while a mouse hovers. Reduced
// motion skips all of it, touch never sees it, keyboard focus gets sparkles.
const sponsorBtn = document.querySelector(".sponsor-btn");
if (sponsorBtn && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const HEART_PATH = "M12 21s-6.7-4.35-9.33-8.11C.8 10.2 1.96 6.5 5.14 5.44c1.9-.63 3.98.03 5.36 1.6L12 8.6l1.5-1.56c1.38-1.57 3.46-2.23 5.36-1.6 3.18 1.06 4.34 4.76 2.47 7.45C18.7 16.65 12 21 12 21z";
  const SPARKS = ["✦", "✧", "⋆"];
  const SPARK_TINTS = ["", "var(--spk-b)", "var(--spk-c)"];
  let fx = null, heartTimer = 0, liveHearts = 0;
  const buildFx = () => {
    if (fx) return;
    const tip = getComputedStyle(sponsorBtn, "::after");
    const pad = (p) => parseFloat(tip[p]) || 0;
    const w = (parseFloat(tip.width) || 122) + pad("paddingLeft") + pad("paddingRight") + 2;
    const h = (parseFloat(tip.height) || 18) + pad("paddingTop") + pad("paddingBottom") + 2;
    fx = document.createElement("span");
    fx.className = "sponsor-fx";
    fx.setAttribute("aria-hidden", "true");
    fx.style.width = w + "px";
    fx.style.height = h + "px";
    const spots = [[-38, 4], [-30, 34], [-42, 68], [10, 102], [62, 96], [108, 74], [116, 30], [96, -5]];
    spots.forEach(([top, left], k) => {
      const sEl = document.createElement("span");
      sEl.className = "spk";
      sEl.textContent = SPARKS[k % SPARKS.length];
      sEl.style.top = top + "%";
      sEl.style.left = left + "%";
      sEl.style.fontSize = (9 + ((k * 5) % 6)) + "px";
      sEl.style.animationDelay = (-k * 0.21).toFixed(2) + "s";
      sEl.style.animationDuration = (1.5 + (k % 3) * 0.35).toFixed(2) + "s";
      if (SPARK_TINTS[k % 3]) sEl.style.color = SPARK_TINTS[k % 3];
      fx.appendChild(sEl);
    });
    sponsorBtn.appendChild(fx);
  };
  const spawnHeart = () => {
    if (liveHearts >= 7 || document.hidden) return;
    liveHearts++;
    const el = document.createElement("span");
    el.className = "sponsor-heart";
    el.setAttribute("aria-hidden", "true");
    el.style.setProperty("--hx", (Math.random() * 44 - 22).toFixed(0) + "px");
    el.style.setProperty("--hd", (1.05 + Math.random() * 0.7).toFixed(2) + "s");
    el.style.setProperty("--hs", (0.7 + Math.random() * 0.7).toFixed(2));
    el.style.setProperty("--hr", (Math.random() * 40 - 20).toFixed(0) + "deg");
    if (Math.random() < 0.33) el.style.color = "#ff9ed2";
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART_PATH}"/></svg>`;
    el.addEventListener("animationend", () => { el.remove(); liveHearts--; });
    sponsorBtn.appendChild(el);
  };
  sponsorBtn.addEventListener("pointerenter", (e) => {
    buildFx();
    if (e.pointerType === "mouse") {
      spawnHeart();
      clearInterval(heartTimer);
      heartTimer = setInterval(spawnHeart, 300);
    }
  });
  sponsorBtn.addEventListener("pointerleave", () => { clearInterval(heartTimer); heartTimer = 0; });
  sponsorBtn.addEventListener("focus", buildFx);
}

// -------- shared shell behavior (theme, scene, dust, offline) --------

const toTop = $("to-top");
if (toTop) {
  addEventListener("scroll", () => toTop.classList.toggle("show", scrollY > 600), { passive: true });
  toTop.addEventListener("click", () => scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

const themeToggle = $("theme-toggle");
function syncThemeIcon() {
  const label = document.documentElement.dataset.theme === "light" ? "Switch to dark mode" : "Switch to light mode";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.setAttribute("data-tip", label);
}
let themeFadeTimer = 0;
themeToggle.addEventListener("click", () => {
  if (document.startViewTransition) {
    document.documentElement.classList.add("vt-active");
    const vt = document.startViewTransition(() => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#f6f4ee" : "#0d0c0a");
      try { localStorage.setItem("theme", next); } catch { /* storage may be blocked */ }
      syncThemeIcon();
    });
    vt.finished.finally(() => document.documentElement.classList.remove("vt-active"));
    return;
  }
  document.documentElement.classList.add("theme-fading");
  clearTimeout(themeFadeTimer);
  themeFadeTimer = setTimeout(() => document.documentElement.classList.remove("theme-fading"), 500);
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#f6f4ee" : "#0d0c0a");
  try { localStorage.setItem("theme", next); } catch { /* storage may be blocked */ }
  syncThemeIcon();
});
syncThemeIcon();

const scene = document.querySelector(".bg-scene");
if (scene && matchMedia("(pointer: fine)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let rafId = 0;
  addEventListener("mousemove", (e) => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      scene.style.setProperty("--px", (e.clientX / innerWidth - 0.5).toFixed(3));
      scene.style.setProperty("--py", (e.clientY / innerHeight - 0.5).toFixed(3));
    });
  }, { passive: true });
}
if (scene && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let scrollRaf = 0;
  const applyScroll = () => { scrollRaf = 0; scene.style.setProperty("--sy", String(scrollY)); };
  addEventListener("scroll", () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(applyScroll); }, { passive: true });
  applyScroll();
}

const siteNav = document.querySelector(".site-nav");
if (siteNav) {
  const setNavHeight = () => document.documentElement.style.setProperty("--nav-h", siteNav.offsetHeight + "px");
  addEventListener("resize", setNavHeight, { passive: true });
  setNavHeight();
}

// Highlight the section link for wherever the reader is. A line below the
// sticky header decides the active section so menu jumps and scrolling agree.
const navAnchors = [...document.querySelectorAll(".nav-links a")];
const navSections = navAnchors.map((a) => a.hash ? document.getElementById(a.hash.slice(1)) : null).filter(Boolean);
navSections.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
let clickedHash = null;
for (const a of navAnchors) if (a.hash) a.addEventListener("click", () => { clickedHash = a.hash; });
addEventListener("wheel", () => { clickedHash = null; }, { passive: true });
addEventListener("touchmove", () => { clickedHash = null; }, { passive: true });
function syncActiveLink() {
  const line = (siteNav ? siteNav.offsetHeight : 0) + 40;
  let current = null;
  for (const sec of navSections) {
    if (sec.getBoundingClientRect().top <= line) current = sec;
  }
  if (navSections.length && Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 2) {
    current = (clickedHash && navSections.find((sec) => "#" + sec.id === clickedHash)) || navSections[navSections.length - 1];
  }
  for (const a of navAnchors) {
    const on = !!current && a.hash === "#" + current.id;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}
let spyRaf = 0;
addEventListener("scroll", () => { if (!spyRaf) spyRaf = requestAnimationFrame(() => { spyRaf = 0; syncActiveLink(); }); }, { passive: true });
addEventListener("resize", syncActiveLink, { passive: true });
syncActiveLink();

// FAQ accordions: each question toggles its answer open.
document.querySelectorAll(".faq-q button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    btn.closest(".faq-item").classList.toggle("open", !open);
    document.getElementById(btn.getAttribute("aria-controls")).hidden = open;
  });
});

// Cursor dust: tiny chartreuse sparks trail the pointer and burn out about a
// second after it rests. Touch and reduced-motion skip it.
(() => {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:2100;pointer-events:none;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let w = 0, h = 0;
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener("resize", size);

  const sprite = (core) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const halo = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    halo.addColorStop(0, "rgba(171, 207, 55, 0.55)");
    halo.addColorStop(0.4, "rgba(171, 207, 55, 0.16)");
    halo.addColorStop(1, "rgba(171, 207, 55, 0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = core;
    g.beginPath();
    g.arc(32, 32, 4.5, 0, 7);
    g.fill();
    return c;
  };
  const dust = { dark: sprite("#d7ef7a"), light: sprite("#7e9c26") };

  const sparks = [];
  const MAX = 90;
  let raf = 0, prev = 0, lastX = -1, lastY = -1, carry = 0;

  const spawn = (x, y, dx, dy) => {
    if (sparks.length >= MAX) return;
    const a = Math.random() * Math.PI * 2;
    const push = 4 + Math.random() * 16;
    sparks.push({
      x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8,
      vx: Math.cos(a) * push + dx * 1.4, vy: Math.sin(a) * push + dy * 1.4,
      life: 0, ttl: 0.45 + Math.random() * 0.5, r: 5 + Math.random() * 9,
      star: Math.random() < 0.25, rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 4, seed: Math.random() * 40
    });
  };
  const star = (R) => {
    ctx.beginPath();
    ctx.moveTo(0, -R);
    ctx.quadraticCurveTo(R * 0.16, -R * 0.16, R, 0);
    ctx.quadraticCurveTo(R * 0.16, R * 0.16, 0, R);
    ctx.quadraticCurveTo(-R * 0.16, R * 0.16, -R, 0);
    ctx.quadraticCurveTo(-R * 0.16, -R * 0.16, 0, -R);
    ctx.fill();
  };
  const tick = (now) => {
    const t = now / 1000;
    const dt = Math.min(0.05, prev ? t - prev : 0.016);
    prev = t;
    ctx.clearRect(0, 0, w, h);
    const light = document.documentElement.dataset.theme === "light";
    const img = light ? dust.light : dust.dark;
    ctx.fillStyle = light ? "#7e9c26" : "#d7ef7a";
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.life += dt;
      if (sp.life >= sp.ttl) { sparks.splice(i, 1); continue; }
      sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.vx *= 0.9; sp.vy = sp.vy * 0.9 + 26 * dt;
      const k = 1 - sp.life / sp.ttl;
      const twinkle = 0.7 + 0.3 * Math.sin(t * 16 + sp.seed);
      ctx.globalAlpha = k * k * twinkle;
      const R = sp.r * (0.5 + 0.7 * k);
      ctx.drawImage(img, sp.x - R, sp.y - R, R * 2, R * 2);
      if (sp.star) { sp.rot += sp.spin * dt; ctx.save(); ctx.translate(sp.x, sp.y); ctx.rotate(sp.rot); star(R * 0.9); ctx.restore(); }
    }
    ctx.globalAlpha = 1;
    if (sparks.length) raf = requestAnimationFrame(tick);
    else { raf = 0; prev = 0; ctx.clearRect(0, 0, w, h); }
  };
  addEventListener("pointermove", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    if (lastX < 0) { lastX = e.clientX; lastY = e.clientY; return; }
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    carry += Math.hypot(dx, dy);
    while (carry > 10) { carry -= 10; spawn(e.clientX, e.clientY, dx, dy); }
    if (sparks.length && !raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
})();

if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/background-begone/sw.js").catch(() => { /* offline support is optional */ });
  });
}

console.info(
  "%cBuilt by Jayden Yoon ZK%c https://github.com/JaydenYoonZK",
  "background:#abcf37;color:#101400;font-weight:700;padding:2px 8px;border-radius:999px",
  "color:inherit"
);

if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.querySelectorAll("svg").forEach((el) => el.pauseAnimations?.());
}

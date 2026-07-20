/*! Background Begone | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-begone */

// The engine: loads the segmentation model once, then turns any image into a
// transparent PNG. Heavy math lives in cutout-core.js; the model file is
// cached in the Cache API so the ~30 MB download happens once per version.

import * as ort from "./vendor/ort.all.min.mjs";
import {
  MODEL_SIZE, normalizeImage, minMaxNormalize, guidedFilter,
  luminance, crispen, refineSize, applyAlpha,
} from "./cutout-core.js?v=1.0.0";

const MODEL_URL = "./models/isnet-int8.onnx";
const MODEL_CACHE = "bgb-model-1";
// The model's decompressed byte length. GitHub Pages gzips it on the wire, so
// the Content-Length header is the compressed size (~30 MB) while the reader
// yields the full decompressed stream; dividing progress by this constant
// keeps the bar from overshooting. Kept in sync with the file by a site test.
const MODEL_BYTES = 46360717;

// Single-threaded on purpose: GitHub Pages cannot send the isolation headers
// that multi-threaded wasm needs. The proxy worker keeps the page responsive
// while the model thinks.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = true;

let sessionPromise = null;
// The live progress sink. warm() starts the download with none; a real run
// then sets it, so the bar picks up mid-download at the correct percent.
let notify = null;

async function fetchModelBytes(onProgress) {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(MODEL_URL);
    if (hit) {
      onProgress?.("download", 1);
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch { /* private mode may block Cache API; download instead */ }
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error("The model could not be downloaded (HTTP " + res.status + ").");
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    // Progress against the decompressed size, clamped: the reader yields
    // decompressed bytes but the header's Content-Length is the gzipped size.
    onProgress?.("download", Math.min(1, got / MODEL_BYTES));
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  try {
    const cache = await caches.open(MODEL_CACHE);
    await cache.put(MODEL_URL, new Response(bytes.slice().buffer, {
      headers: { "Content-Type": "application/octet-stream" },
    }));
  } catch { /* caching is best effort */ }
  return bytes;
}

export function loadSession(onProgress) {
  if (onProgress) notify = onProgress;
  sessionPromise ||= (async () => {
    const bytes = await fetchModelBytes((s, p) => notify?.(s, p));
    notify?.("compile", 0);
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
    });
    notify?.("compile", 1);
    return session;
  })().catch((e) => { sessionPromise = null; throw e; });
  return sessionPromise;
}

function drawToCanvas(source, w, h, colorSpace) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  let ctx;
  if (colorSpace) {
    try { ctx = c.getContext("2d", { willReadFrequently: true, colorSpace }); } catch { /* older browser */ }
  }
  if (!ctx) ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return { canvas: c, ctx };
}

// The output canvas asks for the widest gamut the browser will give it, so a
// Display P3 photo keeps its saturated colors instead of being flattened to
// sRGB. The model input and luminance guide stay sRGB, which is what they want.
function outputColorSpace(ctx) {
  try {
    return ctx.getContextAttributes?.().colorSpace === "display-p3" ? "display-p3" : "srgb";
  } catch { return "srgb"; }
}

// Resizes a single-channel Float32Array through a canvas so the browser's
// bilinear filtering does the interpolation work.
function resizePlane(plane, sw, sh, dw, dh) {
  const src = document.createElement("canvas");
  src.width = sw;
  src.height = sh;
  const sctx = src.getContext("2d");
  const img = sctx.createImageData(sw, sh);
  for (let i = 0; i < sw * sh; i++) {
    const v = Math.round(plane[i] * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const { ctx } = drawToCanvas(src, dw, dh);
  const out = ctx.getImageData(0, 0, dw, dh).data;
  const res = new Float32Array(dw * dh);
  for (let i = 0; i < dw * dh; i++) res[i] = out[i * 4] / 255;
  return res;
}

// source: ImageBitmap or canvas/img with natural dimensions attached.
// Returns { blob, width, height } where blob is the transparent PNG.
export async function removeBackground(source, { width, height }, onProgress) {
  const session = await loadSession(onProgress);

  onProgress?.("model", 0);
  const { ctx: inCtx } = drawToCanvas(source, MODEL_SIZE, MODEL_SIZE);
  const inputRgba = inCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const x = normalizeImage(inputRgba, MODEL_SIZE);
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, MODEL_SIZE, MODEL_SIZE]) };
  const outputs = await session.run(feeds, [session.outputNames[0]]);
  const rawMatte = outputs[session.outputNames[0]].data;
  onProgress?.("model", 1);

  onProgress?.("refine", 0);
  const matte1024 = minMaxNormalize(rawMatte);

  // Refine at a capped working size: the matte is stretched over the photo,
  // then the guided filter re-attaches it to the photo's own edges.
  const rs = refineSize(width, height);
  const matteWork = resizePlane(matte1024, MODEL_SIZE, MODEL_SIZE, rs.w, rs.h);
  const { ctx: workCtx } = drawToCanvas(source, rs.w, rs.h);
  const workRgba = workCtx.getImageData(0, 0, rs.w, rs.h).data;
  const guide = luminance(workRgba, rs.w * rs.h);
  const refined = guidedFilter(guide, matteWork, rs.w, rs.h, 8, 1e-4);
  const crisp = crispen(refined, 0.35);
  onProgress?.("refine", 1);

  onProgress?.("encode", 0);
  const matteFull = rs.scale === 1 ? crisp : resizePlane(crisp, rs.w, rs.h, width, height);
  const { canvas: outCanvas, ctx: outCtx } = drawToCanvas(source, width, height, "display-p3");
  const space = outputColorSpace(outCtx);
  const outImage = outCtx.getImageData(0, 0, width, height, { colorSpace: space });
  applyAlpha(outImage.data, matteFull, width * height);
  outCtx.putImageData(outImage, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))), "image/png");
  });
  onProgress?.("encode", 1);
  return { blob, width, height };
}

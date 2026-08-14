/*! Background Bouncer | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-bouncer */

// The engine: loads the segmentation model once, then turns any image into a
// cutout with a transparent background. Heavy math lives in cutout-core.js;
// the model is cached in the Cache API so its download happens once per
// version, and the result is encoded small enough to actually send.

import {
  MODEL_SIZE, MODEL_SIZE_GPU, normalizeImage, guidedFilter, removeSmallIslands,
  luminance, crispen, defringe, backgroundColor, refineSize, outputSize, finishOutput,
  subjectBounds, blendPatch,
} from "./cutout-core.js?v=2.6.0";

// Two engines, and a visitor only ever downloads one of them.
//
// A browser with WebGPU runs the model at its native 1024 pixels on the GPU:
// about a quarter second, and fine detail like single hairs survives because
// nothing is being squeezed through a small canvas. That model has to be
// float16 (the int8 weights the CPU path uses have no GPU kernels), which is
// 112 MB, past the 100 MB a file can be in a git repository, so it is stored
// gzipped and unpacked here after the download.
//
// Everything else runs the small int8 model on the CPU exactly as before.
const GPU = {
  url: "./models/birefnet-lite-1024-fp16.onnx.gz",
  bytes: 82520133,           // the gzipped file, which is what crosses the wire
  size: MODEL_SIZE_GPU,
  gzipped: true,
  runtime: "./vendor/ort.webgpu.bundle.min.mjs",
  provider: "webgpu",
};
const CPU = {
  url: "./models/birefnet-lite-384.onnx",
  // Pages gzips this one on the wire, so its Content-Length is the compressed
  // size while the reader yields the whole decompressed stream; measuring
  // progress against the real byte length keeps the bar from overshooting.
  bytes: 66518452,
  size: MODEL_SIZE,
  gzipped: false,
  runtime: "./vendor/ort.all.min.mjs",
  provider: "wasm",
};
const MODEL_CACHE = "bouncer-model-4";
// Set when this browser's GPU accepted the model and then failed to compile
// or run it. Remembered across visits so the same driver is not asked to
// fail the same way every time; the key carries the model generation, so a
// new model gets a fresh chance.
const NO_GPU_KEY = "bouncer-no-gpu-4";

// Drop model caches from earlier versions so swapping the model file never
// leaves the previous blob orphaned in the visitor's browser.
if (typeof caches !== "undefined") {
  caches.keys().then((keys) => keys.forEach((k) => {
    if (k.startsWith("bouncer-model-") && k !== MODEL_CACHE) caches.delete(k);
  })).catch(() => { /* private mode may block the Cache API */ });
}

let sessionPromise = null;
// The engine that won, and the runtime it came from: removeBackground reads
// both to size its input and build its tensor.
let active = null;
let ort = null;
// The live progress sink. warm() starts the download with none; a real run
// then sets it, so the bar picks up mid-download at the correct percent.
let notify = null;

// Which engine ran, once one has loaded: "webgpu" or "wasm", else null.
export function activeProvider() {
  return active ? active.provider : null;
}

// Whether the GPU engine should even be offered. The 85 MB download is the
// whole cost of that path and it is spent before anything can be checked, so
// the decision has to be made up front, not discovered afterwards.
//
// A phone is the wrong place for it twice over: the download hurts most on
// mobile data, and a phone driver that advertises WebGPU can still fall over
// on a 1024-pixel model, which it only finds out after the fetch. A visitor
// who switched on data saving has answered the question themselves. Both keep
// the 40 MB CPU engine, which is the tool exactly as it worked before the
// GPU path existed. Beyond that, asking for an adapter is the only honest
// test: a browser can expose navigator.gpu and still hand back nothing.
function onPhone() {
  if (navigator.userAgentData) return navigator.userAgentData.mobile;
  return /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
}

async function wantsGPU() {
  if (typeof navigator === "undefined" || !navigator.gpu) return false;
  try { if (localStorage.getItem(NO_GPU_KEY)) return false; } catch { /* storage may be blocked */ }
  // saveData is an explicit choice and the phone check is structural; the
  // browser's connection-speed guess is neither, and in testing it called a
  // wired desktop "3g", so it does not get a vote.
  if (navigator.connection?.saveData) return false;
  if (onPhone()) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function loadRuntime(engine) {
  const ort = await import(engine.runtime);
  if (engine.provider === "webgpu") {
    // The WebGPU build fetches its own wasm companion; point it at the folder
    // the runtime was loaded from so a project-page subpath still resolves.
    ort.env.wasm.wasmPaths = new URL("./vendor/", import.meta.url).href;
  } else {
    // Single-threaded on purpose: GitHub Pages cannot send the isolation
    // headers multi-threaded wasm needs. The proxy worker keeps the page
    // responsive while the model thinks.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = true;
  }
  return ort;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchModelBytes(engine, onProgress) {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(engine.url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      // A cached entry of the wrong length is a truncated download that got
      // stored; served as-is it would fail on every visit forever. Evict it
      // and fetch fresh instead.
      if (buf.byteLength === engine.bytes) {
        onProgress?.("download", 1);
        return new Uint8Array(buf);
      }
      await cache.delete(engine.url);
    }
  } catch { /* private mode may block Cache API; download instead */ }
  const res = await fetch(engine.url);
  if (!res.ok) throw new Error("The model could not be downloaded (HTTP " + res.status + ").");
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.("download", Math.min(1, got / engine.bytes));
  }
  if (got !== engine.bytes) {
    throw new Error("The model arrived incomplete. Check the connection and try again.");
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  try {
    const cache = await caches.open(MODEL_CACHE);
    await cache.put(engine.url, new Response(bytes.slice().buffer, {
      headers: { "Content-Type": "application/octet-stream" },
    }));
  } catch { /* caching is best effort */ }
  return bytes;
}

async function start(engine, notifyFn) {
  const ort = await loadRuntime(engine);
  let bytes = await fetchModelBytes(engine, notifyFn);
  if (engine.gzipped) bytes = await gunzip(bytes);
  notifyFn?.("compile", 0);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [engine.provider],
  });
  notifyFn?.("compile", 1);
  return { session, ort, engine };
}

export function loadSession(onProgress) {
  if (onProgress) notify = onProgress;
  sessionPromise ||= (async () => {
    const sink = (s, p) => notify?.(s, p);
    if (await wantsGPU()) {
      try {
        const ready = await start(GPU, sink);
        active = ready.engine;
        ort = ready.ort;
        return ready.session;
      } catch {
        // A driver can advertise WebGPU and still fail to compile the graph.
        // Fall back to the CPU engine, remember the failure so this browser
        // is not walked into it on every visit, and release the 85 MB that
        // will never be used here.
        try { localStorage.setItem(NO_GPU_KEY, "1"); } catch { /* storage may be blocked */ }
        try { (await caches.open(MODEL_CACHE)).delete(GPU.url); } catch { /* best effort */ }
      }
    }
    const ready = await start(CPU, sink);
    active = ready.engine;
    ort = ready.ort;
    return ready.session;
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

// High enough that the loss hides inside photographic detail, low enough that
// the file is a fraction of a PNG. Measured on the sample: 1.5/255 average
// colour difference over the kept subject, and no alpha difference at all.
const WEBP_QUALITY = 0.92;

function encode(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))), type, quality);
  });
}

// One trip through the network: normalize what is on the canvas and read the
// probability matte back.
async function runModel(session, ctx, S) {
  const rgba = ctx.getImageData(0, 0, S, S).data;
  const x = normalizeImage(rgba, S);
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, S, S]) };
  const out = await session.run(feeds, [session.outputNames[0]]);
  return out[session.outputNames[0]].data;
}

function drawRegion(source, sx, sy, sw, sh, dw, dh) {
  const c = document.createElement("canvas");
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx;
}

// A subject that fills a third of the photo only gets a third of the model's
// canvas, and detail it never saw cannot be recovered later. So once the first
// pass has found where the subject is, the model looks again at just that
// region, spending the whole canvas on it. Worth it only when the crop is
// meaningfully tighter than the frame, and only on the GPU, where the second
// look costs a quarter of a second rather than another four.
const REFINE_MAX_AREA = 0.55; // skip when the subject already fills the frame
const REFINE_PAD = 0.06;      // a little context around the subject to judge by

async function refineOnSubject(source, session, S, matteModel, width, height, work) {
  const b = subjectBounds(matteModel, S, S);
  if (!b) return false;
  const boxW = (b.x1 - b.x0 + 1) / S, boxH = (b.y1 - b.y0 + 1) / S;
  if (boxW * boxH > REFINE_MAX_AREA) return false;
  // Model space is a squashed square, so a coordinate maps straight across.
  const x0 = Math.max(0, Math.floor((b.x0 / S - REFINE_PAD) * width));
  const y0 = Math.max(0, Math.floor((b.y0 / S - REFINE_PAD) * height));
  const x1 = Math.min(width, Math.ceil(((b.x1 + 1) / S + REFINE_PAD) * width));
  const y1 = Math.min(height, Math.ceil(((b.y1 + 1) / S + REFINE_PAD) * height));
  const cw = x1 - x0, ch = y1 - y0;
  if (cw < 64 || ch < 64) return false;

  const patch = await runModel(session, drawRegion(source, x0, y0, cw, ch, S, S), S);
  // Place the close-up matte where it was measured from, at working scale.
  const px = Math.round(x0 * work.w / width), py = Math.round(y0 * work.h / height);
  const pw = Math.max(1, Math.round(cw * work.w / width));
  const ph = Math.max(1, Math.round(ch * work.h / height));
  const scaled = resizePlane(patch, S, S, pw, ph);
  blendPatch(work.matte, work.w, work.h, scaled, px, py, pw, ph, Math.round(Math.min(pw, ph) * 0.06));
  return true;
}

// source: ImageBitmap or canvas/img with natural dimensions attached.
// Returns { blob, width, height, asPng } where blob is the transparent cutout
// and asPng() encodes the same pixels as a PNG on demand.
export async function removeBackground(source, { width, height }, onProgress) {
  let session = await loadSession(onProgress);
  // The canvas the model reads: 1024 on the GPU, 384 on the CPU.
  let S = active.size;

  onProgress?.("model", 0);
  let rawMatte;
  try {
    rawMatte = await runModel(session, drawToCanvas(source, S, S).ctx, S);
  } catch (e) {
    if (active.provider !== "webgpu") throw e;
    // The driver compiled the model and then failed to run it. Remember that,
    // switch to the CPU engine, and finish the job rather than surfacing an
    // error the visitor cannot do anything about.
    try { localStorage.setItem(NO_GPU_KEY, "1"); } catch { /* storage may be blocked */ }
    try { (await caches.open(MODEL_CACHE)).delete(GPU.url); } catch { /* best effort */ }
    sessionPromise = null;
    active = null;
    ort = null;
    session = await loadSession(onProgress);
    S = active.size;
    // Re-announce the model stage: the interlude was a download and compile,
    // and anything timing the cut from this event must not count them.
    onProgress?.("model", 0);
    rawMatte = await runModel(session, drawToCanvas(source, S, S).ctx, S);
  }
  onProgress?.("model", 1);

  onProgress?.("refine", 0);
  // BiRefNet's head already ends in a sigmoid, so the raw output is a 0..1
  // probability matte: use it as-is (unlike an unbounded head, min-max
  // rescaling here would blow out a subject that fills the whole frame). A
  // cheap island pass first drops any tiny stray fleck left in the background.
  const matteModel = removeSmallIslands(rawMatte, S, S);

  // Refine at a capped working size: the matte is stretched over the photo,
  // then the guided filter re-attaches it to the photo's own edges.
  // The GPU path affords a bigger working canvas for the edge re-cut, which
  // is where large photos gain: a 4000-pixel photo's strands are re-cut
  // against 3072 pixels of real detail instead of 2048. Only photos larger
  // than the cap are affected at all.
  const rs = refineSize(width, height, active.provider === "webgpu" ? 3072 : 2048);
  const matteWork = resizePlane(matteModel, S, S, rs.w, rs.h);

  // The close-up second look, where the GPU makes one affordable. It only
  // sharpens the matte before the guided filter runs, so if anything about it
  // fails the whole-frame matte is still there and the cutout still happens.
  if (active.provider === "webgpu") {
    try {
      await refineOnSubject(source, session, S, matteModel, width, height,
        { matte: matteWork, w: rs.w, h: rs.h });
    } catch { /* the first pass already gave a usable matte */ }
  }

  const { ctx: workCtx } = drawToCanvas(source, rs.w, rs.h);
  const workRgba = workCtx.getImageData(0, 0, rs.w, rs.h).data;
  const guide = luminance(workRgba, rs.w * rs.h);
  const refined = guidedFilter(guide, matteWork, rs.w, rs.h, 8, 1e-4);
  const crisp = defringe(crispen(refined, 0.35), 0.22);
  onProgress?.("refine", 1);

  onProgress?.("encode", 0);
  // Bound the output canvas so a huge phone photo cannot exceed a mobile
  // browser's canvas ceiling (a blank export) or run the tab out of memory.
  const os = outputSize(width, height);
  const outW = os.w, outH = os.h;
  const matteFull = outW === rs.w && outH === rs.h ? crisp : resizePlane(crisp, rs.w, rs.h, outW, outH);
  const { canvas: outCanvas, ctx: outCtx } = drawToCanvas(source, outW, outH, "display-p3");
  const space = outputColorSpace(outCtx);
  const outImage = outCtx.getImageData(0, 0, outW, outH, { colorSpace: space });
  const n = outW * outH;
  // Unmix the old background's color out of the edge pixels in the same
  // sweep that writes alpha, so the cutout carries no colored halo onto a
  // new background and a 16-megapixel photo is walked once, not twice.
  finishOutput(outImage.data, matteFull, n, backgroundColor(outImage.data, matteFull, n));
  outCtx.putImageData(outImage, 0, 0);
  // WebP is the file the visitor actually gets. It stores the alpha channel
  // exactly, so the cutout itself is untouched, and spends a little colour
  // precision the eye cannot find: measured against the PNG of the same
  // cutout, the average pixel differs by 1.5 parts in 255 and the file is a
  // tenth of the size. It also encodes faster than PNG on a large photo.
  // A browser too old to encode it hands back a PNG, which is still correct.
  const blob = await encode(outCanvas, "image/webp", WEBP_QUALITY);
  // The PNG is not made unless it is asked for, so nobody waits on an encode
  // they will not use.
  let pending = null;
  const asPng = () => (pending ||= encode(outCanvas, "image/png"));
  onProgress?.("encode", 1);
  return { blob, width: outW, height: outH, asPng };
}

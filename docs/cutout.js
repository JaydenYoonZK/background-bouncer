/*! Background Bouncer | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-bouncer */

// The engine: loads the segmentation model once, then turns any image into a
// cutout with a transparent background. Heavy math lives in cutout-core.js;
// the model is cached in the Cache API so its download happens once per
// version, and the result is encoded small enough to actually send.

import {
  MODEL_SIZE, MODEL_SIZE_GPU, normalizeImage, guidedFilter, removeSmallIslands,
  luminance, crispen, defringe, backgroundColor, refineSize, outputSize, finishOutput,
  subjectBounds, blendPatch, colorRescue, dropOrphanSoft, resizePlaneF, localBackgroundMap,
  subjectPresence, encodePng, pngColorChunks, buildPalette, refinePalette, makeDitherState, ditherRows,
  blobRescue,
} from "./cutout-core.js?v=2.20.8";

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
// The shipped WebP encoder, built once and kept: a fresh Emscripten
// instance per cut left the previous one's whole heap waiting on the
// collector, and on a phone those corpses stack up against the tab's
// memory ceiling faster than they are buried.
let wasmWebpPromise = null;
function loadWasmWebp() {
  return (wasmWebpPromise ||= (async () => {
    const factory = async (name) => (await import(`./vendor/${name}`)).default;
    try { return await (await factory("webp_enc_simd.mjs"))(); }
    catch { return await (await factory("webp_enc.mjs"))(); }
  })().catch((e) => { wasmWebpPromise = null; throw e; }));
}
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
export function onPhone() {
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

async function fetchModelBytes(engine, onProgress, signal) {
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
  const res = await fetch(engine.url, { signal });
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

// One download shared between the warm-up and the run. warm() used to build
// the whole session, but unpacking and compiling a model is main-thread work,
// and on a return visit with a cached model all of it landed in the second
// between the first mouse move and the click, which is exactly when the
// sample button has to answer. So the warm-up now only fetches bytes, which
// is network and cache work the page never feels, and the compile happens
// inside the run, where the progress bar narrates it.
let prefetched = null;
function fetchShared(engine) {
  if (prefetched && prefetched.url !== engine.url) {
    // The engine changed underneath an in-flight download, say a GPU failure
    // in another tab banning the GPU path mid-warm-up. Abandoned unstopped,
    // that stream would keep reporting into the live progress bar against
    // the wrong byte total, and cache a model this browser will never use.
    prefetched.abort.abort();
    prefetched = null;
  }
  if (!prefetched) {
    const abort = new AbortController();
    const promise = fetchModelBytes(engine, (s, p) => notify?.(s, p), abort.signal);
    prefetched = { url: engine.url, promise, abort };
    promise.catch(() => { if (prefetched && prefetched.promise === promise) prefetched = null; });
  }
  return prefetched.promise;
}

export function prefetchModel() {
  return (async () => {
    await fetchShared((await wantsGPU()) ? GPU : CPU);
  })();
}

async function start(engine, notifyFn) {
  const ort = await loadRuntime(engine);
  let bytes = await fetchShared(engine);
  // Let go of the shared reference so the raw download can be collected once
  // the session owns its own copy; a later load rereads the Cache API.
  if (prefetched && prefetched.url === engine.url) prefetched = null;
  if (engine.gzipped) bytes = await gunzip(bytes);
  notifyFn?.("compile", 0);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [engine.provider],
  });
  notifyFn?.("compile", 1);
  return { session, ort, engine };
}

export function loadSession(onProgress) {
  // A run beginning reclaims the session from the idle-release timer; the
  // release must never land while a cut is using what it releases.
  clearTimeout(idleReleaseTimer);
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

// The matte moves between sizes in float now (resizePlaneF): the old canvas
// route rounded it to 8 bits on every hop, stepping the very gradients a
// soft hair edge is made of.
const resizePlane = resizePlaneF;

// High enough that the loss hides inside photographic detail, low enough that
// the file is a small fraction of a PNG. Measured on the sample: about 2.4/255
// average colour difference over the kept subject and no alpha difference at
// all, for a file 20% smaller than 0.92 gave; on a 16-megapixel photo the
// difference is 1.3/255 and the saving is a quarter of the file.
const WEBP_QUALITY = 0.85;

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

  const patch = await steadyReads(session, drawRegion(source, x0, y0, cw, ch, S, S), S);
  // Place the close-up matte where it was measured from, at working scale.
  const px = Math.round(x0 * work.w / width), py = Math.round(y0 * work.h / height);
  const pw = Math.max(1, Math.round(cw * work.w / width));
  const ph = Math.max(1, Math.round(ch * work.h / height));
  const scaled = resizePlane(patch, S, S, pw, ph);
  blendPatch(work.matte, work.w, work.h, scaled, px, py, pw, ph, Math.round(Math.min(pw, ph) * 0.06));
  return true;
}

// The model read twice: once as the canvas is, once mirrored, the two
// mattes averaged. The mirrored view is a second independent opinion from
// the same network, and where the two disagree is exactly where the model
// was guessing; averaging steadies those pixels. Graphics path only, where
// a second read costs a quarter second rather than another five. Both the
// whole-frame pass and the close-up second look go through here.
async function steadyReads(session, ctx, S) {
  const straight = await runModel(session, ctx, S);
  if (active.provider !== "webgpu") return straight;
  try {
    const m = document.createElement("canvas");
    m.width = m.height = S;
    const mctx = m.getContext("2d", { willReadFrequently: true });
    mctx.translate(S, 0);
    mctx.scale(-1, 1);
    mctx.drawImage(ctx.canvas, 0, 0);
    const mirrored = await runModel(session, mctx, S);
    for (let y = 0; y < S; y++) {
      const row = y * S;
      for (let x = 0; x < S; x++) {
        straight[row + x] = (straight[row + x] + mirrored[row + S - 1 - x]) / 2;
      }
    }
  } catch { /* one opinion is still a cutout */ }
  return straight;
}

async function runModelSteady(session, source, S) {
  return steadyReads(session, drawToCanvas(source, S, S).ctx, S);
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
    rawMatte = await runModelSteady(session, source, S);
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
    rawMatte = await runModelSteady(session, source, S);
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

  // The close-up second look, on every engine. It was graphics-only at first,
  // but that quietly made a phone's cutout a second-class one: the phone runs
  // the small model AND never got the zoom pass, which is exactly where the
  // kept-bench-and-shadow errors come from. On the processor the second look
  // roughly doubles the wait for a photo whose subject is small in the frame,
  // and that is the right trade: slower and right beats fast and wrong. It
  // only sharpens the matte before the guided filter runs, so if anything
  // about it fails the whole-frame matte is still there.
  try {
    await refineOnSubject(source, session, S, matteModel, width, height,
      { matte: matteWork, w: rs.w, h: rs.h });
  } catch { /* the first pass already gave a usable matte */ }

  const { ctx: workCtx } = drawToCanvas(source, rs.w, rs.h);
  const workRgba = workCtx.getImageData(0, 0, rs.w, rs.h).data;
  const guide = luminance(workRgba, rs.w * rs.h);
  const refined = guidedFilter(guide, matteWork, rs.w, rs.h, 8, 1e-4);
  // Question the kept pixels along the boundary against local colour
  // evidence: a strip of bench or shadow the model kept as subject plainly
  // matches the background around it, and comes out here. Twice: what the
  // first round clears becomes confident background, which sharpens the
  // local evidence and lets the second round remove what was ambiguous.
  let rescued = colorRescue(workRgba, refined, rs.w, rs.h);
  rescued = colorRescue(workRgba, rescued, rs.w, rs.h);
  // The rescue rounds change alpha from colour evidence alone, without
  // looking at where the photo's edges run; a tight second guided pass
  // re-snaps the reshaped boundary to the real edges before it sets.
  rescued = guidedFilter(guide, rescued, rs.w, rs.h, 3, 5e-5);
  // A last sweep on the finished matte: refinement can leave flecks that the
  // early island pass, which ran on the raw model output, never saw. Every
  // floating solid speck goes, then every soft wisp attached to nothing.
  let crisp = dropOrphanSoft(
    removeSmallIslands(defringe(crispen(rescued, 0.35), 0.22), rs.w, rs.h),
    rs.w, rs.h
  );
  // A last look at whole regions: a chunk of background wedged between two
  // subjects is invisible to the island pass (it is attached) and too big a
  // claim for per-pixel colour evidence; judged as one blob it is plain.
  crisp = blobRescue(workRgba, crisp, rs.w, rs.h);
  // A photo with no clear subject gets an honest answer, not an empty file.
  // Under 0.2% of the frame kept means the model found nothing it believed
  // in; over 99.5% means it could not tell a subject from the background and
  // kept everything, which is no cut at all.
  const presence = subjectPresence(crisp, rs.w * rs.h);
  if (presence < 0.002 || presence > 0.995) {
    const err = new Error("no clear subject in the photo");
    err.noSubject = true;
    throw err;
  }
  onProgress?.("refine", 1);

  onProgress?.("encode", 0);
  // Bound the output canvas so a huge phone photo cannot exceed a mobile
  // browser's canvas ceiling (a blank export) or run the tab out of memory.
  const os = outputSize(width, height);
  const outW = os.w, outH = os.h;
  const matteFull = outW === rs.w && outH === rs.h ? crisp : resizePlane(crisp, rs.w, rs.h, outW, outH);
  // What was actually behind each edge, learned at working size and carried
  // up to the output, so an edge over dark wood and an edge over bright mist
  // are each un-mixed against their own background rather than the average.
  const bgW = localBackgroundMap(workRgba, crisp, rs.w, rs.h);
  const same = outW === rs.w && outH === rs.h;
  const bgMap = {
    r: same ? bgW.r : resizePlane(bgW.r, rs.w, rs.h, outW, outH),
    g: same ? bgW.g : resizePlane(bgW.g, rs.w, rs.h, outW, outH),
    b: same ? bgW.b : resizePlane(bgW.b, rs.w, rs.h, outW, outH),
    ok: same ? bgW.ok : resizePlane(bgW.ok, rs.w, rs.h, outW, outH),
  };
  const { canvas: outCanvas, ctx: outCtx } = drawToCanvas(source, outW, outH, "display-p3");
  const space = outputColorSpace(outCtx);
  const outImage = outCtx.getImageData(0, 0, outW, outH, { colorSpace: space });
  const n = outW * outH;
  // Unmix the old background's color out of the edge pixels in the same
  // sweep that writes alpha, so the cutout carries no colored halo onto a
  // new background and a 16-megapixel photo is walked once, not twice.
  finishOutput(outImage.data, matteFull, n, backgroundColor(outImage.data, matteFull, n), bgMap);
  outCtx.putImageData(outImage, 0, 0);
  // The canvas stores hidden pixels premultiplied to black; the straight
  // copy keeps their old colours, which are invisible bytes that cost every
  // encoder real file size. Clear them once, for all the encoders below,
  // in chunks so a 16-megapixel clear cannot hold an animation frame.
  {
    const data = outImage.data;
    const CLEAR_STEP = 1 << 20;
    for (let start = 0; start < n; start += CLEAR_STEP) {
      const end = Math.min(n, start + CLEAR_STEP);
      for (let i = start; i < end; i++) {
        if (data[i * 4 + 3] === 0) { data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; }
      }
      if (end < n) await new Promise((r) => setTimeout(r, 0));
    }
  }
  // The colour chunks the browser would write for this canvas, harvested
  // from a one-pixel encode, so every custom-assembled file carries exactly
  // the profile the canvas would have declared.
  const harvestColorChunks = async () => {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    let probeCtx;
    try { probeCtx = probe.getContext("2d", { colorSpace: space }); } catch { /* older browser */ }
    if (!probeCtx) probeCtx = probe.getContext("2d");
    probeCtx.drawImage(outCanvas, 0, 0, 1, 1);
    const tiny = await encode(probe, "image/png");
    return pngColorChunks(new Uint8Array(await tiny.arrayBuffer()));
  };
  // WebP is the file the visitor gets where the browser can make one: exact
  // alpha, a little colour precision the eye cannot find, a tenth the size
  // of the lossless PNG. Where it cannot, Safari above all, the compressed
  // file is a palette PNG instead: up to 256 colours chosen for this photo,
  // the rounding hidden in dithering noise, which is the same trade the
  // well-known PNG shrinking services make. Transparency survives both.
  let blob = await encode(outCanvas, "image/webp", WEBP_QUALITY);
  let compressed = blob.type === "image/webp" ? "webp" : null;
  // Test switches: "bouncer-png8" behaves exactly like a browser with no
  // WebP encoder in its canvas; "bouncer-nowasm" additionally refuses the
  // shipped encoder, so the palette fallback can be exercised too.
  let png8Test = false, noWasmTest = false;
  try {
    png8Test = !!localStorage.getItem("bouncer-png8");
    noWasmTest = !!localStorage.getItem("bouncer-nowasm");
  } catch { /* storage may be blocked */ }
  if (png8Test && compressed) {
    blob = await encode(outCanvas, "image/png");
    compressed = null;
  }
  if (!compressed && !noWasmTest) {
    // The canvas cannot make a WebP here, Safari above all, so the tool
    // brings its own encoder: libwebp compiled to WebAssembly, 0.3 MB
    // fetched once and cached, and an iPhone's download becomes the same
    // WebP a desktop gets instead of a many-times-larger PNG. The pixels
    // are read back in sRGB, which is what an untagged WebP is taken to be.
    try {
      let srgb;
      try { srgb = outCtx.getImageData(0, 0, outW, outH, { colorSpace: "srgb" }); }
      catch { srgb = outCtx.getImageData(0, 0, outW, outH); }
      const enc = await loadWasmWebp();
      const buf = enc.encode(srgb.data, outW, outH, {
        // libwebp's WebPConfig defaults, with the tool's own quality.
        quality: Math.round(WEBP_QUALITY * 100),
        target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50,
        filter_strength: 60, filter_sharpness: 0, filter_type: 1,
        partitions: 0, segments: 4, pass: 1, show_compressed: 0,
        preprocessing: 0, autofilter: 0, partition_limit: 0,
        alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100,
        lossless: 0, exact: 0, image_hint: 0, emulate_jpeg_size: 0,
        thread_level: 0, low_memory: 0, near_lossless: 100,
        use_delta_palette: 0, use_sharp_yuv: 0,
      });
      if (buf) {
        const wasmWebp = new Blob([buf], { type: "image/webp" });
        if (wasmWebp.size < blob.size * 0.8) {
          blob = wasmWebp;
          compressed = "webp";
        }
      }
    } catch { /* the palette PNG below still compresses */ }
  }
  if (!compressed) {
    try {
      const data = outImage.data;
      const sampleStep = Math.max(1, Math.floor(n / 200000));
      let palette = buildPalette(data, n, 256, sampleStep);
      // Lloyd rounds settle the palette onto the photo; with the gentler
      // dither below that measures both smaller and truer than either
      // change alone. The refinement is heavy, so it breathes between rounds.
      for (let it = 0; it < 3; it++) {
        palette = refinePalette(data, n, palette, 1, sampleStep * 2);
        await new Promise((r) => setTimeout(r, 0));
      }
      const indices = new Uint8Array(n);
      const DITHER_STRENGTH = 0.5;
      const st = makeDitherState(outW, palette, DITHER_STRENGTH);
      const DITHER_ROWS = 64;
      for (let y0 = 0; y0 < outH; y0 += DITHER_ROWS) {
        ditherRows(data, outW, y0, Math.min(outH, y0 + DITHER_ROWS), indices, st);
        if (y0 + DITHER_ROWS < outH) await new Promise((r) => setTimeout(r, 0));
      }
      const bytes = await encodePng(indices, outW, outH, {
        colorChunks: await harvestColorChunks(),
        yieldEvery: 256,
        indexed: { palette },
      });
      const quantized = new Blob([bytes], { type: "image/png" });
      // Only worth shipping if it genuinely is the compressed file.
      if (quantized.size < blob.size * 0.8) {
        blob = quantized;
        compressed = "png8";
      }
    } catch { /* the lossless PNG stays the download */ }
  }
  // The lossless PNG is not made unless it is asked for, so nobody waits on
  // an encode they will not use. When it is asked for, the file is assembled
  // here with per-row adaptive filtering, which measures 12 to 17% smaller
  // than the canvas encoder's output for the same lossless pixels. Anything
  // failing falls back to the canvas encoder.
  let pending = null;
  const asPng = () => (pending ||= (async () => {
    try {
      // Read the pixels back only when the PNG is actually wanted: holding
      // a full-resolution copy in the meantime is memory a phone cannot
      // spare while its owner pinch-zooms the result. The canvas already
      // stores hidden pixels premultiplied to black, so nothing to clear.
      let px;
      try { px = outCtx.getImageData(0, 0, outW, outH, { colorSpace: space }); }
      catch { px = outCtx.getImageData(0, 0, outW, outH); }
      const bytes = await encodePng(px.data, outW, outH, {
        colorChunks: await harvestColorChunks(),
        yieldEvery: 64,
      });
      return new Blob([bytes], { type: "image/png" });
    } catch {
      return encode(outCanvas, "image/png");
    }
  })());
  onProgress?.("encode", 1);
  // A phone's memory ceiling is the whole game there: once the result is
  // out the inference session's heap is the biggest thing still standing,
  // and a pinch-zoom re-raster on top of it can take the tab down. Let it
  // go after a quiet half minute; the model bytes stay cached, so the next
  // photo pays a short compile, not a download.
  if (onPhone()) {
    clearTimeout(idleReleaseTimer);
    idleReleaseTimer = setTimeout(releaseSessionIdle, 30000);
  }
  return { blob, width: outW, height: outH, asPng, compressed };
}

let idleReleaseTimer = 0;
async function releaseSessionIdle() {
  const p = sessionPromise;
  if (!p) return;
  sessionPromise = null;
  active = null;
  ort = null;
  try { (await p).release?.(); } catch { /* the worker dies with its session */ }
}

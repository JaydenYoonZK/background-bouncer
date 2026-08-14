import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const pkg = JSON.parse(read("package.json"));
const index = read("docs/index.html");
const notFound = read("docs/404.html");
const sw = read("docs/sw.js");
const app = read("docs/app.js");
const cutout = read("docs/cutout.js");

test("every versioned asset reference carries the package version", () => {
  const v = pkg.version;
  for (const [name, text] of [["index.html", index], ["404.html", notFound], ["app.js", app], ["cutout.js", cutout], ["sw.js", sw]]) {
    const refs = text.match(/\?v=(\d+\.\d+\.\d+)/g) || [];
    for (const ref of refs) {
      assert.equal(ref, `?v=${v}`, `${name} carries ${ref}, expected ?v=${v}`);
    }
  }
  assert.ok(index.includes(`"softwareVersion": "${v}"`), "JSON-LD softwareVersion in lockstep");
});

test("the CSP forbids talking to anything but the page itself", () => {
  const csp = index.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(csp.includes("connect-src 'self'"), "connect-src limited to self");
  assert.ok(csp.includes("default-src 'none'"), "default deny");
  assert.ok(csp.includes("'wasm-unsafe-eval'"), "wasm allowed for the runtime");
  assert.ok(csp.includes("worker-src 'self' blob:"), "worker allowed for the proxy");
  assert.ok(!csp.includes("unsafe-inline'") || csp.includes("style-src 'self' 'unsafe-inline'"), "no inline script allowance");
});

test("the service worker precache list points at real files", () => {
  const shell = [...sw.matchAll(/^\s*"([^"]+?)(?:" \+ VERSION)?,?"?,?\s*$/gm)]
    .map((m) => m[1])
    .filter((f) => f !== "./");
  for (const f of shell) {
    assert.ok(existsSync(join(root, "docs", f)), `precached ${f} exists`);
  }
});

test("the page ships no inline event handlers or scripts at all", () => {
  assert.ok(!/ on[a-z]+="/i.test(index), "no inline handlers");
  const inline = index.match(/<script>([\s\S]*?)<\/script>/g) || [];
  // The theme boot used to live inline, where the page's own CSP silently
  // blocked it; it is an external file now, so nothing inline remains.
  assert.equal(inline.length, 0, "no inline scripts (the CSP would block them)");
  assert.match(index, /<script src="theme-boot\.js\?v=/, "the theme boot loads as a file");
});

test("the service worker keeps the tool alive offline across version bumps", () => {
  const sw = readFileSync(join(root, "docs/sw.js"), "utf8");
  assert.match(sw, /"theme-boot\.js" \+ VERSION/, "theme boot is precached");
  assert.match(sw, /bouncer-vendor-/, "the ONNX runtime has its own long-lived cache");
  assert.match(sw, /scopePath \+ "index\.html"/, "offline index.html navigation gets the app, not the 404 page");
});

const MODELS = [
  "docs/models/birefnet-lite-1024-fp16.onnx.gz",
  "docs/models/birefnet-lite-384.onnx",
];

test("both engines' model and runtime files are in place and under GitHub's limit", () => {
  const runtimes = [
    "docs/vendor/ort.all.min.mjs",
    "docs/vendor/ort-wasm-simd-threaded.jsep.wasm",
    "docs/vendor/ort.webgpu.bundle.min.mjs",
    "docs/vendor/ort-wasm-simd-threaded.asyncify.wasm",
  ];
  for (const f of [...MODELS, ...runtimes]) {
    assert.ok(existsSync(join(root, f)), `${f} exists`);
  }
  for (const m of MODELS) {
    const size = readFileSync(join(root, m)).length;
    // A file over 100 MB cannot be pushed at all, which is why the float16
    // model ships gzipped.
    assert.ok(size < 100 * 1024 * 1024, `${m} under 100 MB`);
    assert.ok(size > 10 * 1024 * 1024, `${m} looks complete`);
  }
});

test("each engine's declared byte count matches its file", () => {
  const declared = [...cutout.matchAll(/bytes: (\d+)/g)].map((m) => +m[1]).sort((a, b) => a - b);
  const actual = MODELS.map((m) => readFileSync(join(root, m)).length).sort((a, b) => a - b);
  assert.deepEqual(declared, actual, "a wrong byte count makes the progress bar lie");
});

test("the 85 MB GPU engine is never pushed at phones or data savers", () => {
  // The download is spent before anything can be checked, so the gate has to
  // exist up front. These are the three signals it must consult.
  assert.match(cutout, /saveData/, "respects the browser's data-saving switch");
  assert.match(cutout, /userAgentData/, "asks the browser whether this is a phone");
  const gate = cutout.indexOf("wantsGPU");
  const use = cutout.indexOf("await wantsGPU()");
  assert.ok(gate !== -1 && use !== -1, "the gate exists and the engine choice goes through it");
});

test("the warm-up only downloads; the compile stays inside the run", () => {
  // Building a session is main-thread work. Done during warm(), it lands in
  // the second between the first mouse move and the click on a return visit,
  // which is exactly when the sample button has to answer.
  assert.match(app, /prefetchModel\(\)/, "warm() prefetches bytes");
  assert.ok(!/loadSession/.test(app), "the page never compiles outside a run");
  assert.match(cutout, /export function prefetchModel/, "the engine offers a bytes-only warm-up");
});

test("a page restored from the back-forward cache gets its buttons back", () => {
  assert.match(app, /pageshow/, "listens for the restore");
  assert.match(app, /persisted/, "only the cached restore resets, not every load");
});

test("pinch-zoom is allowed to start anywhere on the compare view", () => {
  // The 2.10.0 bug was a LATER declaration winning: a duplicate inside the
  // same block, and a media-query re-declaration for phones. So every
  // touch-action ever declared for the stage must allow pinch, in every
  // block it appears in, not just the first.
  const css = read("docs/styles.css");
  const stageBlocks = [...css.matchAll(/\.compare-stage[^,{]*\{[^}]*\}/g)];
  assert.ok(stageBlocks.length >= 1, "the stage is styled");
  let declared = 0;
  for (const block of stageBlocks) {
    for (const m of block[0].matchAll(/touch-action:\s*([^;}]+)/g)) {
      assert.equal(m[1].trim(), "pan-y pinch-zoom",
        "every stage touch-action declaration yields pinch and vertical pan");
      declared++;
    }
  }
  assert.ok(declared >= 1, "the stage declares its touch-action");
  // The divider rides on top of the stage; a pinch finger landing on it
  // must not veto the gesture either.
  const divider = css.match(/\.compare-divider\s*\{[^}]*\}/);
  assert.ok(divider && /touch-action:\s*pinch-zoom/.test(divider[0]),
    "the divider yields the pinch too");
  assert.ok(!/touch-action:\s*none/.test(divider[0]), "the divider never refuses touches outright");
});

test("while a cut runs the stage holds the photo with nothing to grab", () => {
  // The incoming photo takes the stage before the cut lands. There is no
  // cutout behind it yet, so the divider and the wipe must not be offered:
  // dragging would reveal bare checkerboard and read as a finished result.
  assert.match(app, /classList\.add\("incoming"\)/, "the incoming state exists");
  assert.match(app, /classList\.remove\("incoming"\)/, "and it is left when the result lands");
  const css = read("docs/styles.css");
  const stage = css.match(/\.compare-stage\.incoming\s*\{[^}]*\}/);
  assert.ok(stage && /pointer-events:\s*none/.test(stage[0]), "no wipe to grab mid-cut");
  assert.match(css, /\.compare-stage\.incoming \.compare-divider[^{]*\{[^}]*display:\s*none/,
    "no divider mid-cut");
});

test("the cutout is saved as WebP, with a PNG available on demand", () => {
  assert.match(cutout, /encode\(outCanvas, "image\/webp", WEBP_QUALITY\)/, "the download is WebP");
  assert.match(cutout, /asPng/, "the same pixels can still be had as a PNG");
  const q = +cutout.match(/const WEBP_QUALITY = ([\d.]+);/)[1];
  // Low enough to shrink the file, high enough that the loss stays invisible.
  assert.ok(q >= 0.85 && q <= 0.95, `WEBP_QUALITY ${q} should sit between 0.85 and 0.95`);
});

test("the gzipped model really is gzip, so the browser can unpack it", () => {
  const head = readFileSync(join(root, MODELS[0])).subarray(0, 2);
  assert.equal(head[0], 0x1f, "gzip magic byte 1");
  assert.equal(head[1], 0x8b, "gzip magic byte 2");
});

test("no development scaffolding is left in docs", () => {
  for (const f of ["docs/spike.html", "docs/spike2.html", "docs/memprobe.html", "docs/engine-test.html"]) {
    assert.ok(!existsSync(join(root, f)), `${f} should not ship`);
  }
});

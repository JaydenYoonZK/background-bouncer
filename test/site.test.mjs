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

test("the page ships no inline event handlers or scripts beyond the theme boot", () => {
  assert.ok(!/ on[a-z]+="/i.test(index), "no inline handlers");
  const inline = index.match(/<script>([\s\S]*?)<\/script>/g) || [];
  assert.equal(inline.length, 1, "exactly one inline script (the theme boot)");
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

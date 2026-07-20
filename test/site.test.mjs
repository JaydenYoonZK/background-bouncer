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

test("the model and runtime files are in place and under GitHub's limit", () => {
  for (const f of ["docs/models/isnet-int8.onnx", "docs/vendor/ort.all.min.mjs", "docs/vendor/ort-wasm-simd-threaded.jsep.wasm"]) {
    assert.ok(existsSync(join(root, f)), `${f} exists`);
  }
  const { statSync } = await_import_stat();
  function await_import_stat() { return { statSync: (p) => ({ size: readFileSync(p).length }) }; }
  const size = statSync(join(root, "docs/models/isnet-int8.onnx")).size;
  assert.ok(size < 100 * 1024 * 1024, "model under 100 MB");
  assert.ok(size > 10 * 1024 * 1024, "model looks complete");
});

test("no development scaffolding is left in docs", () => {
  for (const f of ["docs/spike.html", "docs/spike2.html", "docs/memprobe.html", "docs/engine-test.html"]) {
    assert.ok(!existsSync(join(root, f)), `${f} should not ship`);
  }
});

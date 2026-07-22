import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_SIZE, normalizeImage, boxBlur, guidedFilter,
  luminance, crispen, defringe, decontaminate, backgroundColor, refineSize, outputSize, applyAlpha,
} from "../docs/cutout-core.js";

/* ---- the reference implementations these must match ---- */

function naiveBoxBlur(src, w, h, r) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          sum += src[yy * w + xx];
          cnt++;
        }
      }
      out[y * w + x] = sum / cnt;
    }
  }
  return out;
}

function randomPlane(w, h, seed = 42) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const p = new Float32Array(w * h);
  for (let i = 0; i < p.length; i++) p[i] = rand();
  return p;
}

/* ---- box blur ---- */

test("boxBlur matches the naive reference on random data", () => {
  const w = 23, h = 17, r = 3;
  const src = randomPlane(w, h);
  const fast = boxBlur(src, w, h, r);
  const slow = naiveBoxBlur(src, w, h, r);
  for (let i = 0; i < w * h; i++) {
    assert.ok(Math.abs(fast[i] - slow[i]) < 1e-4, `pixel ${i}: ${fast[i]} vs ${slow[i]}`);
  }
});

test("boxBlur of a constant plane is that constant, corners included", () => {
  const w = 12, h = 9;
  const src = new Float32Array(w * h).fill(0.625);
  const out = boxBlur(src, w, h, 4);
  for (let i = 0; i < w * h; i++) assert.ok(Math.abs(out[i] - 0.625) < 1e-5);
});

test("boxBlur preserves the mean of the plane", () => {
  const w = 31, h = 19;
  const src = randomPlane(w, h, 7);
  const out = boxBlur(src, w, h, 2);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(Math.abs(mean([...src]) - mean([...out])) < 0.02);
});

/* ---- input normalization ---- */

test("normalizeImage lays out planar CHW with ImageNet stats", () => {
  const size = 2;
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 128, 128, 128, 255,
  ]);
  const x = normalizeImage(rgba, size);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const norm = (v, c) => (v / 255 - mean[c]) / std[c];
  assert.equal(x.length, 12);
  assert.ok(Math.abs(x[0] - norm(255, 0)) < 1e-6);      // R plane, pixel 0
  assert.ok(Math.abs(x[4 + 1] - norm(255, 1)) < 1e-6);  // G plane, pixel 1
  assert.ok(Math.abs(x[8 + 2] - norm(255, 2)) < 1e-6);  // B plane, pixel 2
  assert.ok(Math.abs(x[8 + 3] - norm(128, 2)) < 1e-6);  // B plane, pixel 3
});

/* ---- guided filter ---- */

test("guidedFilter with a flat guide reduces to a smoothing of the matte", () => {
  const w = 16, h = 16;
  const guide = new Float32Array(w * h).fill(0.5);
  const matte = randomPlane(w, h, 3);
  const q = guidedFilter(guide, matte, w, h, 2, 1e-3);
  // a flat guide has no edges, so the result must be smoother than the input
  const rough = (a) => {
    let s = 0;
    for (let i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]);
    return s;
  };
  assert.ok(rough(q) < rough(matte) * 0.6);
});

test("guidedFilter keeps a hard matte edge that coincides with a guide edge", () => {
  const w = 24, h = 8;
  const guide = new Float32Array(w * h);
  const matte = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      guide[y * w + x] = x < w / 2 ? 0.1 : 0.9;
      matte[y * w + x] = x < w / 2 ? 0 : 1;
    }
  }
  const q = guidedFilter(guide, matte, w, h, 3, 1e-4);
  const mid = 3 * w + Math.floor(w / 2);
  assert.ok(q[mid - 4] < 0.25, "left of the edge stays near 0, got " + q[mid - 4]);
  assert.ok(q[mid + 3] > 0.75, "right of the edge stays near 1, got " + q[mid + 3]);
});

test("guidedFilter output is clamped to 0..1", () => {
  const w = 10, h = 10;
  const q = guidedFilter(randomPlane(w, h, 9), randomPlane(w, h, 11), w, h, 2, 1e-4);
  for (const v of q) assert.ok(v >= 0 && v <= 1);
});

/* ---- crispen ---- */

test("crispen snaps the tails and keeps the middle soft", () => {
  const out = crispen(new Float32Array([0.01, 0.5, 0.99]), 0.35);
  assert.equal(out[0], 0);
  assert.equal(out[2], 1);
  assert.ok(out[1] > 0.4 && out[1] < 0.6);
});

test("crispen is monotonic", () => {
  const vals = new Float32Array(101);
  for (let i = 0; i <= 100; i++) vals[i] = i / 100;
  const out = crispen(vals, 0.35);
  for (let i = 1; i <= 100; i++) assert.ok(out[i] >= out[i - 1]);
});

/* ---- sizes and output ---- */

test("refineSize passes small images through and caps big ones", () => {
  assert.deepEqual(refineSize(800, 600), { w: 800, h: 600, scale: 1 });
  const r = refineSize(8000, 6000);
  assert.equal(r.w, 2048);
  assert.equal(r.h, 1536);
  assert.ok(Math.abs(r.scale - 0.256) < 1e-6);
});

test("refineSize never rounds a degenerate aspect ratio to zero", () => {
  assert.deepEqual(refineSize(8192, 1), { w: 2048, h: 1, scale: 0.25 });
  assert.deepEqual(refineSize(1, 8192), { w: 1, h: 2048, scale: 0.25 });
});

test("outputSize passes normal photos through and caps huge ones under the canvas ceiling", () => {
  // a 12MP phone photo is under the cap: returned untouched
  assert.deepEqual(outputSize(4032, 3024), { w: 4032, h: 3024, scale: 1 });
  // a 48MP photo is scaled to <= 16M pixels, aspect kept
  const r = outputSize(8000, 6000);
  assert.ok(r.w * r.h <= 16000000, `area ${r.w * r.h} must be under the ceiling`);
  assert.ok(Math.abs(r.w / r.h - 8000 / 6000) < 0.01, "aspect ratio preserved");
  // a giant square never exceeds the ceiling on either axis
  const sq = outputSize(10000, 10000);
  assert.ok(sq.w * sq.h <= 16000000 && sq.w >= 1 && sq.h >= 1);
});

test("defringe drops the faint ring but keeps solid and true-soft pixels", () => {
  const out = defringe(new Float32Array([0, 0.1, 0.3, 0.6, 1]), 0.2);
  assert.equal(out[0], 0);              // clear stays clear
  assert.equal(out[1], 0);              // below t: gone
  assert.ok(out[2] < 0.3 && out[2] > 0); // in the ramp: reduced, not killed
  assert.ok(Math.abs(out[3] - 0.6) < 1e-6); // above 2t: untouched
  assert.equal(out[4], 1);              // solid stays solid
});

test("backgroundColor averages only the removed pixels", () => {
  // two background pixels (matte 0) red+blue, one foreground (matte 1) green
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255]);
  const matte = new Float32Array([0, 0, 1]);
  const bg = backgroundColor(rgba, matte, 3);
  assert.deepEqual(bg.map(Math.round), [128, 0, 128]); // mean of red and blue
});

test("decontaminate unmixes the background color out of an edge pixel", () => {
  // an edge pixel at alpha 0.5 that is a 50/50 mix of green foreground and
  // white background should recover close to pure green.
  const F = [0, 200, 0], B = [255, 255, 255], a = 0.5;
  const mixed = F.map((f, i) => a * f + (1 - a) * B[i]);
  const rgba = new Uint8ClampedArray([...mixed, 255]);
  decontaminate(rgba, new Float32Array([a]), 1, B);
  assert.ok(Math.abs(rgba[0] - 0) < 2 && Math.abs(rgba[1] - 200) < 2 && Math.abs(rgba[2] - 0) < 2);
});

test("applyAlpha writes only the alpha channel", () => {
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
  applyAlpha(rgba, new Float32Array([0.5, 0]), 2);
  assert.deepEqual([...rgba], [10, 20, 30, 128, 40, 50, 60, 0]);
});

/* ---- luminance ---- */

test("luminance uses the Rec. 601 weights", () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  const l = luminance(rgba, 3);
  assert.ok(Math.abs(l[0] - 1) < 1e-6);
  assert.equal(l[1], 0);
  assert.ok(Math.abs(l[2] - 0.299) < 1e-6);
});

test("MODEL_SIZE matches the model's static input", () => {
  assert.equal(MODEL_SIZE, 384);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_SIZE, MODEL_SIZE_GPU, normalizeImage, boxBlur, guidedFilter,
  luminance, crispen, defringe, decontaminate, backgroundColor, refineSize, outputSize, applyAlpha,
  removeSmallIslands, subjectBounds, blendPatch, finishOutput, colorRescue, dropOrphanSoft,
  resizePlaneF, localBackgroundMap, subjectPresence,
  crc32, pngChunk, pngColorChunks, pngFilterInto, encodePng,
  buildPalette, refinePalette, makeDitherState, ditherRows, blobRescue,
} from "../docs/cutout-core.js";
import zlib from "node:zlib";

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

test("outputSize also caps the side length, or a panorama could not save as WebP", () => {
  // 20000x700 is only 14 megapixels, under the area cap, but WebP cannot
  // encode a side past 16383; the long side must come down and aspect hold.
  const p = outputSize(20000, 700);
  assert.ok(p.w <= 16383, `long side ${p.w} must fit WebP's limit`);
  assert.ok(Math.abs(p.w / p.h - 20000 / 700) < 0.5, "aspect ratio preserved");
  // and the same guard on a tall one
  const t = outputSize(700, 20000);
  assert.ok(t.h <= 16383);
});

test("defringe drops the faint ring but keeps solid and true-soft pixels", () => {
  const out = defringe(new Float32Array([0, 0.1, 0.3, 0.6, 1]), 0.2);
  assert.equal(out[0], 0);              // clear stays clear
  assert.equal(out[1], 0);              // below t: gone
  assert.ok(out[2] < 0.3 && out[2] > 0); // in the ramp: reduced, not killed
  assert.ok(Math.abs(out[3] - 0.6) < 1e-6); // above 2t: untouched
  assert.equal(out[4], 1);              // solid stays solid
});

test("removeSmallIslands drops a stray speck but keeps the subject and a second mass", () => {
  const w = 40, h = 40;
  const m = new Float32Array(w * h);
  const fill = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1; };
  fill(2, 2, 22, 22);    // subject: 400 px (the largest mass)
  fill(28, 28, 36, 36);  // a second sizeable mass: 64 px, must survive
  m[5 * w + 38] = 1;      // a lone speck: 1 px, must go
  const out = removeSmallIslands(m, w, h);
  assert.equal(out[10 * w + 10], 1, "subject kept");
  assert.equal(out[31 * w + 31], 1, "second mass kept");
  assert.equal(out[5 * w + 38], 0, "speck removed");
});

test("removeSmallIslands is a no-op on a single connected mass", () => {
  const w = 10, h = 10;
  const m = new Float32Array(w * h).fill(1);
  const out = removeSmallIslands(m, w, h);
  for (let i = 0; i < m.length; i++) assert.equal(out[i], 1);
});

test("subjectBounds finds the kept region and reports nothing when empty", () => {
  const w = 20, h = 20;
  const m = new Float32Array(w * h);
  for (let y = 6; y <= 11; y++) for (let x = 4; x <= 9; x++) m[y * w + x] = 1;
  assert.deepEqual(subjectBounds(m, w, h), { x0: 4, y0: 6, x1: 9, y1: 11 });
  assert.equal(subjectBounds(new Float32Array(w * h), w, h), null);
});

test("blendPatch replaces the middle of the region and fades at an inside edge", () => {
  const bw = 20, bh = 20;
  const base = new Float32Array(bw * bh).fill(0);
  const pw = 8, ph = 8;
  const patch = new Float32Array(pw * ph).fill(1);
  blendPatch(base, bw, bh, patch, 6, 6, pw, ph, 3);
  // dead centre of the patch takes the new value outright
  assert.ok(base[(6 + 4) * bw + (6 + 4)] > 0.95, "centre replaced");
  // the outermost row of the patch is an inside edge, so it barely counts
  assert.ok(base[6 * bw + 6] < 0.2, "edge faded");
  // nothing outside the region moved
  assert.equal(base[2 * bw + 2], 0);
});

test("blendPatch keeps a frame-flush edge hard, since there is nothing to blend into", () => {
  const bw = 10, bh = 10;
  const base = new Float32Array(bw * bh).fill(0);
  const patch = new Float32Array(bw * 4).fill(1);
  blendPatch(base, bw, bh, patch, 0, 0, bw, 4, 2);
  assert.ok(base[0] > 0.95, "top-left corner is flush with the frame, so it takes the patch fully");
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

test("colorRescue removes a background-coloured sliver but not the subject or distant regions", () => {
  const w = 64, h = 64, n = w * h;
  // left half: green subject (alpha 1). right half: brown background (alpha 0).
  // a brown sliver just inside the subject edge is wrongly kept at alpha 1.
  const rgba = new Uint8ClampedArray(n * 4);
  const matte = new Float32Array(n);
  const paint = (x, y, rgb, a) => {
    const i = y * w + x;
    rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
    matte[i] = a;
  };
  const GREEN = [40, 170, 80], BROWN = [110, 70, 30];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < 32) paint(x, y, GREEN, 1);
    else paint(x, y, BROWN, 0);
  }
  // the wrongly-kept sliver: brown pixels at x 29..31, alpha 1
  for (let y = 8; y < 56; y++) for (let x = 29; x < 32; x++) paint(x, y, BROWN, 1);
  const out = colorRescue(rgba, matte, w, h, 6, 8);
  assert.ok(out[30 * w + 30] < 0.15, "brown sliver near the edge comes down, got " + out[30 * w + 30]);
  assert.equal(out[30 * w + 8], 1, "green interior stays solid");
  assert.equal(out[30 * w + 60], 0, "background stays clear");
});

test("colorRescue leaves everything alone without confident background to learn from", () => {
  const w = 16, h = 16, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4).fill(120);
  const matte = new Float32Array(n).fill(0.8); // nothing below 0.05 anywhere
  const out = colorRescue(rgba, matte, w, h, 4, 4);
  for (let i = 0; i < n; i++) assert.equal(out[i], matte[i]);
});

test("colorRescue leaves a confident sunlit rim alone even when it matches the bright background", () => {
  const w = 64, h = 64, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  const matte = new Float32Array(n);
  const paint = (x, y, rgb, a) => {
    const i = y * w + x;
    rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
    matte[i] = a;
  };
  const GREEN = [40, 170, 80], WHITE = [246, 244, 240];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < 29) paint(x, y, GREEN, 1);       // subject
    else if (x < 32) paint(x, y, WHITE, 1);  // its sunlit rim, model-confident
    else paint(x, y, WHITE, 0);              // bright background, same colour
  }
  const out = colorRescue(rgba, matte, w, h, 6, 8);
  assert.equal(out[30 * w + 30], 1, "the lit rim survives");
  assert.equal(out[30 * w + 40], 0, "the background stays clear");
});

test("colorRescue never raises alpha", () => {
  const w = 32, h = 32, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = (i * 37) % 255; rgba[i * 4 + 1] = (i * 73) % 255; rgba[i * 4 + 2] = (i * 11) % 255; rgba[i * 4 + 3] = 255;
  }
  const matte = randomPlane(w, h, 5);
  const out = colorRescue(rgba, matte, w, h, 4, 6);
  for (let i = 0; i < n; i++) assert.ok(out[i] <= matte[i] + 1e-9, "alpha can only come down");
});

test("dropOrphanSoft removes floating wisps but keeps soft detail attached to the subject", () => {
  const w = 32, h = 32, n = w * h;
  const m = new Float32Array(n);
  // a solid block with a genuine soft edge hanging off it
  for (let y = 10; y < 22; y++) for (let x = 4; x < 16; x++) m[y * w + x] = 1;
  for (let y = 10; y < 22; y++) m[y * w + 16] = 0.3; // attached soft edge
  m[5 * w + 26] = 0.4; // an orphan wisp far from anything solid
  const out = dropOrphanSoft(m, w, h, 3);
  assert.equal(out[15 * w + 16], Math.fround(0.3), "soft edge on the subject survives");
  assert.equal(out[5 * w + 26], 0, "the floating wisp goes");
  assert.equal(out[15 * w + 10], 1, "solid interior untouched");
});

test("crc32 and pngChunk match the PNG specification", () => {
  // The IEND chunk's CRC is a published constant: 0xAE426082.
  assert.equal(crc32(new Uint8Array([73, 69, 78, 68])), 0xae426082);
  const chunk = pngChunk("IEND", new Uint8Array(0));
  assert.deepEqual([...chunk], [0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82]);
});

test("pngColorChunks keeps profile chunks verbatim and nothing else", () => {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk("IHDR", new Uint8Array(13));
  const srgb = pngChunk("sRGB", new Uint8Array([0]));
  const time = pngChunk("tIME", new Uint8Array(7));
  const idat = pngChunk("IDAT", new Uint8Array([1, 2, 3]));
  const png = new Uint8Array([...sig, ...ihdr, ...srgb, ...time, ...idat, ...pngChunk("IEND", new Uint8Array(0))]);
  const kept = pngColorChunks(png);
  assert.equal(kept.length, 1);
  assert.deepEqual([...kept[0]], [...srgb]);
});

test("encodePng roundtrips pixels exactly through a real inflate", async () => {
  const w = 23, h = 17;
  const rgba = new Uint8ClampedArray(w * h * 4);
  let s = 5;
  for (let i = 0; i < rgba.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rgba[i] = s & 255; }
  const png = await encodePng(rgba, w, h, { yieldEvery: 4 });
  // signature and IHDR
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer, png.byteOffset);
  assert.equal(dv.getUint32(16), w);
  assert.equal(dv.getUint32(20), h);
  // find IDAT, inflate, reverse the per-row filters
  let p = 8, idat = null;
  while (p + 12 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === "IDAT") idat = png.slice(p + 8, p + 8 + len);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(idat);
  const stride = w * 4;
  const out = new Uint8Array(w * h * 4);
  const paeth = (a, b, c) => {
    const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const left = i >= 4 ? out[y * stride + i - 4] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const ul = y > 0 && i >= 4 ? out[(y - 1) * stride + i - 4] : 0;
      const add = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, ul);
      out[y * stride + i] = (v + add) & 255;
    }
  }
  assert.deepEqual([...out], [...rgba], "decoded pixels match the input exactly");
});

test("buildPalette finds the colours a picture is actually made of", () => {
  // four flat quadrants: the palette must contain all four, near-exactly
  const w = 32, h = 32, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  const colors = [[220, 40, 40, 255], [40, 200, 60, 255], [50, 60, 230, 255], [0, 0, 0, 0]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = colors[(y < 16 ? 0 : 2) + (x < 16 ? 0 : 1)];
    const i = (y * w + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3];
  }
  const pal = buildPalette(rgba, n, 8);
  assert.ok(pal.length / 4 <= 8);
  for (const c of colors) {
    let best = Infinity;
    for (let p = 0; p < pal.length / 4; p++) {
      const d = Math.abs(pal[p * 4] - c[0]) + Math.abs(pal[p * 4 + 1] - c[1]) + Math.abs(pal[p * 4 + 2] - c[2]) + Math.abs(pal[p * 4 + 3] - c[3]);
      if (d < best) best = d;
    }
    assert.ok(best <= 8, `palette reaches ${c}, off by ${best}`);
  }
});

test("refinePalette moves the palette closer to the picture, never further", () => {
  const w = 48, h = 32, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  let s = 21;
  for (let i = 0; i < rgba.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rgba[i] = s & 255; }
  const err = (pal) => {
    let e = 0;
    for (let i = 0; i < n; i++) {
      let bd = Infinity;
      for (let p = 0; p < pal.length / 4; p++) {
        const dr = rgba[i*4]-pal[p*4], dg = rgba[i*4+1]-pal[p*4+1], db = rgba[i*4+2]-pal[p*4+2], da = rgba[i*4+3]-pal[p*4+3];
        const d = dr*dr + dg*dg + db*db + 2*da*da;
        if (d < bd) bd = d;
      }
      e += bd;
    }
    return e / n;
  };
  const pal = buildPalette(rgba, n, 32);
  const before = err(pal);
  const refined = refinePalette(rgba, n, new Uint8Array(pal), 3);
  const after = err(refined);
  assert.ok(after <= before + 1e-6, `refinement does not regress: ${after.toFixed(1)} vs ${before.toFixed(1)}`);
  assert.equal(refined.length, pal.length, "palette size unchanged");
});

test("ditherRows stays honest: valid indices, small mean error, flat stays flat", () => {
  const w = 40, h = 24, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  let s = 11;
  for (let i = 0; i < rgba.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rgba[i] = s & 255; }
  const pal = buildPalette(rgba, n, 64);
  const idx = new Uint8Array(n);
  const st = makeDitherState(w, pal);
  ditherRows(rgba, w, 0, h, idx, st);
  let err = 0;
  for (let i = 0; i < n; i++) {
    assert.ok(idx[i] < pal.length / 4, "index in range");
    err += Math.abs(pal[idx[i] * 4] - rgba[i * 4]) + Math.abs(pal[idx[i] * 4 + 1] - rgba[i * 4 + 1]) + Math.abs(pal[idx[i] * 4 + 2] - rgba[i * 4 + 2]);
  }
  assert.ok(err / n < 220, "per-pixel colour error stays bounded on noise, got " + (err / n).toFixed(1));
  // a flat image quantizes to one index everywhere, no dither noise invented
  const flat = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { flat[i * 4] = 90; flat[i * 4 + 1] = 120; flat[i * 4 + 2] = 30; flat[i * 4 + 3] = 255; }
  const palF = buildPalette(flat, n, 16);
  const idxF = new Uint8Array(n);
  ditherRows(flat, w, 0, h, idxF, makeDitherState(w, palF));
  assert.ok(new Set(idxF).size === 1, "flat colour uses one palette entry");
});

test("indexed encodePng roundtrips indices and palette exactly", async () => {
  const w = 21, h = 13, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  let s = 3;
  for (let i = 0; i < rgba.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rgba[i] = s & 255; }
  const pal = buildPalette(rgba, n, 32);
  const idx = new Uint8Array(n);
  ditherRows(rgba, w, 0, h, idx, makeDitherState(w, pal));
  const png = await encodePng(idx, w, h, { indexed: { palette: pal } });
  const dv = new DataView(png.buffer, png.byteOffset);
  assert.equal(png[8 + 8 + 9], 3, "colour type is palette");
  // walk chunks: PLTE and tRNS must sit before IDAT and match the palette
  let p = 8, plte = null, trns = null, idat = null;
  while (p + 12 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === "PLTE") plte = png.slice(p + 8, p + 8 + len);
    if (type === "tRNS") trns = png.slice(p + 8, p + 8 + len);
    if (type === "IDAT") { assert.ok(plte && trns, "PLTE and tRNS precede IDAT"); idat = png.slice(p + 8, p + 8 + len); }
    p += 12 + len;
  }
  const count = pal.length / 4;
  assert.equal(plte.length, count * 3);
  assert.equal(trns.length, count);
  for (let i = 0; i < count; i++) {
    assert.equal(plte[i * 3], pal[i * 4]);
    assert.equal(trns[i], pal[i * 4 + 3]);
  }
  // inflate and unfilter at one byte per pixel: indices come back exactly
  const raw = zlib.inflateSync(idat);
  const out = new Uint8Array(n);
  const paeth = (a, b, c) => {
    const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)];
    for (let i = 0; i < w; i++) {
      const v = raw[y * (w + 1) + 1 + i];
      const left = i >= 1 ? out[y * w + i - 1] : 0;
      const up = y > 0 ? out[(y - 1) * w + i] : 0;
      const ul = y > 0 && i >= 1 ? out[(y - 1) * w + i - 1] : 0;
      const add = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, ul);
      out[y * w + i] = (v + add) & 255;
    }
  }
  assert.deepEqual([...out], [...idx], "decoded indices match exactly");
});

test("blobRescue removes a wedged background chunk, keeps accessories and bulk", () => {
  const w = 240, h = 120, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  const matte = new Float32Array(n);
  const put = (x, y, c, a) => {
    const i = (y * w + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    matte[y * w + x] = a;
  };
  const NAVY = [30, 40, 90], RED = [230, 60, 60], GREY = [120, 120, 120];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < 100) put(x, y, NAVY, 1);            // the subject: kept, huge
    else if (x < 170) put(x, y, RED, 0);        // red background, removed
    else put(x, y, GREY, 0);                    // grey background, removed
  }
  // a red chunk the model kept, wedged on the subject's edge, red like the
  // background right next to it: must come out
  for (let y = 40; y < 60; y++) for (let x = 100; x < 118; x++) put(x, y, RED, 1);
  // a red accessory on the subject's edge where the adjacent background is
  // GREY: red matches neither grey background nor navy subject, so the
  // clear-evidence rule must leave it alone
  for (let y = 40; y < 60; y++) for (let x = 82; x < 100; x++) put(x + 88, y + 45, RED, 0); // keep coords simple below
  for (let y = 95; y < 112; y++) for (let x = 170; x < 184; x++) put(x, y, RED, 1);
  // a thin ribbon along the subject's silhouette, coloured like the
  // background because lighting washed it out: a rim, not a crumb, and it
  // must survive even though its colour alone would condemn it
  for (let y = 70; y < 116; y++) for (let x = 100; x < 103; x++) put(x, y, RED, 1);
  const out = blobRescue(rgba, matte, w, h);
  assert.equal(out[50 * w + 108], 0, "the wedged background-coloured chunk is removed");
  assert.equal(out[100 * w + 176], 1, "the accessory unlike its own local background stays");
  assert.equal(out[50 * w + 50], 1, "the subject's bulk is never touched");
  assert.equal(out[90 * w + 101], 1, "a washed-out rim along the silhouette is never taken");
});

test("subjectPresence reads how much of the frame the matte keeps", () => {
  const n = 100;
  assert.equal(subjectPresence(new Float32Array(n), n), 0);
  assert.equal(subjectPresence(new Float32Array(n).fill(1), n), 1);
  const half = new Float32Array(n);
  for (let i = 0; i < 50; i++) half[i] = 0.8;
  assert.equal(subjectPresence(half, n), 0.5);
  // soft pixels below half confidence do not count as kept subject
  assert.equal(subjectPresence(new Float32Array(n).fill(0.3), n), 0);
});

test("resizePlaneF keeps constants, linear ramps, and identity exact", () => {
  // identity
  const src = randomPlane(8, 6, 3);
  assert.deepEqual([...resizePlaneF(src, 8, 6, 8, 6)], [...src]);
  // a constant plane stays that constant at any size
  const flat = new Float32Array(5 * 4).fill(0.37);
  for (const v of resizePlaneF(flat, 5, 4, 13, 9)) assert.ok(Math.abs(v - 0.37) < 1e-6);
  // a horizontal linear ramp resamples to a linear ramp (bilinear is exact on planes)
  const w = 16, h = 4;
  const ramp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ramp[y * w + x] = x / (w - 1);
  const up = resizePlaneF(ramp, w, h, 31, 4);
  for (let x = 1; x < 30; x++) {
    const d1 = up[1 * 31 + x] - up[1 * 31 + x - 1];
    assert.ok(d1 >= -1e-6, "ramp stays monotone");
  }
  // and, unlike the old canvas route, no 8-bit stepping: values between the
  // 1/255 quantization levels survive
  const fine = new Float32Array([0.5, 0.5 + 1 / 1024]);
  const mid = resizePlaneF(fine, 2, 1, 3, 1)[1];
  assert.ok(mid > 0.5 && mid < 0.5 + 1 / 1024, "sub-8-bit precision preserved, got " + mid);
});

test("localBackgroundMap learns each side's own background colour", () => {
  const w = 60, h = 20, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  const matte = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let c, a;
    if (x < 20) { c = [30, 20, 10]; a = 0; }        // dark wood, removed
    else if (x < 40) { c = [40, 170, 80]; a = 1; }  // green subject
    else { c = [240, 240, 235]; a = 0; }            // bright mist, removed
    rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255;
    matte[i] = a;
  }
  const map = localBackgroundMap(rgba, matte, w, h, 6);
  const left = 10 * w + 21, right = 10 * w + 38;
  assert.ok(map.ok[left] > 0.5 && map.ok[right] > 0.5, "both edges have an estimate");
  assert.ok(map.r[left] < 100, "left edge learned the dark side, r=" + map.r[left]);
  assert.ok(map.r[right] > 150, "right edge learned the bright side, r=" + map.r[right]);
});

test("finishOutput uses the local background where the map reaches", () => {
  // one half-transparent pixel mixed over a dark local background, while the
  // global mean is bright: only the local number un-mixes it correctly.
  const F = [0, 200, 0], Blocal = [20, 10, 5], a = 0.5;
  const mixed = F.map((f, i) => a * f + (1 - a) * Blocal[i]);
  const rgba = new Uint8ClampedArray([...mixed, 255]);
  const map = { r: new Float32Array([Blocal[0]]), g: new Float32Array([Blocal[1]]), b: new Float32Array([Blocal[2]]), ok: new Float32Array([1]) };
  finishOutput(rgba, new Float32Array([a]), 1, [240, 240, 240], map);
  assert.ok(Math.abs(rgba[1] - 200) < 2, "unmixed against the local background, g=" + rgba[1]);
});

test("finishOutput equals decontaminate followed by applyAlpha, pixel for pixel", () => {
  const n = 512;
  const seed = randomPlane(n, 1, 21);
  const matte = randomPlane(n, 1, 22);
  const bg = [180, 40, 220];
  const a = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = Math.floor(seed[i % seed.length] * 255);
  const b = a.slice();
  decontaminate(a, matte, n, bg);
  applyAlpha(a, matte, n);
  finishOutput(b, matte, n, bg);
  assert.deepEqual([...b], [...a]);
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
  assert.equal(MODEL_SIZE_GPU, 1024);
});

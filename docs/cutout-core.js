/*! Background Bouncer | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-bouncer */

// The pure math of the pipeline: everything here works on plain typed arrays
// so it runs and tests the same in Node and in the browser. The model I/O
// lives in cutout.js.

// The canvas each engine reads. The CPU model is squeezed to 384 so a
// single-threaded browser finishes in a few seconds; a GPU runs the model at
// the 1024 it was trained on, which is where fine detail like single hairs
// survives instead of being averaged away.
export const MODEL_SIZE = 384;
export const MODEL_SIZE_GPU = 1024;

// BiRefNet reads ImageNet-normalized RGB. Per-channel: (v/255 - mean) / std.
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

// The model was trained on squashed square inputs (the reference pipeline
// resizes without preserving aspect), so the tool does the same and the
// matte is stretched back over the original frame afterwards. The three
// channels are laid out planar (all R, then all G, then all B) as the net
// expects, each centered and scaled by the ImageNet statistics.
export function normalizeImage(rgba, size) {
  const plane = size * size;
  const x = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    x[i] = (rgba[i * 4] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    x[plane + i] = (rgba[i * 4 + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    x[2 * plane + i] = (rgba[i * 4 + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return x;
}

// O(n) box blur: running-sum rows then columns, edge-clamped so borders
// average only real pixels instead of fading toward zero.
export function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * r + 1);
      const add = Math.min(w - 1, x + r + 1);
      const drop = Math.max(0, x - r);
      sum += src[row + add] - src[row + drop];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      const add = Math.min(h - 1, y + r + 1);
      const drop = Math.max(0, y - r);
      sum += tmp[add * w + x] - tmp[drop * w + x];
    }
  }
  return out;
}

// He et al.'s guided filter: snaps the model's soft matte onto the real
// luminance edges of the photo, which is where hair and fur live.
export function guidedFilter(guide, matte, w, h, r, eps) {
  const n = w * h;
  const Ip = new Float32Array(n);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Ip[i] = guide[i] * matte[i];
    II[i] = guide[i] * guide[i];
  }
  const meanI = boxBlur(guide, w, h, r);
  const meanP = boxBlur(matte, w, h, r);
  const corrIp = boxBlur(Ip, w, h, r);
  const corrII = boxBlur(II, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = corrII[i] - meanI[i] * meanI[i];
    const covIp = corrIp[i] - meanI[i] * meanP[i];
    a[i] = covIp / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxBlur(a, w, h, r);
  const meanB = boxBlur(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = meanA[i] * guide[i] + meanB[i];
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return q;
}

export function luminance(rgba, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  }
  return out;
}

// A gentle S-curve on the refined matte: fully keeps the soft fringe but
// pushes near-certain pixels to certain, so flat areas do not shimmer at
// 97% opacity. k = 0 is identity.
export function crispen(m, k) {
  const out = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const v = m[i];
    const s = v * v * (3 - 2 * v); // smoothstep
    const c = v + k * (s - v);
    // Snap the near-certain tails so solid areas are truly solid and clear
    // areas truly clear; only the genuine fringe keeps fractional alpha.
    out[i] = c >= 0.98 ? 1 : c <= 0.02 ? 0 : c;
  }
  return out;
}

// Trim the faint outer ring where a light background bled into the edge pixels
// and left a pale halo. It multiplies alpha by a ramp that is 0 below t and 1
// above 2t, so the barely-there fringe drops to nothing while the solid subject
// and genuine soft edges (anything already past the ramp) are untouched.
export function defringe(m, t) {
  const out = new Float32Array(m.length);
  const lo = t, hi = 2 * t, span = hi - lo || 1;
  for (let i = 0; i < m.length; i++) {
    const v = m[i];
    const g = v <= lo ? 0 : v >= hi ? 1 : (v - lo) / span;
    out[i] = v * (g * g * (3 - 2 * g)); // smoothstep gate
  }
  return out;
}

// Drop tiny isolated islands the model sometimes leaves in the background: a
// stray fleck of a bright object, a speck of sensor noise. Only components far
// smaller than the subject are removed (under 0.1% of the frame AND under 2%
// of the largest mass), so a second person, a held object, or a detached hand
// is always kept. It runs on the small model matte, so it costs almost nothing.
export function removeSmallIslands(m, w, h, thresh = 0.5) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes = [];
  for (let s = 0; s < n; s++) {
    if (m[s] < thresh || label[s] !== -1) continue;
    const comp = sizes.length;
    let sp = 0, area = 0;
    stack[sp++] = s; label[s] = comp;
    while (sp > 0) {
      const p = stack[--sp]; area++;
      const y = (p / w) | 0, x = p - y * w;
      if (x > 0     && m[p - 1] >= thresh && label[p - 1] === -1) { label[p - 1] = comp; stack[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] >= thresh && label[p + 1] === -1) { label[p + 1] = comp; stack[sp++] = p + 1; }
      if (y > 0     && m[p - w] >= thresh && label[p - w] === -1) { label[p - w] = comp; stack[sp++] = p - w; }
      if (y < h - 1 && m[p + w] >= thresh && label[p + w] === -1) { label[p + w] = comp; stack[sp++] = p + w; }
    }
    sizes.push(area);
  }
  if (sizes.length <= 1) return m;
  let largest = 0;
  for (const a of sizes) if (a > largest) largest = a;
  const absMin = 0.001 * n, relMin = 0.02 * largest;
  const out = m.slice();
  for (let p = 0; p < n; p++) {
    const c = label[p];
    if (c !== -1 && sizes[c] < absMin && sizes[c] < relMin) out[p] = 0;
  }
  return out;
}

// ---- PNG encoding ----
// The browser's canvas encoder settles for one filter strategy; choosing the
// best predictor per row before the same deflate measures 12% smaller on the
// sample cutout and 17% on a 16-megapixel one. The filtering and the file
// assembly are pure math and live here; the deflate itself is the platform's
// CompressionStream, which browsers and Node both provide.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Filter rows yStart..yEnd (exclusive) of straight RGBA into `out`, picking
// per row whichever of the five PNG predictors leaves the least to compress.
export function pngFilterInto(rgba, w, h, yStart, yEnd, out) {
  const stride = w * 4;
  const rowBuf = [
    new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride),
    new Uint8Array(stride), new Uint8Array(stride),
  ];
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = yStart; y < yEnd; y++) {
    const row = y * stride, prev = (y - 1) * stride;
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const v = rgba[row + i];
      const left = i >= 4 ? rgba[row + i - 4] : 0;
      const up = y > 0 ? rgba[prev + i] : 0;
      const ul = y > 0 && i >= 4 ? rgba[prev + i - 4] : 0;
      const c0 = v;
      const c1 = (v - left) & 255;
      const c2 = (v - up) & 255;
      const c3 = (v - ((left + up) >> 1)) & 255;
      const c4 = (v - paeth(left, up, ul)) & 255;
      rowBuf[0][i] = c0; rowBuf[1][i] = c1; rowBuf[2][i] = c2; rowBuf[3][i] = c3; rowBuf[4][i] = c4;
      sums[0] += c0 < 128 ? c0 : 256 - c0;
      sums[1] += c1 < 128 ? c1 : 256 - c1;
      sums[2] += c2 < 128 ? c2 : 256 - c2;
      sums[3] += c3 < 128 ? c3 : 256 - c3;
      sums[4] += c4 < 128 ? c4 : 256 - c4;
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    out[y * (stride + 1)] = best;
    out.set(rowBuf[best], y * (stride + 1) + 1);
  }
}

export function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// The colour chunks of an existing PNG, verbatim, so a custom-encoded file
// can carry exactly the profile the browser would have written for the same
// canvas instead of a hand-built one.
export function pngColorChunks(png) {
  const KEEP = new Set(["iCCP", "cICP", "sRGB", "gAMA", "cHRM"]);
  const out = [];
  let p = 8;
  while (p + 12 <= png.length) {
    const len = ((png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3]) >>> 0;
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (KEEP.has(type)) out.push(png.slice(p, p + 12 + len));
    if (type === "IDAT" || type === "IEND") break;
    p += 12 + len;
  }
  return out;
}

// A complete 8-bit RGBA PNG. yieldEvery > 0 hands the main thread back every
// that many rows, so a 16-megapixel encode cannot freeze an animation.
export async function encodePng(rgba, w, h, { colorChunks = [], yieldEvery = 0 } = {}) {
  const stride = w * 4;
  const filtered = new Uint8Array(h * (stride + 1));
  const step = yieldEvery > 0 ? yieldEvery : h;
  for (let y0 = 0; y0 < h; y0 += step) {
    pngFilterInto(rgba, w, h, y0, Math.min(h, y0 + step), filtered);
    if (yieldEvery > 0 && y0 + step < h) await new Promise((r) => setTimeout(r, 0));
  }
  const idat = new Uint8Array(await new Response(
    new Blob([filtered]).stream().pipeThrough(new CompressionStream("deflate"))
  ).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    ...colorChunks,
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// How much of the frame the matte actually keeps. The engine reads this to
// tell an empty or indiscriminate matte, a photo with no clear subject in
// it, from a real cut.
export function subjectPresence(m, n) {
  let kept = 0;
  for (let i = 0; i < n; i++) if (m[i] >= 0.5) kept++;
  return kept / n;
}

// The box the kept subject occupies, in matte pixels, or null if the model
// kept nothing. Used to decide whether a second, closer look is worth taking.
export function subjectBounds(m, w, h, thresh = 0.5) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (m[row + x] >= thresh) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// Lay a second, sharper matte over the region it was measured from. Any edge
// of that region sitting inside the frame fades across `feather` pixels, so
// the close-up matte and the whole-frame one meet without a visible seam; an
// edge flush with the frame border has nothing to blend into and stays hard.
export function blendPatch(base, bw, bh, patch, px, py, pw, ph, feather) {
  for (let y = 0; y < ph; y++) {
    const by = py + y;
    if (by < 0 || by >= bh) continue;
    for (let x = 0; x < pw; x++) {
      const bx = px + x;
      if (bx < 0 || bx >= bw) continue;
      let k = 1;
      if (feather > 0) {
        const d = Math.min(
          px <= 0 ? feather : x,
          py <= 0 ? feather : y,
          px + pw >= bw ? feather : pw - 1 - x,
          py + ph >= bh ? feather : ph - 1 - y
        );
        k = d >= feather ? 1 : d / feather;
        k = k * k * (3 - 2 * k); // smoothstep, so the handover has no edge
      }
      const i = by * bw + bx;
      base[i] = base[i] * (1 - k) + patch[y * pw + x] * k;
    }
  }
  return base;
}

// The model sometimes keeps a sliver of background that touches the subject,
// a strip of dark bench along a sleeve, a shadow hugging a waist, solid
// enough that no edge filter can question it. This pass can: near the matte's
// own boundary it compares each pixel to the local colours of the confident
// subject and the confident background, and where a kept pixel plainly
// matches the background and plainly does not match the subject, its alpha
// comes down. Evidence only ever lowers alpha, so nothing is invented, and a
// pixel that resembles the subject at all is left alone, which is what keeps
// fabric edges from being chewed.
export function colorRescue(rgba, matte, w, h, rBand = 14, rEst = 24) {
  const n = w * h;
  const wF = new Float32Array(n);
  const wB = new Float32Array(n);
  const hard = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = matte[i];
    if (a > 0.95) wF[i] = 1;
    else if (a < 0.05) wB[i] = 1;
    if (a > 0.5) hard[i] = 1;
  }
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    planes[0][i] = rgba[i * 4] / 255;
    planes[1][i] = rgba[i * 4 + 1] / 255;
    planes[2][i] = rgba[i * 4 + 2] / 255;
  }
  // Local mean colour of a confident set, with a wider second look filling
  // the spots the first radius could not reach.
  const est = (wgt) => {
    const d1 = boxBlur(wgt, w, h, rEst);
    const d2 = boxBlur(wgt, w, h, rEst * 3);
    const c1 = planes.map((p) => {
      const t = new Float32Array(n);
      for (let i = 0; i < n; i++) t[i] = p[i] * wgt[i];
      return boxBlur(t, w, h, rEst);
    });
    const c2 = planes.map((p) => {
      const t = new Float32Array(n);
      for (let i = 0; i < n; i++) t[i] = p[i] * wgt[i];
      return boxBlur(t, w, h, rEst * 3);
    });
    return { d1, d2, c1, c2 };
  };
  const F = est(wF);
  const B = est(wB);
  const bb = boxBlur(hard, w, h, rBand);
  const out = new Float32Array(matte);
  for (let i = 0; i < n; i++) {
    if (bb[i] <= 0.02 || bb[i] >= 0.98) continue;
    let fD, f0, f1, f2, bD, b0, b1, b2;
    if (F.d1[i] > 1e-3) { fD = F.d1[i]; f0 = F.c1[0][i]; f1 = F.c1[1][i]; f2 = F.c1[2][i]; }
    else if (F.d2[i] > 1e-3) { fD = F.d2[i]; f0 = F.c2[0][i]; f1 = F.c2[1][i]; f2 = F.c2[2][i]; }
    else continue;
    if (B.d1[i] > 1e-3) { bD = B.d1[i]; b0 = B.c1[0][i]; b1 = B.c1[1][i]; b2 = B.c1[2][i]; }
    else if (B.d2[i] > 1e-3) { bD = B.d2[i]; b0 = B.c2[0][i]; b1 = B.c2[1][i]; b2 = B.c2[2][i]; }
    else continue;
    const r = planes[0][i], g = planes[1][i], bl = planes[2][i];
    // A sunlit rim on the subject is near-white and colourless, exactly like
    // a bright misty background, and the model was sure about it. Removing it
    // cuts a bite out of a lit shoulder, so a confident bright colourless
    // pixel is not for this pass to judge.
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
    if (matte[i] >= 0.9 && mn > 0.72 && mx - mn < 0.12) continue;
    const dF = Math.hypot(r - f0 / fD, g - f1 / fD, bl - f2 / fD);
    const dB = Math.hypot(r - b0 / bD, g - b1 / bD, bl - b2 / bD);
    if (dB >= 0.35) continue;
    let s = (dF - 2 * dB) / 0.15;
    if (s <= 0) continue;
    if (s > 1) s = 1;
    s = s * s * (3 - 2 * s);
    out[i] = matte[i] * (1 - s);
  }
  return out;
}

// Bilinear resize of a float plane, in float. The old path went through a
// canvas, which meant rounding the matte to 8 bits on every hop; a soft hair
// gradient was stepped twice before it ever reached the output. This keeps
// the full precision end to end. Sampling matches what a canvas would do:
// pixel centres, edges clamped.
export function resizePlaneF(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return new Float32Array(src);
  const out = new Float32Array(dw * dh);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    let sy = (y + 0.5) * yr - 0.5;
    if (sy < 0) sy = 0; else if (sy > sh - 1) sy = sh - 1;
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    const r0 = y0 * sw, r1 = y1 * sw, ro = y * dw;
    for (let x = 0; x < dw; x++) {
      let sx = (x + 0.5) * xr - 0.5;
      if (sx < 0) sx = 0; else if (sx > sw - 1) sx = sw - 1;
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * fx;
      const bot = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * fx;
      out[ro + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

// The local colour of the removed background, per pixel: what was actually
// behind each part of the subject. The global mean cannot un-mix an edge that
// sits over dark wood and an edge that sits over bright mist with the same
// number; this map can. Same two-radius fill as the rescue pass: a wider
// second look covers the spots the first radius cannot reach.
export function localBackgroundMap(rgba, matte, w, h, rEst = 24) {
  const n = w * h;
  const wB = new Float32Array(n);
  for (let i = 0; i < n; i++) if (matte[i] < 0.05) wB[i] = 1;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    ch[0][i] = rgba[i * 4] * wB[i];
    ch[1][i] = rgba[i * 4 + 1] * wB[i];
    ch[2][i] = rgba[i * 4 + 2] * wB[i];
  }
  const d1 = boxBlur(wB, w, h, rEst);
  const d2 = boxBlur(wB, w, h, rEst * 3);
  const c1 = ch.map((p) => boxBlur(p, w, h, rEst));
  const c2 = ch.map((p) => boxBlur(p, w, h, rEst * 3));
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  const ok = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (d1[i] > 1e-3) {
      r[i] = c1[0][i] / d1[i]; g[i] = c1[1][i] / d1[i]; b[i] = c1[2][i] / d1[i]; ok[i] = 1;
    } else if (d2[i] > 1e-3) {
      r[i] = c2[0][i] / d2[i]; g[i] = c2[1][i] / d2[i]; b[i] = c2[2][i] / d2[i]; ok[i] = 1;
    }
  }
  return { r, g, b, ok };
}

// Soft pixels that touch no solid region are leftovers: the faint ring of a
// removed fleck, a stray wisp of half-alpha noise floating in the clear. Real
// soft detail, hair, fur, a genuine edge, always grows out of something
// solid; anything that does not is dropped.
export function dropOrphanSoft(m, w, h, r = 3) {
  const n = w * h;
  const hard = new Float32Array(n);
  for (let i = 0; i < n; i++) if (m[i] >= 0.5) hard[i] = 1;
  const near = boxBlur(hard, w, h, r);
  const out = new Float32Array(m);
  for (let i = 0; i < n; i++) {
    if (out[i] > 0 && out[i] < 0.5 && near[i] <= 1e-6) out[i] = 0;
  }
  return out;
}

// The working size for the refinement pass: big enough that hair detail
// survives, capped so an 8K photo cannot stall the page.
export function refineSize(w, h, cap = 2048) {
  const long = Math.max(w, h);
  if (long <= cap) return { w, h, scale: 1 };
  const scale = cap / long;
  // A near-1px short side would round to 0 and crash the canvas pass, so the
  // rounded dimensions never drop below 1.
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

// The size of the returned PNG. A phone camera shoots 12 to 48 megapixels, and
// a canvas past roughly 16.7M pixels blows through iOS Safari's ceiling: the
// canvas comes back blank and the export fails, or a low-memory tab crashes.
// So the output area is bounded while the aspect ratio is kept. The common case
// (a 12MP photo, ~12.2M pixels) is under the cap and passes through untouched;
// only very large images are scaled down, which is invisible for web use.
export function outputSize(w, h, maxArea = 16000000, maxSide = 16383) {
  // Two ceilings: total area for the canvas memory a mobile browser will
  // give, and side length because WebP cannot encode a dimension past 16383,
  // so a long panorama under the area cap could still fail to save.
  let scale = 1;
  if (w * h > maxArea) scale = Math.sqrt(maxArea / (w * h));
  const side = Math.max(w, h) * scale;
  if (side > maxSide) scale *= maxSide / side;
  if (scale === 1) return { w, h, scale: 1 };
  // Floor, not round, so the capped result is always at or under the ceilings.
  return { w: Math.max(1, Math.floor(w * scale)), h: Math.max(1, Math.floor(h * scale)), scale };
}

// Remove the old background's color from the half-transparent edge pixels. Each
// edge pixel is a mix C = a·F + (1−a)·B of the true foreground F and the
// background B it sat against; carrying that mix onto a new background leaves a
// colored halo (a bright ring on the misty photo, a brown one on the wood).
// With B estimated as the mean of the fully-removed pixels, F = (C − (1−a)·B)/a
// recovers the clean edge color. Only the transition band is touched; solid
// interior and near-clear pixels are left alone.
export function decontaminate(rgba, matte, n, bg) {
  for (let i = 0; i < n; i++) {
    const a = matte[i];
    if (a <= 0.1 || a >= 0.95) continue;
    const j = i * 4;
    for (let ch = 0; ch < 3; ch++) {
      const f = (rgba[j + ch] - (1 - a) * bg[ch]) / a;
      rgba[j + ch] = f < 0 ? 0 : f > 255 ? 255 : f;
    }
  }
  return rgba;
}

// decontaminate and applyAlpha in a single sweep. On a 16-megapixel output
// they were two separate passes over 16 million pixels; one pass shaves real
// time off exactly the photos that take longest. Same arithmetic as running
// the two in sequence, which the tests hold it to.
// With a local background map, each edge pixel is un-mixed against what was
// actually behind it rather than the photo-wide average; the global mean
// remains the fallback for spots the map could not reach.
export function finishOutput(rgba, matte, n, bg, map) {
  for (let i = 0; i < n; i++) {
    const a = matte[i];
    const j = i * 4;
    if (a > 0.1 && a < 0.95) {
      let b0 = bg[0], b1 = bg[1], b2 = bg[2];
      if (map && map.ok[i] > 0.5) { b0 = map.r[i]; b1 = map.g[i]; b2 = map.b[i]; }
      const ia = 1 - a;
      let f = (rgba[j] - ia * b0) / a;
      rgba[j] = f < 0 ? 0 : f > 255 ? 255 : f;
      f = (rgba[j + 1] - ia * b1) / a;
      rgba[j + 1] = f < 0 ? 0 : f > 255 ? 255 : f;
      f = (rgba[j + 2] - ia * b2) / a;
      rgba[j + 2] = f < 0 ? 0 : f > 255 ? 255 : f;
    }
    rgba[j + 3] = Math.round(a * 255);
  }
  return rgba;
}

// The mean color of the fully-removed background, the B in the unmix above.
export function backgroundColor(rgba, matte, n) {
  let r = 0, g = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) {
    if (matte[i] > 0.05) continue;
    const j = i * 4;
    r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; c++;
  }
  return c ? [r / c, g / c, b / c] : [255, 255, 255];
}

// Writes the alpha plane into an RGBA buffer in place.
export function applyAlpha(rgba, matte, n) {
  for (let i = 0; i < n; i++) {
    rgba[i * 4 + 3] = Math.round(matte[i] * 255);
  }
  return rgba;
}

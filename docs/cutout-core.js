/*! Background Bouncer | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-bouncer */

// The pure math of the pipeline: everything here works on plain typed arrays
// so it runs and tests the same in Node and in the browser. The model I/O
// lives in cutout.js.

export const MODEL_SIZE = 384;

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
export function outputSize(w, h, maxArea = 16000000) {
  if (w * h <= maxArea) return { w, h, scale: 1 };
  const scale = Math.sqrt(maxArea / (w * h));
  // Floor, not round, so the capped area is always at or under the ceiling.
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

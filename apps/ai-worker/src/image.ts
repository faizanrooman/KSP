/** Minimal RGB24 image toolkit (no native deps): resize/letterbox into model tensors, crops, affine warp, JPEG. */
import jpeg from 'jpeg-js';

export interface RgbImage {
  width: number;
  height: number;
  /** Row-major RGB24. */
  data: Uint8Array;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TensorOptions {
  width: number;
  height: number;
  /** 'stretch' ignores aspect; 'letterbox-tl' pads right/bottom (YOLOX); 'letterbox-center' pads both sides (YOLOv9). */
  mode: 'stretch' | 'letterbox-tl' | 'letterbox-center';
  padValue?: number;
  channelOrder: 'RGB' | 'BGR';
  layout: 'NCHW' | 'NHWC';
  /** value = (pixel * scale - mean[c]) / std[c] */
  scale?: number;
  mean?: [number, number, number];
  std?: [number, number, number];
  /** Produce uint8 output (layout NHWC only) — for models with uint8 inputs. */
  uint8?: boolean;
}

export interface TensorResult {
  data: Float32Array | Uint8Array;
  /** Scale applied to source coordinates (x_tensor = x_src * sx + padX). */
  sx: number;
  sy: number;
  padX: number;
  padY: number;
}

/** Bilinear sample of channel c at (x, y) in source pixel space (clamped). */
function sample(img: RgbImage, x: number, y: number, c: number): number {
  const w = img.width;
  const h = img.height;
  const xc = Math.min(Math.max(x, 0), w - 1);
  const yc = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = xc - x0;
  const fy = yc - y0;
  const d = img.data;
  const a = d[(y0 * w + x0) * 3 + c]!;
  const b = d[(y0 * w + x1) * 3 + c]!;
  const cc = d[(y1 * w + x0) * 3 + c]!;
  const dd = d[(y1 * w + x1) * 3 + c]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy;
}

/** Resize (+ optional letterbox padding) directly into a model input tensor. */
export function toTensor(img: RgbImage, o: TensorOptions): TensorResult {
  const W = o.width;
  const H = o.height;
  let sx = W / img.width;
  let sy = H / img.height;
  let padX = 0;
  let padY = 0;
  if (o.mode !== 'stretch') {
    const r = Math.min(sx, sy);
    sx = sy = r;
    const nw = Math.round(img.width * r);
    const nh = Math.round(img.height * r);
    if (o.mode === 'letterbox-center') {
      padX = (W - nw) / 2;
      padY = (H - nh) / 2;
    }
  }
  const scale = o.scale ?? 1;
  const mean = o.mean ?? [0, 0, 0];
  const std = o.std ?? [1, 1, 1];
  const pad = o.padValue ?? 114;
  const plane = W * H;
  const out = o.uint8 ? new Uint8Array(plane * 3) : new Float32Array(plane * 3);
  const order = o.channelOrder === 'RGB' ? [0, 1, 2] : [2, 1, 0];
  const contentW = img.width * sx;
  const contentH = img.height * sy;
  for (let y = 0; y < H; y++) {
    const srcY = (y + 0.5 - padY) / sy - 0.5;
    const inY = y + 0.5 >= padY && y + 0.5 - padY <= contentH;
    for (let x = 0; x < W; x++) {
      const srcX = (x + 0.5 - padX) / sx - 0.5;
      const inside = inY && x + 0.5 >= padX && x + 0.5 - padX <= contentW;
      for (let k = 0; k < 3; k++) {
        const src = order[k]!;
        const v = inside ? sample(img, srcX, srcY, src) : pad;
        const val = o.uint8 ? Math.round(v) : (v * scale - mean[k]!) / std[k]!;
        const idx = o.layout === 'NCHW' ? k * plane + y * W + x : (y * W + x) * 3 + k;
        out[idx] = val;
      }
    }
  }
  return { data: out, sx, sy, padX, padY };
}

export function clampBox(b: Box, w: number, h: number): Box {
  return { x1: Math.max(0, Math.min(w, b.x1)), y1: Math.max(0, Math.min(h, b.y1)), x2: Math.max(0, Math.min(w, b.x2)), y2: Math.max(0, Math.min(h, b.y2)) };
}

/** Crop (clamped, integer pixel grid) optionally expanded by `margin` (fraction of box size). */
export function crop(img: RgbImage, b: Box, margin = 0): RgbImage {
  const mw = (b.x2 - b.x1) * margin;
  const mh = (b.y2 - b.y1) * margin;
  const x1 = Math.max(0, Math.floor(b.x1 - mw));
  const y1 = Math.max(0, Math.floor(b.y1 - mh));
  const x2 = Math.min(img.width, Math.ceil(b.x2 + mw));
  const y2 = Math.min(img.height, Math.ceil(b.y2 + mh));
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, y1 + y);
    const srcStart = (sy * img.width + Math.min(img.width - 1, x1)) * 3;
    data.set(img.data.subarray(srcStart, srcStart + Math.min(w, img.width - x1) * 3), y * w * 3);
  }
  return { width: w, height: h, data };
}

export function resize(img: RgbImage, width: number, height: number): RgbImage {
  const t = toTensor(img, { width, height, mode: 'stretch', channelOrder: 'RGB', layout: 'NHWC', uint8: true });
  return { width, height, data: t.data as Uint8Array };
}

/**
 * Warp with a 2x3 affine matrix M mapping SOURCE -> DESTINATION (like cv2.warpAffine without WARP_INVERSE_MAP).
 * Out-of-bounds pixels are black.
 */
export function warpAffine(img: RgbImage, M: number[], width: number, height: number): RgbImage {
  const [a, b, c, d, e, f] = M as [number, number, number, number, number, number];
  const det = a * e - b * d;
  // inverse mapping dst -> src
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  const ic = -(ia * c + ib * f);
  const iff = -(id * c + ie * f);
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = ia * x + ib * y + ic;
      const sy = id * x + ie * y + iff;
      if (sx < -0.5 || sy < -0.5 || sx > img.width - 0.5 || sy > img.height - 0.5) continue;
      for (let k = 0; k < 3; k++) out[(y * width + x) * 3 + k] = Math.round(sample(img, sx, sy, k));
    }
  }
  return { width, height, data: out };
}

/**
 * Least-squares similarity transform (rotation + uniform scale + translation) mapping src points to dst points
 * (Umeyama without reflection; same as skimage SimilarityTransform / cv2.estimateAffinePartial2D in the noiseless case).
 */
export function similarityTransform(src: Array<[number, number]>, dst: Array<[number, number]>): number[] {
  const n = src.length;
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i]![0]; msy += src[i]![1]; mdx += dst[i]![0]; mdy += dst[i]![1];
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let var_ = 0;
  let a1 = 0, b1 = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i]![0] - msx, y = src[i]![1] - msy;
    const u = dst[i]![0] - mdx, v = dst[i]![1] - mdy;
    a1 += x * u + y * v;
    b1 += x * v - y * u;
    var_ += x * x + y * y;
  }
  const a = a1 / var_;
  const b = b1 / var_;
  // [a -b tx; b a ty]
  const tx = mdx - (a * msx - b * msy);
  const ty = mdy - (b * msx + a * msy);
  return [a, -b, tx, b, a, ty];
}

export function encodeJpeg(img: RgbImage, quality = 85): Buffer {
  const rgba = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0, j = 0; i < img.data.length; i += 3, j += 4) {
    rgba[j] = img.data[i]!;
    rgba[j + 1] = img.data[i + 1]!;
    rgba[j + 2] = img.data[i + 2]!;
    rgba[j + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width: img.width, height: img.height }, quality).data;
}

export function decodeJpeg(buf: Buffer): RgbImage {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 });
  const out = new Uint8Array(d.width * d.height * 3);
  for (let i = 0, j = 0; j < d.data.length; i += 3, j += 4) {
    out[i] = d.data[j]!;
    out[i + 1] = d.data[j + 1]!;
    out[i + 2] = d.data[j + 2]!;
  }
  return { width: d.width, height: d.height, data: out };
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Greedy non-maximum suppression; returns kept indices (sorted by score desc). */
export function nms<T extends { box: Box; confidence: number }>(items: T[], iouThreshold: number): T[] {
  const sorted = [...items].sort((a, b) => b.confidence - a.confidence);
  const keep: T[] = [];
  for (const it of sorted) {
    if (keep.every((k) => iou(k.box, it.box) <= iouThreshold)) keep.push(it);
  }
  return keep;
}

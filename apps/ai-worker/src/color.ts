/** Dominant colour of a detection crop: k-means (k=3) on the central region (torso for persons), HSV naming. */
import type { Box, RgbImage } from './image.js';

export interface ColorAttributes {
  dominantColor: string;
  colorName: string;
  colorShare: number;
}

export function colorName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    const rr = r / 255, gg = g / 255, bb = b / 255;
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  if (v < 0.2) return 'black';
  if (s < 0.18) return v > 0.8 ? 'white' : v > 0.45 ? 'grey' : 'dark grey';
  if (h < 15 || h >= 345) return v < 0.45 ? 'maroon' : 'red';
  if (h < 40) return v < 0.55 ? 'brown' : 'orange';
  if (h < 70) return v < 0.5 ? 'olive' : 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'cyan';
  if (h < 255) return v < 0.4 ? 'navy' : 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

export function dominantColor(img: RgbImage, box: Box, kind: 'person' | 'object' | 'whole' = 'object'): ColorAttributes {
  const bw = box.x2 - box.x1;
  const bh = box.y2 - box.y1;
  const region = kind === 'person'
    ? { x1: box.x1 + bw * 0.25, x2: box.x2 - bw * 0.25, y1: box.y1 + bh * 0.2, y2: box.y1 + bh * 0.55 }
    : kind === 'object'
      ? { x1: box.x1 + bw * 0.15, x2: box.x2 - bw * 0.15, y1: box.y1 + bh * 0.25, y2: box.y2 - bh * 0.25 }
      : box;
  const x1 = Math.max(0, Math.floor(region.x1)), x2 = Math.min(img.width, Math.ceil(region.x2));
  const y1 = Math.max(0, Math.floor(region.y1)), y2 = Math.min(img.height, Math.ceil(region.y2));
  const w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1);
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 1600)));
  const px: number[][] = [];
  for (let y = y1; y < y1 + h; y += step) {
    for (let x = x1; x < x1 + w; x += step) {
      const i = (Math.min(img.height - 1, y) * img.width + Math.min(img.width - 1, x)) * 3;
      px.push([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]);
    }
  }
  const k = Math.min(3, px.length);
  // deterministic init: pixels at quantiles of luminance
  const byLum = [...px].sort((a, b) => a[0]! + a[1]! + a[2]! - (b[0]! + b[1]! + b[2]!));
  let centers = Array.from({ length: k }, (_, i) => [...byLum[Math.floor(((i + 0.5) / k) * byLum.length)]!]);
  const assign = new Int32Array(px.length);
  for (let iter = 0; iter < 10; iter++) {
    for (let p = 0; p < px.length; p++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (px[p]![0]! - centers[c]![0]!) ** 2 + (px[p]![1]! - centers[c]![1]!) ** 2 + (px[p]![2]! - centers[c]![2]!) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[p] = best;
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let p = 0; p < px.length; p++) {
      const s = sums[assign[p]!]!;
      s[0]! += px[p]![0]!; s[1]! += px[p]![1]!; s[2]! += px[p]![2]!; s[3]! += 1;
    }
    centers = sums.map((s, c) => (s[3]! ? [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] : centers[c]!));
  }
  const counts = new Array(k).fill(0) as number[];
  for (let p = 0; p < px.length; p++) counts[assign[p]!]!++;
  let top = 0;
  for (let c = 1; c < k; c++) if (counts[c]! > counts[top]!) top = c;
  const [r, g, b] = centers[top]! as [number, number, number];
  return { dominantColor: `#${hex(r)}${hex(g)}${hex(b)}`, colorName: colorName(r, g, b), colorShare: Math.round((counts[top]! / Math.max(1, px.length)) * 100) / 100 };
}

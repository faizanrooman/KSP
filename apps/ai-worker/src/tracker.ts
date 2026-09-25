/**
 * Greedy IoU tracker (constant-velocity prediction, centre-distance fallback) + dedupe. Detections of the same track class (label / watchlist entry / 'plate') in consecutive
 * sampled frames with IoU >= minIou are one track. Per track we keep the best detection of every `keepEveryMs`
 * window (so a long track yields one representative per window, and the overall best is always among them).
 */
import { iou, type Box } from './image.js';

export interface TrackedInput<T> {
  trackClass: string;
  box: Box;
  confidence: number;
  frameIndex: number;
  timeMs: number;
  payload: T;
}

export interface Emitted<T> {
  trackId: string;
  item: TrackedInput<T>;
  /** Detections observed in this window (dedupe count). */
  observations: number;
}

interface Track<T> {
  id: string;
  cls: string;
  box: Box;
  lastFrame: number;
  windowStartMs: number;
  best: TrackedInput<T>;
  count: number;
  total: number;
  /** Smoothed centre velocity in px per sampled frame (constant-velocity prediction handles camera pans). */
  vx: number;
  vy: number;
}

const cx = (b: Box) => (b.x1 + b.x2) / 2;
const cy = (b: Box) => (b.y1 + b.y2) / 2;
const area = (b: Box) => Math.max(1e-6, (b.x2 - b.x1) * (b.y2 - b.y1));
const shift = (b: Box, dx: number, dy: number): Box => ({ x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy });

/**
 * Association score between a track (predicted forward) and a detection: IoU when >= minIou; otherwise a lower score
 * when the centres are close relative to the object size and the areas are similar (small, fast-moving objects).
 */
function matchScore(pred: Box, det: Box, minIou: number): number {
  const v = iou(pred, det);
  if (v >= minIou) return v;
  const size = Math.sqrt(area(pred));
  const d = Math.hypot(cx(pred) - cx(det), cy(pred) - cy(det)) / size;
  const ratio = area(det) / area(pred);
  if (d < 0.6 && ratio > 0.5 && ratio < 2) return minIou * 0.5 * (1 - d / 0.6) + 1e-6;
  return 0;
}

export class IouTracker<T> {
  private tracks: Track<T>[] = [];
  private seq = 0;
  constructor(
    private readonly opts: { minIou: number; maxGapFrames: number; keepEveryMs: number; prefix?: string },
    private readonly onEmit: (e: Emitted<T>) => void,
  ) {}

  /** Add all detections of one sampled frame. */
  update(frameIndex: number, items: Array<TrackedInput<T>>): void {
    const used = new Set<Track<T>>();
    const sorted = [...items].sort((a, b) => b.confidence - a.confidence);
    for (const it of sorted) {
      let best: Track<T> | null = null;
      let bestScore = 0;
      for (const t of this.tracks) {
        if (used.has(t) || t.cls !== it.trackClass) continue;
        const gap = frameIndex - t.lastFrame;
        const v = matchScore(shift(t.box, t.vx * gap, t.vy * gap), it.box, this.opts.minIou);
        if (v > bestScore) { bestScore = v; best = t; }
      }
      if (best) {
        const gap = Math.max(1, frameIndex - best.lastFrame);
        best.vx = 0.5 * best.vx + 0.5 * ((cx(it.box) - cx(best.box)) / gap);
        best.vy = 0.5 * best.vy + 0.5 * ((cy(it.box) - cy(best.box)) / gap);
      }
      if (!best) {
        best = { id: `${this.opts.prefix ?? 't'}${++this.seq}`, cls: it.trackClass, box: it.box, lastFrame: frameIndex, windowStartMs: it.timeMs, best: it, count: 0, total: 0, vx: 0, vy: 0 };
        this.tracks.push(best);
      } else if (it.timeMs - best.windowStartMs >= this.opts.keepEveryMs) {
        this.flush(best);
        best.windowStartMs = it.timeMs;
        best.best = it;
        best.count = 0;
      }
      used.add(best);
      best.box = it.box;
      best.lastFrame = frameIndex;
      best.count++;
      best.total++;
      if (it.confidence > best.best.confidence) best.best = it;
    }
    // close tracks not seen for maxGapFrames
    const alive: Track<T>[] = [];
    for (const t of this.tracks) {
      if (frameIndex - t.lastFrame > this.opts.maxGapFrames) this.flush(t);
      else alive.push(t);
    }
    this.tracks = alive;
  }

  private flush(t: Track<T>): void {
    if (t.count > 0) this.onEmit({ trackId: t.id, item: t.best, observations: t.count });
    t.count = 0;
  }

  /** End of stream: emit every open track. */
  finish(): void {
    for (const t of this.tracks) this.flush(t);
    this.tracks = [];
  }

  get tracksStarted(): number {
    return this.seq;
  }
}

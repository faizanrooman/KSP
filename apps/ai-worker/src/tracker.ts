/**
 * Greedy IoU tracker + dedupe. Detections of the same track class (label / watchlist entry / 'plate') in consecutive
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
      let bestIou = this.opts.minIou;
      for (const t of this.tracks) {
        if (used.has(t) || t.cls !== it.trackClass) continue;
        const v = iou(t.box, it.box);
        if (v >= bestIou) { bestIou = v; best = t; }
      }
      if (!best) {
        best = { id: `${this.opts.prefix ?? 't'}${++this.seq}`, cls: it.trackClass, box: it.box, lastFrame: frameIndex, windowStartMs: it.timeMs, best: it, count: 0, total: 0 };
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

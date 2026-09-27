/** Pure helpers: region drawing on the video frame and timeline layout (unit-tested). */
import type { Region, Timeline, TimelineEntry } from './api';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Normalised region from two pointer positions inside a box (any drag direction). Null when too small. */
export function regionFromDrag(box: { left: number; top: number; width: number; height: number }, a: { x: number; y: number }, b: { x: number; y: number }, minSize = 0.01): Region | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const x1 = clamp01((a.x - box.left) / box.width);
  const y1 = clamp01((a.y - box.top) / box.height);
  const x2 = clamp01((b.x - box.left) / box.width);
  const y2 = clamp01((b.y - box.top) / box.height);
  const r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  if (r.w < minSize || r.h < minSize) return null;
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
  return { x: round(r.x), y: round(r.y), w: round(Math.min(r.w, 1 - r.x)), h: round(Math.min(r.h, 1 - r.y)) };
}

// ---- keyboard region editing (WCAG 2.1.1 alternative to drag-drawing) ---------------------------------------

/** Default region created by the keyboard editor: centred, 20 % × 20 % of the frame. */
export const DEFAULT_REGION: Region = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
const MIN_SIDE = 0.01;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Clamp a region into the frame (sides ≥ 1 %, fully inside [0,1]) and round to 4 decimals. */
export function clampRegion(r: Region): Region {
  const w = Math.min(1, Math.max(MIN_SIDE, r.w));
  const h = Math.min(1, Math.max(MIN_SIDE, r.h));
  const x = Math.min(1 - w, Math.max(0, r.x));
  const y = Math.min(1 - h, Math.max(0, r.y));
  return { x: r4(x), y: r4(y), w: r4(w), h: r4(h) };
}

/**
 * Arrow-key editing: arrows move the region, Shift+arrows resize it (Right/Down grow, Left/Up shrink), by `step`
 * (fraction of the frame). Returns null for keys it does not handle.
 */
export function nudgeRegion(r: Region, key: string, shift: boolean, step = 0.01): Region | null {
  const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[key];
  if (!d) return null;
  const [dx, dy] = d;
  return clampRegion(shift ? { ...r, w: r.w + dx * step, h: r.h + dy * step } : { ...r, x: r.x + dx * step, y: r.y + dy * step });
}

/** Human-readable region in whole percent (screen-reader announcements, badges). */
export function describeRegion(r: Region): string {
  const p = (v: number) => `${Math.round(v * 100)}%`;
  return `left ${p(r.x)}, top ${p(r.y)}, width ${p(r.w)}, height ${p(r.h)}`;
}

/** Is an annotation visible at time t? Point annotations (no end) show for `holdMs` after their start. */
export function activeAt(a: { startMs: number; endMs: number | null }, t: number, holdMs = 2000): boolean {
  const end = a.endMs ?? a.startMs + holdMs;
  return t >= a.startMs && t <= end;
}

export interface LaidOut {
  startMs: number;
  endMs: number;
  /** percentage position [0,100] of a wall-clock time on the axis */
  pos: (iso: string) => number;
  lanes: Array<{ itemId: string; evidenceId: string; label: string; left: number; width: number; marks: Array<{ entry: TimelineEntry; left: number }> }>;
  events: Array<{ entry: Extract<TimelineEntry, { kind: 'EVENT' }>; left: number }>;
}

/** Horizontal lane layout for the timeline chart (one lane per recording + a row of manual events). */
export function layoutTimeline(t: Timeline): LaidOut | null {
  if (!t.range) return null;
  const startMs = Date.parse(t.range.start);
  const endMs = Math.max(Date.parse(t.range.end), startMs + 1000);
  const span = endMs - startMs;
  const pos = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - startMs) / span) * 100));
  const lanes = t.lanes.map((l) => ({
    itemId: l.itemId,
    evidenceId: l.evidenceId,
    label: l.evidenceNumber ?? l.title ?? l.evidenceId,
    left: pos(l.start),
    width: Math.max(0.5, pos(l.end) - pos(l.start)),
    marks: t.entries.filter((e) => (e.kind === 'BOOKMARK' || e.kind === 'ANNOTATION') && e.evidenceId === l.evidenceId).map((e) => ({ entry: e, left: pos(e.at) })),
  }));
  const events = t.entries.filter((e): e is Extract<TimelineEntry, { kind: 'EVENT' }> => e.kind === 'EVENT').map((e) => ({ entry: e, left: pos(e.at) }));
  return { startMs, endMs, pos, lanes, events };
}

/** Local playback time (ms) in a lane for a wall-clock position given as a fraction of the axis. */
export function laneTimeAt(laneStartIso: string, laneDurationMs: number, axis: { startMs: number; endMs: number }, fraction: number): number {
  const wall = axis.startMs + fraction * (axis.endMs - axis.startMs);
  return Math.round(Math.min(laneDurationMs, Math.max(0, wall - Date.parse(laneStartIso))));
}

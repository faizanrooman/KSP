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

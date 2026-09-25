import { describe, expect, it } from 'vitest';
import { activeAt, laneTimeAt, layoutTimeline, regionFromDrag } from './geometry';
import type { Timeline } from './api';

describe('region drawing', () => {
  const box = { left: 100, top: 50, width: 400, height: 200 };
  it('normalises drags in any direction and clamps to the frame', () => {
    expect(regionFromDrag(box, { x: 200, y: 100 }, { x: 300, y: 150 })).toEqual({ x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
    expect(regionFromDrag(box, { x: 300, y: 150 }, { x: 200, y: 100 })).toEqual({ x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
    expect(regionFromDrag(box, { x: 400, y: 200 }, { x: 900, y: 900 })).toEqual({ x: 0.75, y: 0.75, w: 0.25, h: 0.25 });
    expect(regionFromDrag(box, { x: 200, y: 100 }, { x: 201, y: 101 })).toBeNull();
  });
  it('annotation visibility window', () => {
    expect(activeAt({ startMs: 1000, endMs: 3000 }, 2000)).toBe(true);
    expect(activeAt({ startMs: 1000, endMs: 3000 }, 3500)).toBe(false);
    expect(activeAt({ startMs: 1000, endMs: null }, 2500)).toBe(true);
    expect(activeAt({ startMs: 1000, endMs: null }, 3500)).toBe(false);
  });
});

describe('timeline layout', () => {
  const t: Timeline = {
    range: { start: '2026-04-01T10:00:00.000Z', end: '2026-04-01T10:10:00.000Z' },
    lanes: [
      { itemId: 'i1', evidenceId: 'e1', evidenceNumber: 'A', title: null, start: '2026-04-01T10:00:00.000Z', end: '2026-04-01T10:05:00.000Z', durationMs: 300000, syncOffsetMs: 0, suggestedOffsetMs: 0 },
      { itemId: 'i2', evidenceId: 'e2', evidenceNumber: 'B', title: null, start: '2026-04-01T10:05:00.000Z', end: '2026-04-01T10:10:00.000Z', durationMs: 300000, syncOffsetMs: 0, suggestedOffsetMs: 300000 },
    ],
    entries: [
      { kind: 'BOOKMARK', at: '2026-04-01T10:01:00.000Z', id: 'b', evidenceId: 'e1', timeMs: 60000, label: 'x', user: 'u' },
      { kind: 'EVENT', at: '2026-04-01T10:07:30.000Z', id: 'ev', title: 't', description: null, evidenceId: null, timeMs: null, restricted: false, createdBy: 'u' },
    ],
    overlaps: [],
    unplaced: [],
    unplacedItems: [],
  };
  it('positions lanes, marks and events as percentages', () => {
    const l = layoutTimeline(t)!;
    expect(l.lanes.map((x) => [x.left, x.width])).toEqual([[0, 50], [50, 50]]);
    expect(l.lanes[0]!.marks[0]!.left).toBe(10);
    expect(l.lanes[1]!.marks).toHaveLength(0);
    expect(l.events[0]!.left).toBe(75);
    expect(laneTimeAt(t.lanes[1]!.start, 300000, l, 0.75)).toBe(150000);
    expect(laneTimeAt(t.lanes[1]!.start, 300000, l, 0.1)).toBe(0);
    expect(layoutTimeline({ ...t, range: null })).toBeNull();
  });
});

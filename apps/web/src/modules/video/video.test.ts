import { describe, expect, it } from 'vitest';
import { cueAt, frameOf, parseSpriteVtt, withToken } from './api';
import { parseTimeInput } from './tabs';

describe('video helpers', () => {
  it('parses the sprite VTT served by the API (token before #xywh)', () => {
    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nsprite_000.jpg?t=abc.def#xywh=0,0,160,90\n\n00:00:02.000 --> 00:00:04.000\nsprite_000.jpg?t=abc.def#xywh=160,0,160,90\n';
    const cues = parseSpriteVtt(vtt, '/api/v1/media/stream/e1/sprite/thumbnails.vtt?t=abc.def');
    expect(cues).toHaveLength(2);
    expect(cues[1]).toEqual({ startMs: 2000, endMs: 4000, url: '/api/v1/media/stream/e1/sprite/sprite_000.jpg?t=abc.def', x: 160, y: 0, w: 160, h: 90 });
    expect(cueAt(cues, 2500)?.x).toBe(160);
    expect(cueAt(cues, 99999)?.x).toBe(160);
  });

  it('frame numbers and token substitution', () => {
    expect(frameOf(1480 + 1, 25)).toBe(37);
    expect(frameOf(1480, 25)).toBe(37);
    expect(frameOf(1479.9, 25)).toBe(36);
    expect(withToken('/api/v1/media/stream/e/hls/360p/seg_00001.ts?t=old', 'new')).toBe('/api/v1/media/stream/e/hls/360p/seg_00001.ts?t=new');
  });

  it('parses time inputs', () => {
    expect(parseTimeInput('01:23.456')).toBe(83456);
    expect(parseTimeInput('1:00:00')).toBe(3_600_000);
    expect(parseTimeInput('1500ms')).toBe(1500);
    expect(parseTimeInput('abc')).toBeNull();
  });
});

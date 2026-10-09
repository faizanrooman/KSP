/**
 * Synchronised multi-camera playback (1–4 items).
 *
 * Timeline model: a single MASTER clock (wall-clock driven while playing, at the shared rate). Item i shows
 * local time = master − offsetMs(i); before its start it is parked at 0, after its end at the last frame.
 * Every 250 ms each item's actual position is compared with its expected position and re-seeked when the
 * drift exceeds one frame (with a 1 s cool-down per item so a buffering item is not seeked repeatedly).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, StepBack, StepForward } from 'lucide-react';
import { clsx } from '@/components/ui';
import { formatTimecode } from '@/lib/format';
import { EvidencePlayer, RATES, type EvidencePlayerHandle } from './EvidencePlayer';
import type { PlaybackInfo } from './api';

import { t } from '@/lib/i18n';
export interface SyncItem {
  evidenceId: string;
  /** Position of this item's t=0 on the shared (master) timeline, in ms. */
  offsetMs: number;
  label: string;
}

export interface SyncPlayerProps {
  items: SyncItem[];
  onOffsetsChange?: (items: SyncItem[]) => void;
  className?: string;
}

const DRIFT_CHECK_MS = 250;
const RESYNC_COOLDOWN_MS = 1000;

export function SyncPlayer({ items: input, onOffsetsChange, className }: SyncPlayerProps) {
  const items = input.slice(0, 4);
  const [offsets, setOffsets] = useState<number[]>(items.map((i) => i.offsetMs));
  const key = items.map((i) => `${i.evidenceId}:${i.offsetMs}`).join('|');
  useEffect(() => setOffsets(items.map((i) => i.offsetMs)), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const refs = useRef<Array<EvidencePlayerHandle | null>>([]);
  const [infos, setInfos] = useState<Record<string, PlaybackInfo>>({});
  const [master, setMaster] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const clock = useRef({ base: 0, wall: 0 });
  const lastResync = useRef<number[]>([]);

  const durationOf = (i: number) => infos[items[i]?.evidenceId ?? '']?.durationMs ?? refs.current[i]?.getDuration() ?? 0;
  const fpsOf = (i: number) => infos[items[i]?.evidenceId ?? '']?.frameRate ?? refs.current[i]?.getFrameRate() ?? 25;
  const range = useMemo(() => {
    let start = 0;
    let end = 0;
    items.forEach((_, i) => {
      start = Math.min(start, offsets[i] ?? 0);
      end = Math.max(end, (offsets[i] ?? 0) + durationOf(i));
    });
    return { start, end: Math.max(end, start + 1) };
  }, [offsets, infos, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const masterNow = useCallback(() => (playing ? clock.current.base + (performance.now() - clock.current.wall) * rate : master), [playing, rate, master]);

  /** Put every item where the master clock says it should be. */
  const alignAll = useCallback((m: number, play: boolean) => {
    items.forEach((_, i) => {
      const p = refs.current[i];
      if (!p) return;
      const local = m - (offsets[i] ?? 0);
      const dur = durationOf(i);
      if (local < 0 || (dur && local >= dur)) {
        p.pause();
        p.seek(local < 0 ? 0 : dur - 1000 / fpsOf(i));
      } else {
        p.seek(local);
        p.setRate(rate);
        if (play) p.play();
        else p.pause();
      }
    });
  }, [items, offsets, rate]); // eslint-disable-line react-hooks/exhaustive-deps

  const seekMaster = (m: number) => {
    const v = Math.max(range.start, Math.min(range.end, m));
    clock.current = { base: v, wall: performance.now() };
    setMaster(v);
    alignAll(v, playing);
  };
  const togglePlay = () => {
    const m = masterNow();
    clock.current = { base: m, wall: performance.now() };
    setMaster(m);
    setPlaying(!playing);
    alignAll(m, !playing);
  };
  const stepMaster = (n: number) => {
    const m = masterNow();
    setPlaying(false);
    const f = 1000 / fpsOf(0);
    const v = Math.max(range.start, Math.min(range.end, (Math.floor(m / f + 1e-6) + n) * f + 1));
    clock.current = { base: v, wall: performance.now() };
    setMaster(v);
    alignAll(v, false);
  };
  const changeRate = (r: number) => {
    const m = masterNow();
    clock.current = { base: m, wall: performance.now() };
    setRate(r);
    refs.current.forEach((p) => p?.setRate(r));
  };

  // master clock + drift correction while playing
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const m = clock.current.base + (performance.now() - clock.current.wall) * rate;
      if (m >= range.end) {
        setPlaying(false);
        setMaster(range.end);
        refs.current.forEach((p) => p?.pause());
        return;
      }
      setMaster(m);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const timer = setInterval(() => {
      const m = clock.current.base + (performance.now() - clock.current.wall) * rate;
      const now = performance.now();
      items.forEach((_, i) => {
        const p = refs.current[i];
        if (!p) return;
        const local = m - (offsets[i] ?? 0);
        const dur = durationOf(i);
        const inRange = local >= 0 && (!dur || local < dur);
        if (!inRange) {
          if (!p.isPaused()) p.pause();
          return;
        }
        if (p.isPaused()) {
          p.seek(local);
          p.setRate(rate);
          p.play();
          lastResync.current[i] = now;
          return;
        }
        const drift = p.getTime() - local;
        if (Math.abs(drift) > 1000 / fpsOf(i) && now - (lastResync.current[i] ?? 0) > RESYNC_COOLDOWN_MS) {
          p.seek(local);
          lastResync.current[i] = now;
        }
      });
    }, DRIFT_CHECK_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [playing, rate, range.end, offsets, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const adjust = (i: number, delta: number) => {
    const next = offsets.map((o, j) => (j === i ? Math.round((o + delta) * 1000) / 1000 : o));
    setOffsets(next);
    onOffsetsChange?.(items.map((it, j) => ({ ...it, offsetMs: next[j] ?? it.offsetMs })));
    const p = refs.current[i];
    const local = masterNow() - (next[i] ?? 0);
    if (p && local >= 0) p.seek(local);
  };

  const cols = items.length <= 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2';
  const btn = 'inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-ink-100 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400';
  return (
    <div className={clsx('space-y-2', className)}>
      <div className={clsx('grid gap-2', cols)}>
        {items.map((it, i) => {
          const f = 1000 / fpsOf(i);
          const local = master - (offsets[i] ?? 0);
          return (
            <div key={`${it.evidenceId}-${i}`} className="overflow-hidden rounded-lg border border-ink-200 bg-white">
              <EvidencePlayer
                ref={(h) => {
                  refs.current[i] = h;
                }}
                evidenceId={it.evidenceId}
                label={it.label}
                hideControls
                muted={i > 0}
                maxHeight={items.length > 2 ? '32vh' : '45vh'}
                onReady={(info) => setInfos((x) => ({ ...x, [it.evidenceId]: info }))}
              />
              {/* Label + local time, then the offset controls as one unit (they used to wrap mid-group). */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-xs">
                <span className="flex min-w-[13rem] flex-1 flex-wrap items-center gap-x-2">
                  <span className="font-medium text-ink-800 [overflow-wrap:anywhere]">{it.label}</span>
                  <span className="mono whitespace-nowrap text-ink-500">{local < 0 ? t('starts in {value}', { value: formatTimecode(-local) }) : formatTimecode(local)}</span>
                </span>
                <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap">
                <span className="text-ink-600">{t('Offset')}</span>
                <button type="button" className="rounded border border-ink-200 px-1 hover:bg-ink-50" onClick={() => adjust(i, -100)} aria-label={t('{label}: offset −100 ms', { label: it.label })}>{t('−100ms')}</button>
                <button type="button" className="rounded border border-ink-200 px-1 hover:bg-ink-50" onClick={() => adjust(i, -f)} aria-label={t('{label}: offset −1 frame', { label: it.label })}>−1f</button>
                <span className="mono w-20 text-center" aria-live="polite">{(offsets[i] ?? 0) >= 0 ? '+' : '−'}{formatTimecode(Math.abs(offsets[i] ?? 0))}</span>
                <button type="button" className="rounded border border-ink-200 px-1 hover:bg-ink-50" onClick={() => adjust(i, f)} aria-label={t('{label}: offset +1 frame', { label: it.label })}>+1f</button>
                <button type="button" className="rounded border border-ink-200 px-1 hover:bg-ink-50" onClick={() => adjust(i, 100)} aria-label={t('{label}: offset +100 ms', { label: it.label })}>{t('+100ms')}</button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-ink-950 px-3 py-2 text-ink-100" role="group" aria-label={t('Synchronised transport')}>
        <button type="button" className={btn} onClick={togglePlay} aria-label={playing ? t('Pause all') : t('Play all')}>{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button type="button" className={btn} onClick={() => stepMaster(-1)} aria-label={t('All: previous frame')}><StepBack className="h-4 w-4" /></button>
        <button type="button" className={btn} onClick={() => stepMaster(1)} aria-label={t('All: next frame')}><StepForward className="h-4 w-4" /></button>
        <input
          type="range"
          className="min-w-[160px] flex-1 accent-brand-500"
          min={range.start}
          max={range.end}
          step={1}
          value={Math.min(range.end, Math.max(range.start, master))}
          onChange={(e) => seekMaster(Number(e.target.value))}
          aria-label={t('Shared timeline')}
          aria-valuetext={formatTimecode(master)}
        />
        <span className="mono text-xs tabular-nums">{master < 0 ? '−' : ''}{formatTimecode(Math.abs(master))} / {formatTimecode(range.end)}</span>
        <label className="sr-only" htmlFor="sync-rate">{t('Playback rate')}</label>
        <select id="sync-rate" value={rate} onChange={(e) => changeRate(Number(e.target.value))} className="h-8 rounded bg-white/10 px-1 text-xs">
          {RATES.map((r) => <option key={r} value={r} className="text-ink-900">{r}×</option>)}
        </select>
      </div>
    </div>
  );
}

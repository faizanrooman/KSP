/**
 * Forensic evidence player.
 *
 *  - Sources: HLS via hls.js (native HLS fallback on Safari/iOS) or the H.264 proxy MP4. All URLs are
 *    tokenised API URLs; the token is refreshed before expiry without losing the playback position
 *    (hls.js: every request URL is re-signed in xhrSetup; native/MP4: src swap restoring time/rate/paused).
 *  - Frame-accurate navigation: the proxy/HLS are CFR at `frameRate`; frame n occupies [n/fps, (n+1)/fps).
 *    Frame stepping parks the playhead 1 ms into the target frame so decoders never round to the previous one.
 *  - Zoom 1–8x (wheel / buttons / keys) with drag-to-pan. `overlays` render inside the zoomed layer, in a box
 *    that exactly covers the video frame, so normalised coordinates (percentages or an SVG viewBox 0 0 1 1)
 *    follow zoom and pan.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import Hls from 'hls.js';
import { Camera, FastForward, Keyboard, Loader2, Maximize, Minimize, Pause, Play, Rewind, RotateCcw, StepBack, StepForward, ZoomIn, ZoomOut } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { formatTimecode } from '@/lib/format';
import { Alert, Button, clsx, ErrorState, ProgressBar, Spinner, useToast } from '@/components/ui';
import { cueAt, frameOf, parseSpriteVtt, tokenFrom, useCreateSnapshot, usePlayback, withToken, type PlaybackInfo, type SpriteCue } from './api';

export interface EvidencePlayerHandle {
  seek(ms: number): void;
  play(): void;
  pause(): void;
  setRate(rate: number): void;
  getTime(): number;
  stepFrame(n: number): void;
  getDuration(): number | null;
  getFrameRate(): number | null;
  isPaused(): boolean;
}

export interface PlayerMarker {
  timeMs: number;
  label: string;
  color?: string;
}

export interface EvidencePlayerProps {
  evidenceId: string;
  onTimeUpdate?: (ms: number) => void;
  onReady?: (info: PlaybackInfo) => void;
  /** Drawn over the video frame (inside the zoom/pan layer). Use normalised coordinates. */
  overlays?: ReactNode;
  markers?: PlayerMarker[];
  initialTimeMs?: number;
  /** Hide the built-in transport (SyncPlayer supplies a shared one). */
  hideControls?: boolean;
  muted?: boolean;
  /** Max stage height (CSS length), default 70vh. */
  maxHeight?: string;
  /** Distinguishes several players on one page (landmark names must be unique), e.g. the evidence number. */
  label?: string;
  className?: string;
}

export const RATES = [0.1, 0.25, 0.5, 1, 1.5, 2] as const;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

export const EvidencePlayer = forwardRef<EvidencePlayerHandle, EvidencePlayerProps>(function EvidencePlayer(props, ref) {
  const q = usePlayback(props.evidenceId);
  const inner = useRef<EvidencePlayerHandle>(null);
  useImperativeHandle(ref, () => ({
    seek: (ms) => inner.current?.seek(ms),
    play: () => inner.current?.play(),
    pause: () => inner.current?.pause(),
    setRate: (r) => inner.current?.setRate(r),
    getTime: () => inner.current?.getTime() ?? 0,
    stepFrame: (n) => inner.current?.stepFrame(n),
    getDuration: () => inner.current?.getDuration() ?? q.data?.durationMs ?? null,
    getFrameRate: () => inner.current?.getFrameRate() ?? q.data?.frameRate ?? null,
    isPaused: () => inner.current?.isPaused() ?? true,
  }), [q.data?.durationMs, q.data?.frameRate]);

  const box = (children: ReactNode) => (
    <div className={clsx('flex min-h-[240px] items-center justify-center rounded-lg bg-ink-950 p-6 text-sm text-ink-100', props.className)}>{children}</div>
  );
  if (q.isLoading) return box(<Spinner label="Loading player…" className="text-ink-100" />);
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load playback" />;
  const d = q.data;
  if (d.mediaStatus === 'PENDING' || d.mediaStatus === 'PROCESSING') {
    return box(
      <div className="w-full max-w-sm space-y-3 text-center" role="status" aria-live="polite">
        <Loader2 className="mx-auto h-6 w-6 animate-spin" aria-hidden />
        <p className="font-medium">{d.mediaStatus === 'PENDING' ? 'Queued for processing' : 'Preparing playback'}</p>
        <ProgressBar value={d.progress} label="Media processing progress" />
        <p className="text-xs text-ink-300">{Math.round(d.progress * 100)}% — proxy, adaptive stream and thumbnails are being generated. This page updates automatically.</p>
      </div>,
    );
  }
  if (d.mediaStatus === 'FAILED' || d.mediaStatus === 'UNSUPPORTED') {
    return (
      <div className={props.className}>
        <Alert tone={d.mediaStatus === 'FAILED' ? 'red' : 'amber'} title={d.mediaStatus === 'FAILED' ? 'Media processing failed' : 'Playback not available for this file'}>
          <p>{d.mediaStatus === 'FAILED' ? 'Playback derivatives could not be generated. The original evidence file is unaffected; processing can be retried.' : 'The file could not be decoded as video (for example audio-only, damaged or an unsupported format). The original evidence file is preserved unchanged.'}</p>
          {d.mediaError && <p className="mono mt-1 break-words text-xs">{d.mediaError}</p>}
        </Alert>
      </div>
    );
  }
  if (!d.mp4Url) return <ErrorState error={new Error('Playback URLs missing')} onRetry={() => void q.refetch()} />;
  return <ReadyPlayer {...props} ref={inner} info={d} refetch={() => q.refetch().then(() => undefined)} />;
});

// ---------------------------------------------------------------------------------------------
interface ReadyProps extends EvidencePlayerProps {
  info: PlaybackInfo;
  refetch: () => Promise<void>;
}

const ReadyPlayer = forwardRef<EvidencePlayerHandle, ReadyProps>(function ReadyPlayer(props, ref) {
  const { info, evidenceId, hideControls, markers, overlays } = props;
  const { can } = useAuth();
  const toast = useToast();
  const snapshot = useCreateSnapshot(evidenceId);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tokenRef = useRef<string | null>(tokenFrom(info.mp4Url));
  const infoRef = useRef(info);
  infoRef.current = info;
  const refetchRef = useRef(props.refetch);
  refetchRef.current = props.refetch;
  const onTimeRef = useRef(props.onTimeUpdate);
  onTimeRef.current = props.onTimeUpdate;
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;
  const nativeRef = useRef(false);
  const readyFired = useRef(false);
  const initialRef = useRef(props.initialTimeMs ?? 0);

  const [sourceMode, setSourceMode] = useState<'hls' | 'mp4'>(info.hlsUrl ? 'hls' : 'mp4');
  const [reloadKey, setReloadKey] = useState(0);
  const [time, setTime] = useState(props.initialTimeMs ?? 0);
  const [duration, setDuration] = useState<number>(info.durationMs ?? 0);
  const [paused, setPaused] = useState(true);
  const [rate, setRateState] = useState(1);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState({ z: 1, x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [help, setHelp] = useState(false);
  const [cues, setCues] = useState<SpriteCue[]>([]);
  const [hover, setHover] = useState<{ ms: number; x: number; width: number } | null>(null);
  const fps = info.frameRate ?? null;
  const frameMs = fps ? 1000 / fps : 40;
  const aspect = info.width && info.height ? info.width / info.height : 16 / 9;

  // ---- source attachment ------------------------------------------------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    const i = infoRef.current;
    const startSec = Math.max(0, initialRef.current / 1000);
    let hls: Hls | null = null;
    const applyStart = () => {
      if (startSec > 0) video.currentTime = startSec;
    };
    if (sourceMode === 'hls' && i.hlsUrl && Hls.isSupported()) {
      nativeRef.current = false;
      hls = new Hls({
        startPosition: startSec,
        maxBufferLength: 30,
        // Re-sign every playlist/segment request with the CURRENT token (tokens rotate before expiry).
        xhrSetup: (xhr, url) => {
          xhr.open('GET', withToken(url, tokenRef.current), true);
        },
      });
      let recovering = false;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal || !hls) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recovering) {
          recovering = true;
          void refetchRef.current().then(() => {
            recovering = false;
            hls?.startLoad();
          });
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          setError('The adaptive stream could not be played.');
        }
      });
      hls.loadSource(i.hlsUrl);
      hls.attachMedia(video);
    } else {
      nativeRef.current = true;
      const src = sourceMode === 'hls' && i.hlsUrl && video.canPlayType('application/vnd.apple.mpegurl') ? i.hlsUrl : i.mp4Url!;
      video.src = src;
      video.addEventListener('loadedmetadata', applyStart, { once: true });
    }
    return () => {
      // Keep the position across source switches (only once media has loaded; StrictMode re-mounts must
      // not overwrite the requested initial time).
      if (video.readyState > 0) initialRef.current = video.currentTime * 1000;
      video.removeEventListener('loadedmetadata', applyStart);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [sourceMode, evidenceId, reloadKey]);

  // ---- token rotation (keeps position) ------------------------------------------------------
  useEffect(() => {
    const next = tokenFrom(info.mp4Url);
    if (!next || next === tokenRef.current) return;
    tokenRef.current = next;
    const video = videoRef.current;
    if (!video || !nativeRef.current) return; // hls.js re-signs requests itself
    const t = video.currentTime;
    const wasPaused = video.paused;
    const r = video.playbackRate;
    const src = sourceMode === 'hls' && info.hlsUrl && video.canPlayType('application/vnd.apple.mpegurl') ? info.hlsUrl : info.mp4Url!;
    video.src = src;
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = t;
      video.playbackRate = r;
      if (!wasPaused) void video.play().catch(() => undefined);
    }, { once: true });
  }, [info.mp4Url, info.hlsUrl, sourceMode]);

  // ---- clock ---------------------------------------------------------------------------------
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      const ms = v.currentTime * 1000;
      setTime(ms);
      onTimeRef.current?.(ms);
      if (!v.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPaused(false);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPaused(true);
      cancelAnimationFrame(raf);
      tick();
    };
    const onMeta = () => {
      if (Number.isFinite(v.duration)) setDuration(v.duration * 1000);
      v.playbackRate = v.defaultPlaybackRate;
      if (!readyFired.current) {
        readyFired.current = true;
        onReadyRef.current?.(infoRef.current);
      }
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    const onError = () => {
      if (v.error && nativeRef.current) setError(v.error.message || 'The video could not be played.');
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', tick);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onPlaying);
    v.addEventListener('error', onError);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', tick);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onPlaying);
      v.removeEventListener('error', onError);
    };
  }, []);

  // ---- sprite thumbnails ------------------------------------------------------------------------
  const vttUrl = info.spriteVttUrl;
  const hasVtt = !!vttUrl;
  useEffect(() => {
    if (!hasVtt || !vttUrl) return;
    let cancelled = false;
    fetch(vttUrl, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => !cancelled && setCues(t ? parseSpriteVtt(t, vttUrl) : []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // fetched once per evidence item; image tokens are re-signed at render time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidenceId, hasVtt]);

  // ---- controls API -------------------------------------------------------------------------
  const durMs = duration || info.durationMs || 0;
  const clampMs = useCallback((ms: number) => Math.max(0, Math.min(durMs || Number.MAX_SAFE_INTEGER, ms)), [durMs]);
  const seek = useCallback((ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = clampMs(ms) / 1000;
    setTime(clampMs(ms));
  }, [clampMs]);
  const play = useCallback(() => void videoRef.current?.play().catch(() => undefined), []);
  const pause = useCallback(() => videoRef.current?.pause(), []);
  const setRate = useCallback((r: number) => {
    const v = videoRef.current;
    if (v) {
      v.playbackRate = r;
      v.defaultPlaybackRate = r;
    }
    setRateState(r);
  }, []);
  const stepFrame = useCallback((n: number) => {
    const v = videoRef.current;
    if (!v || !fps) return;
    v.pause();
    const lastFrame = Math.max(0, Math.ceil(((durMs || v.duration * 1000) * fps) / 1000 - 1e-6) - 1);
    const cur = frameOf(v.currentTime * 1000, fps) ?? 0;
    const target = Math.max(0, Math.min(lastFrame, cur + n));
    v.currentTime = target / fps + 0.001;
    setTime(v.currentTime * 1000);
  }, [fps, durMs]);
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) play();
    else pause();
  }, [play, pause]);

  useImperativeHandle(ref, () => ({
    seek, play, pause, setRate, stepFrame,
    getTime: () => (videoRef.current ? videoRef.current.currentTime * 1000 : 0),
    getDuration: () => durMs || null,
    getFrameRate: () => fps,
    isPaused: () => videoRef.current?.paused ?? true,
  }), [seek, play, pause, setRate, stepFrame, durMs, fps]);

  // ---- zoom / pan -----------------------------------------------------------------------------
  const clampPan = useCallback((z: number, x: number, y: number) => {
    const el = stageRef.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    return { z, x: Math.min(0, Math.max(w - w * z, x)), y: Math.min(0, Math.max(h - h * z, y)) };
  }, []);
  /** Multiply the zoom by `factor` around (cx, cy) in stage pixels (default: centre). */
  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    setZoom((cur) => {
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cur.z * factor));
      const el = stageRef.current;
      const px = cx ?? (el?.clientWidth ?? 0) / 2;
      const py = cy ?? (el?.clientHeight ?? 0) / 2;
      const ux = (px - cur.x) / cur.z;
      const uy = (py - cur.y) / cur.z;
      return clampPan(z, px - ux * z, py - uy * z);
    });
  }, [clampPan]);
  const resetZoom = useCallback(() => setZoom({ z: 1, x: 0, y: 0 }), []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setZoom((cur) => {
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cur.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const ux = (px - cur.x) / cur.z;
        const uy = (py - cur.y) / cur.z;
        return clampPan(z, px - ux * z, py - uy * z);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clampPan]);

  const drag = useRef<{ sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { sx: e.clientX, sy: e.clientY, x: zoom.x, y: zoom.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved && zoom.z > 1) setZoom((cur) => clampPan(cur.z, d.x + dx, d.y + dy));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) togglePlay();
  };

  // ---- fullscreen -----------------------------------------------------------------------------
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    resetZoom();
  }, [fullscreen, resetZoom]);

  // ---- snapshot -------------------------------------------------------------------------------
  const canSnapshot = can('evidence:snapshot');
  const takeSnapshot = useCallback(() => {
    const v = videoRef.current;
    if (!v || !canSnapshot || snapshot.isPending) return;
    v.pause();
    const ms = v.currentTime * 1000;
    snapshot.mutate({ timeMs: ms, source: 'proxy' }, {
      onSuccess: (s) => toast.success(`Snapshot saved — frame ${s.frameNumber ?? '?'} at ${formatTimecode(s.frameTimeMs ?? ms)}`),
      onError: (e) => toast.error(errorMessage(e)),
    });
  }, [canSnapshot, snapshot, toast]);

  // ---- keyboard -------------------------------------------------------------------------------
  const rateStep = (dir: 1 | -1) => {
    const idx = RATES.findIndex((r) => r >= rate - 1e-9);
    const next = RATES[Math.max(0, Math.min(RATES.length - 1, (idx < 0 ? RATES.length - 1 : idx) + dir))]!;
    setRate(next);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === ' ' || k === 'k') {
      if (t.tagName === 'BUTTON' && k === ' ') return; // let buttons activate normally
      togglePlay();
    } else if (k === 'ArrowLeft') {
      if (e.shiftKey) seek((videoRef.current?.currentTime ?? 0) * 1000 - 5000);
      else stepFrame(-1);
    } else if (k === 'ArrowRight') {
      if (e.shiftKey) seek((videoRef.current?.currentTime ?? 0) * 1000 + 5000);
      else stepFrame(1);
    } else if (k === '[') rateStep(-1);
    else if (k === ']') rateStep(1);
    else if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(1 / 1.25);
    else if (k === '0') resetZoom();
    else if (k === 's' || k === 'S') takeSnapshot();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === '?') setHelp((h) => !h);
    else if (k === 'Escape' && help) setHelp(false);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---- seek bar hover preview -----------------------------------------------------------------
  const onBarMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setHover({ ms: f * durMs, x: e.clientX - r.left, width: r.width });
  };
  const hoverCue = hover && cues.length ? cueAt(cues, hover.ms) : null;
  const frame = frameOf(time, fps);
  const sortedMarkers = useMemo(() => (markers ?? []).filter((m) => m.timeMs >= 0).sort((a, b) => a.timeMs - b.timeMs), [markers]);

  const stageHeight = fullscreen ? 'calc(100vh - 6.5rem)' : props.maxHeight ?? '70vh';
  const btn = 'inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-ink-100 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 disabled:opacity-40';

  return (
    <div
      ref={rootRef}
      className={clsx('relative flex flex-col rounded-lg bg-ink-950 text-ink-100 outline-none focus-visible:ring-2 focus-visible:ring-brand-500', fullscreen && 'h-screen justify-center rounded-none', props.className)}
      tabIndex={0}
      role="region"
      aria-label={props.label ? `Evidence video player: ${props.label}` : 'Evidence video player'}
      aria-keyshortcuts="Space ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight [ ] + - 0 s f ?"
      onKeyDown={onKeyDown}
    >
      <div className="flex w-full justify-center overflow-hidden">
        <div
          ref={stageRef}
          className={clsx('relative select-none overflow-hidden bg-black', zoom.z > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')}
          style={{ width: `min(100%, calc(${stageHeight} * ${aspect}))`, aspectRatio: `${aspect}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={toggleFullscreen}
        >
          <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.z})` }}>
            <video
              ref={videoRef}
              className="pointer-events-none h-full w-full"
              style={{ objectFit: 'fill' }}
              poster={info.posterUrl ? withToken(info.posterUrl, tokenRef.current) : undefined}
              playsInline
              muted={props.muted}
              preload="auto"
              aria-label="Evidence video"
            />
            {overlays && <div className="pointer-events-none absolute inset-0">{overlays}</div>}
          </div>
          {buffering && !paused && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-white/80" aria-label="Buffering" />
            </div>
          )}
          {zoom.z > 1 && <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs">{zoom.z.toFixed(1)}×</div>}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 p-4 text-center text-sm" role="alert">
              <p>{error}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
                {sourceMode === 'hls' && <Button size="sm" variant="secondary" onClick={() => setSourceMode('mp4')}>Use MP4 proxy</Button>}
              </div>
            </div>
          )}
        </div>
      </div>

      {!hideControls && (
        <div className="space-y-1 px-3 pb-2 pt-1">
          {/* seek bar with sprite preview + markers */}
          <div className="relative pt-2" onMouseMove={onBarMove} onMouseLeave={() => setHover(null)}>
            {hover && (
              <div className="pointer-events-none absolute bottom-full z-10 mb-1 flex flex-col items-center" style={{ left: Math.max(0, Math.min(hover.width - (hoverCue?.w ?? 80), hover.x - (hoverCue?.w ?? 80) / 2)) }}>
                {hoverCue && (
                  <div
                    className="rounded border border-white/40 bg-black shadow"
                    style={{ width: hoverCue.w, height: hoverCue.h, backgroundImage: `url("${withToken(hoverCue.url, tokenRef.current)}")`, backgroundPosition: `-${hoverCue.x}px -${hoverCue.y}px`, backgroundRepeat: 'no-repeat' }}
                  />
                )}
                <span className="mono mt-0.5 rounded bg-black/80 px-1 text-[11px]">{formatTimecode(hover.ms)}</span>
              </div>
            )}
            {sortedMarkers.length > 0 && durMs > 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-2">
                {sortedMarkers.map((m, i) => (
                  <button
                    key={`${m.timeMs}-${i}`}
                    type="button"
                    className="pointer-events-auto absolute top-0 h-2.5 w-1.5 -translate-x-1/2 rounded-sm"
                    style={{ left: `${(Math.min(m.timeMs, durMs) / durMs) * 100}%`, backgroundColor: m.color ?? '#f59e0b' }}
                    title={`${m.label} — ${formatTimecode(m.timeMs)}`}
                    aria-label={`Marker: ${m.label} at ${formatTimecode(m.timeMs)}`}
                    onClick={() => seek(m.timeMs)}
                  />
                ))}
              </div>
            )}
            <input
              type="range"
              min={0}
              max={Math.max(1, durMs)}
              step={frameMs}
              value={Math.min(time, durMs || time)}
              onChange={(e) => seek(Number(e.target.value))}
              className="h-2 w-full cursor-pointer accent-brand-500"
              aria-label="Seek"
              aria-valuetext={`${formatTimecode(time)}${frame !== null ? `, frame ${frame}` : ''}`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <button type="button" className={btn} onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (Space)' : 'Pause (Space)'}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
            <button type="button" className={btn} onClick={() => seek(time - 5000)} aria-label="Back 5 seconds" title="Back 5 s (Shift+←)"><Rewind className="h-4 w-4" /></button>
            <button type="button" className={btn} onClick={() => stepFrame(-1)} disabled={!fps} aria-label="Previous frame" title="Previous frame (←)"><StepBack className="h-4 w-4" /></button>
            <button type="button" className={btn} onClick={() => stepFrame(1)} disabled={!fps} aria-label="Next frame" title="Next frame (→)"><StepForward className="h-4 w-4" /></button>
            <button type="button" className={btn} onClick={() => seek(time + 5000)} aria-label="Forward 5 seconds" title="Forward 5 s (Shift+→)"><FastForward className="h-4 w-4" /></button>
            <span className="mono ml-1 whitespace-nowrap text-xs tabular-nums" aria-live="off">
              {formatTimecode(time)} / {formatTimecode(durMs)}
              {frame !== null && <span className="ml-2 text-ink-300">F {frame}</span>}
            </span>
            <span className="flex-1" />
            <label className="sr-only" htmlFor={`rate-${evidenceId}`}>Playback rate</label>
            <select id={`rate-${evidenceId}`} value={rate} onChange={(e) => setRate(Number(e.target.value))} className="h-8 rounded bg-white/10 px-1 text-xs text-ink-100" title="Playback rate ([ / ])">
              {RATES.map((r) => <option key={r} value={r} className="text-ink-900">{r}×</option>)}
            </select>
            <button type="button" className={btn} onClick={() => zoomBy(1 / 1.25)} disabled={zoom.z <= MIN_ZOOM} aria-label="Zoom out" title="Zoom out (−)"><ZoomOut className="h-4 w-4" /></button>
            <span className="w-10 text-center text-xs tabular-nums">{Math.round(zoom.z * 100)}%</span>
            <button type="button" className={btn} onClick={() => zoomBy(1.25)} disabled={zoom.z >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in (+)"><ZoomIn className="h-4 w-4" /></button>
            <button type="button" className={btn} onClick={resetZoom} disabled={zoom.z === 1} aria-label="Reset zoom" title="Reset zoom (0)"><RotateCcw className="h-4 w-4" /></button>
            {info.hlsUrl && (
              <>
                <label className="sr-only" htmlFor={`src-${evidenceId}`}>Playback source</label>
                <select id={`src-${evidenceId}`} value={sourceMode} onChange={(e) => setSourceMode(e.target.value as 'hls' | 'mp4')} className="h-8 rounded bg-white/10 px-1 text-xs text-ink-100" title="Playback source">
                  <option value="hls" className="text-ink-900">Adaptive</option>
                  <option value="mp4" className="text-ink-900">Proxy MP4</option>
                </select>
              </>
            )}
            {canSnapshot && (
              <button type="button" className={btn} onClick={takeSnapshot} disabled={snapshot.isPending} aria-label="Take snapshot of current frame" title="Snapshot (S)">
                {snapshot.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              </button>
            )}
            <div className="relative">
              <button type="button" className={btn} onClick={() => setHelp((h) => !h)} aria-label="Keyboard shortcuts" aria-expanded={help} title="Keyboard shortcuts (?)"><Keyboard className="h-4 w-4" /></button>
              {help && <ShortcutHelp onClose={() => setHelp(false)} />}
            </div>
            <button type="button" className={btn} onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title="Fullscreen (F)">
              {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

const SHORTCUTS: Array<[string, string]> = [
  ['Space / K', 'Play / pause'],
  ['← / →', 'Previous / next frame'],
  ['Shift + ← / →', 'Back / forward 5 seconds'],
  ['[ / ]', 'Slower / faster'],
  ['+ / −', 'Zoom in / out (or mouse wheel)'],
  ['0', 'Reset zoom'],
  ['Drag', 'Pan when zoomed'],
  ['S', 'Snapshot current frame'],
  ['F', 'Fullscreen'],
  ['?', 'Show / hide this help'],
];

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Keyboard shortcuts" className="absolute bottom-full right-0 z-20 mb-2 w-72 rounded-md border border-white/10 bg-ink-900 p-3 text-xs shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">Keyboard shortcuts</span>
        <button type="button" onClick={onClose} className="rounded px-1 hover:bg-white/10" aria-label="Close shortcuts help">×</button>
      </div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="mono text-ink-300">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-ink-400">Click the player first so it has keyboard focus.</p>
    </div>
  );
}

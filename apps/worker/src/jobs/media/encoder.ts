/**
 * H.264 encoder selection for the media pipeline (EXT-9). MEDIA_ENCODER picks libx264 (default, CPU) or a hardware
 * encoder: h264_nvenc (NVIDIA), h264_qsv (Intel Quick Sync), h264_vaapi (Intel/AMD VA-API). The choice is probed
 * once per process: the encoder must be compiled into FFmpeg (`ffmpeg -encoders`) AND a two-frame test encode on the
 * device must succeed; otherwise the pipeline falls back to libx264 and logs why. Output settings are kept equivalent
 * (CFR, GOP <= 1 s, no scene-cut keyframes, yuv420p/nv12) so the player and frame-accurate seeking behave the same.
 * Hardware paths are UNVERIFIED on real GPUs (no GPU on the development host) — see docs/VIDEO-PIPELINE.md#encoders.
 */
import { ffmpeg, type AppConfig } from '@ksp/core';

export type EncoderName = AppConfig['MEDIA_ENCODER'];
export interface EncoderChoice {
  requested: EncoderName;
  encoder: EncoderName;
  fallbackReason: string | null;
  hwDevice: string | null;
}

/** Global FFmpeg options that must precede the input (hardware device). */
export function encoderGlobalArgs(e: EncoderChoice): string[] {
  return e.encoder === 'h264_vaapi' ? ['-vaapi_device', e.hwDevice ?? '/dev/dri/renderD128'] : [];
}

/** Last filter(s) of every video chain: pixel format (and upload to the device for VA-API). */
export function encoderFormatFilter(e: Pick<EncoderChoice, 'encoder'>): string {
  if (e.encoder === 'h264_vaapi') return 'format=nv12,hwupload';
  if (e.encoder === 'h264_qsv') return 'format=nv12';
  return 'format=yuv420p';
}

/** Video codec options: constant quality ~CRF 23, fixed GOP, no scene-cut keyframes. */
export function encoderArgs(e: Pick<EncoderChoice, 'encoder'>, gop: number): string[] {
  const g = String(gop);
  switch (e.encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-g', g, '-no-scenecut', '1', '-forced-idr', '1', '-bf', '0', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-look_ahead', '0', '-g', g, '-idr_interval', '0', '-bf', '0'];
    case 'h264_vaapi':
      return ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '23', '-g', g, '-bf', '0', '-idr_interval', '0'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', g, '-keyint_min', g, '-sc_threshold', '0'];
  }
}

const cache = new Map<string, Promise<EncoderChoice>>();

/** Probe the configured encoder once (per encoder + device); never throws — falls back to libx264. */
export function resolveEncoder(cfg: Pick<AppConfig, 'MEDIA_ENCODER' | 'MEDIA_HW_DEVICE'>, log?: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }): Promise<EncoderChoice> {
  const key = `${cfg.MEDIA_ENCODER}|${cfg.MEDIA_HW_DEVICE}`;
  let p = cache.get(key);
  if (!p) {
    p = probeEncoder(cfg.MEDIA_ENCODER, cfg.MEDIA_HW_DEVICE).then((c) => {
      if (c.fallbackReason) log?.warn({ requested: c.requested, reason: c.fallbackReason }, `MEDIA_ENCODER ${c.requested} unavailable, using libx264`);
      else if (c.encoder !== 'libx264') log?.info({ encoder: c.encoder }, 'hardware H.264 encoder in use');
      return c;
    });
    cache.set(key, p);
  }
  return p;
}

export function resetEncoderCache(): void {
  cache.clear();
}

export async function probeEncoder(requested: EncoderName, hwDevice: string): Promise<EncoderChoice> {
  const cpu: EncoderChoice = { requested, encoder: 'libx264', fallbackReason: null, hwDevice: null };
  if (requested === 'libx264') return cpu;
  let list = '';
  try {
    list = (await ffmpeg(['-encoders'], { timeoutMs: 20_000 })).stdout;
  } catch (e) {
    return { ...cpu, fallbackReason: `ffmpeg -encoders failed: ${(e as Error).message.slice(0, 200)}` };
  }
  if (!new RegExp(`^\\s*V\\S*\\s+${requested}\\b`, 'm').test(list)) return { ...cpu, fallbackReason: `${requested} is not compiled into this FFmpeg build` };
  const choice: EncoderChoice = { requested, encoder: requested, fallbackReason: null, hwDevice: requested === 'h264_nvenc' ? null : hwDevice };
  try {
    await ffmpeg([...encoderGlobalArgs(choice), '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=25:d=0.2', '-vf', encoderFormatFilter(choice), ...encoderArgs(choice, 25), '-frames:v', '2', '-f', 'null', '-'], { timeoutMs: 30_000 });
  } catch (e) {
    return { ...cpu, fallbackReason: `${requested} test encode failed (device/driver): ${(e as Error).message.split('\n').slice(-2).join(' ').slice(0, 300)}` };
  }
  return choice;
}

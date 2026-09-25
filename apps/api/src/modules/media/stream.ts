/** Streaming S3 objects to the client with single-range support (206 / Content-Range / Accept-Ranges). */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { Storage } from '@ksp/core';
import { AppError } from '../../lib/errors.js';

export const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  vtt: 'text/vtt; charset=utf-8',
};

export function contentTypeFor(key: string, fallback = 'application/octet-stream'): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? fallback;
}

/** Accept only a single `bytes=a-b` / `bytes=a-` / `bytes=-n` range; anything else is ignored (full body). */
export function parseRange(h: string | undefined): string | undefined {
  if (!h) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  return h.trim();
}

export async function sendObject(
  storage: Storage,
  req: FastifyRequest,
  reply: FastifyReply,
  obj: { bucket: string; key: string; versionId?: string | null; contentType: string },
  extraHeaders: Record<string, string> = {},
): Promise<FastifyReply> {
  const range = parseRange(req.headers.range);
  let out;
  try {
    out = await storage.get(obj.bucket, obj.key, range, obj.versionId ?? undefined);
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.$metadata?.httpStatusCode === 416 || e.name === 'InvalidRange') {
      const head = await storage.head(obj.bucket, obj.key);
      reply.header('Content-Range', `bytes */${head?.ContentLength ?? 0}`);
      throw new AppError(416, 'RANGE_NOT_SATISFIABLE', 'Requested range not satisfiable');
    }
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) throw new AppError(404, 'NOT_FOUND', 'Media not found');
    throw err;
  }
  reply.header('Content-Type', obj.contentType);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extraHeaders)) reply.header(k, v);
  if (out.ContentLength !== undefined) reply.header('Content-Length', String(out.ContentLength));
  if (range && out.ContentRange) {
    reply.header('Content-Range', out.ContentRange);
    reply.status(206);
  }
  return reply.send(out.Body as Readable);
}

/**
 * Rewrite an HLS playlist so every URI (segment / child playlist lines and URI="…" attributes) carries the
 * media token. URIs are relative to the playlist, so they stay under /media/stream/<evidenceId>/hls/.
 */
export function rewritePlaylist(text: string, token: string): string {
  const q = `t=${encodeURIComponent(token)}`;
  const add = (uri: string) => (/^[a-z]+:/i.test(uri) || uri.startsWith('/') ? uri : `${uri}${uri.includes('?') ? '&' : '?'}${q}`);
  return text
    .split('\n')
    .map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${add(u)}"`);
      return add(l);
    })
    .join('\n');
}

/** Rewrite the sprite WebVTT so image references carry the token (query must precede the #xywh fragment). */
export function rewriteVtt(text: string, token: string): string {
  const q = `t=${encodeURIComponent(token)}`;
  return text.replace(/^([A-Za-z0-9_.-]+\.jpg)(#xywh=\d+,\d+,\d+,\d+)$/gm, (_m, f: string, frag: string) => `${f}?${q}${frag}`);
}

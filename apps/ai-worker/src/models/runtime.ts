/** ONNX Runtime session cache. Artefacts are verified against the registered SHA-256 before first use. */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { loadConfig } from '@ksp/core';

export { ort };

const sessions = new Map<string, Promise<ort.InferenceSession>>();

/** `models://<file>` is relative to AI_MODELS_DIR; absolute paths are used as-is. */
export function resolveArtifact(uri: string): string {
  const dir = resolve(loadConfig().AI_MODELS_DIR);
  if (uri.startsWith('models://')) return resolve(dir, uri.slice('models://'.length));
  if (uri.startsWith('file:')) return resolve(uri.slice(5));
  return isAbsolute(uri) ? uri : resolve(dir, uri);
}

export async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export class ModelArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelArtifactError';
  }
}

const threads = Math.max(1, Number(process.env.AI_INTRA_OP_THREADS ?? 4));

export function getSession(uri: string, sha256: string | null): Promise<ort.InferenceSession> {
  const key = `${uri}#${sha256 ?? ''}`;
  let s = sessions.get(key);
  if (!s) {
    s = (async () => {
      const path = resolveArtifact(uri);
      if (!existsSync(path)) throw new ModelArtifactError(`model artefact missing: ${uri} (run npm run fetch-models -w @ksp/ai-worker)`);
      if (!sha256) throw new ModelArtifactError(`model artefact ${uri} has no registered SHA-256; refusing to load`);
      const actual = await fileSha256(path);
      if (actual !== sha256) throw new ModelArtifactError(`model artefact ${uri} SHA-256 mismatch (expected ${sha256}, got ${actual})`);
      return ort.InferenceSession.create(path, { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    })();
    s.catch(() => sessions.delete(key));
    sessions.set(key, s);
  }
  return s;
}

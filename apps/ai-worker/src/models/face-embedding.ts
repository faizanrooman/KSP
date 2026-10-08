import type { AiTask } from '@ksp/shared';
import type { RgbImage } from '../image.js';
import type { SfaceEmbedder } from './sface.js';
import type { Detector, RawDetection } from './types.js';

/**
 * Wraps a face detector and attaches an L2-normalised embedding (from the active recognition model) to every face
 * large enough to embed. Used for FACE_DETECTION runs so a later suspect search can match against all stored faces.
 */
export class FaceEmbeddingDetector implements Detector {
  readonly task: AiTask;
  readonly modelId: string;
  readonly code: string;
  readonly version: string;
  constructor(
    private readonly inner: Detector,
    private readonly embedder: SfaceEmbedder,
    private readonly faceModelId: string,
  ) {
    this.task = inner.task;
    this.modelId = inner.modelId;
    this.code = inner.code;
    this.version = inner.version;
  }

  async load(): Promise<void> {
    await Promise.all([this.inner.load(), this.embedder.load()]);
  }

  async detect(frame: RgbImage, threshold: number): Promise<RawDetection[]> {
    const faces = await this.inner.detect(frame, threshold);
    for (const f of faces) {
      if (!f.landmarks || f.box.x2 - f.box.x1 < 20) continue;
      f.embedding = Array.from(await this.embedder.embed(frame, f.landmarks));
      f.attributes = { ...(f.attributes ?? {}), faceModelId: this.faceModelId };
    }
    return faces;
  }
}

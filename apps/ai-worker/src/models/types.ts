import type { AiTask } from '@ksp/shared';
import type { Box, RgbImage } from '../image.js';

/** Row of ai_models as the worker sees it. */
export interface ModelRow {
  id: string;
  code: string;
  name: string;
  task: AiTask;
  version: string;
  runtime: string;
  artifact_uri: string;
  artifact_sha256: string | null;
  labels: string[];
  default_threshold: number;
  config: ModelConfig;
  status: string;
}

export interface ModelConfig {
  architecture: 'yolox' | 'yunet' | 'sface' | 'yolov9-plate+cct-ocr' | 'rules';
  inputWidth?: number;
  inputHeight?: number;
  nmsIou?: number;
  /** YOLOX: restrict emitted labels (PERSON_DETECTION uses ['person']). */
  emitLabels?: string[];
  /** Labels that get a dominant-colour attribute. */
  colorLabels?: string[];
  /** ANPR OCR sub-model. */
  ocr?: { artifactUri: string; sha256: string; inputWidth: number; inputHeight: number; alphabet: string; padChar: string; slots: number };
  /** CLASSIFICATION rules. */
  rules?: { vehicleLabels: string[]; weaponLabels: string[]; crowdMinPersons: number; minTrackDetections: number };
  licence?: string;
  sourceUrl?: string;
  [k: string]: unknown;
}

export interface RawDetection {
  label: string;
  confidence: number;
  /** Pixel box on the analysed frame. */
  box: Box;
  landmarks?: number[];
  attributes: Record<string, unknown>;
  embedding?: number[];
  /** Key used by the tracker to associate detections across frames (defaults to label). */
  trackClass?: string;
}

/** A per-task detector running one or more ONNX models on a decoded frame. */
export interface Detector {
  readonly task: AiTask;
  readonly modelId: string;
  readonly code: string;
  readonly version: string;
  load(): Promise<void>;
  detect(frame: RgbImage, threshold: number): Promise<RawDetection[]>;
}

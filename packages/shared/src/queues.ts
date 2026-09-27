/**
 * Queue & event contracts (pg-boss queues, Postgres-backed). Producers: API. Consumers: apps/worker.
 * The AI worker does NOT use pg-boss: it claims rows from ai_jobs directly (SKIP LOCKED) as ksp_ai,
 * woken by NOTIFY on channel AI_JOBS_CHANNEL.
 */
export const QUEUES = {
  /** Upload finished: validate (ffprobe), hash SHA-256/512, dedupe, move to immutable storage, register. */
  INGEST_FINALIZE: 'ingest.finalize',
  /** Registered evidence: proxy MP4, HLS renditions, thumbnails, sprite. */
  MEDIA_PROCESS: 'media.process',
  /** Build a court export package (zip + manifest + signature + fact sheet). */
  EXPORT_BUILD: 'export.build',
  /** Generate a report run. */
  REPORT_BUILD: 'report.build',
  /** Re-hash an original and compare to its registered hash. */
  FIXITY_CHECK: 'integrity.fixity',
  /** Execute an approved disposal. */
  DISPOSAL_EXECUTE: 'lifecycle.dispose',
  /** Move evidence between storage tiers. */
  TIER_MIGRATE: 'lifecycle.tier',
  /** Export reviewed AI detections as a labelled training dataset. */
  AI_TRAINING_EXPORT: 'ai.training_export',
  /** Burn the recipient watermark into a playback variant for an external share (per share + evidence). */
  SHARE_WATERMARK: 'share.watermark',
  /** Retry an external alert delivery (e-mail / webhook) with exponential backoff. */
  ALERT_DELIVER: 'alerts.deliver',
  /** Release a quarantined upload: re-hash the staged object and register it (async; UI polls). */
  QUARANTINE_RELEASE: 'ingest.release',
  /** Extract a still frame (snapshot) from an evidence video. */
  SNAPSHOT_EXTRACT: 'media.snapshot',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Scheduled (cron) jobs run by the worker. */
export const SCHEDULES = {
  'lifecycle.scan': '*/15 * * * *', // tier transitions & retention expiry candidates
  'integrity.sweep': '0 2 * * *', // nightly fixity batch (integrityPolicy coverage target)
  'uploads.expire': '*/10 * * * *',
  'alerts.evaluate': '* * * * *',
  'storage.snapshot': '*/15 * * * *',
  'audit.checkpoint': '0 * * * *',
  'shares.expire': '*/5 * * * *',
  'exports.expire': '0 * * * *',
  'reports.schedule': '*/5 * * * *', // materialise due scheduled reports
  'dr.dispose-sweep': '30 3 * * *', // delete DR-store copies of disposed evidence
} as const;

export interface IngestFinalizePayload { uploadSessionId: string }
export interface MediaProcessPayload { evidenceId: string; force?: boolean }
export interface ExportBuildPayload { exportId: string }
export interface ReportBuildPayload { reportRunId: string }
export interface FixityCheckPayload {
  evidenceId: string;
  trigger: 'SCHEDULED' | 'ON_DEMAND' | 'EXPORT' | 'TIER_MIGRATION' | 'RESTORE';
  requestedBy?: string;
  /** Verify a secondary copy instead of the current one: evidence_storage_copies (RETAINED) or dr_object_copies (DR) id. */
  copy?: { kind: 'RETAINED' | 'DR'; id: number };
}
export interface DisposalExecutePayload { disposalRequestId: string }
export interface TierMigratePayload { evidenceId: string; targetTier: 'ACTIVE' | 'ARCHIVE' | 'LONG_TERM' }
export interface ShareWatermarkPayload { shareId: string; evidenceId: string }
export interface AlertDeliverPayload { alertId: string; channel: 'WEBHOOK' | 'EMAIL'; attempt: number }
export interface QuarantineReleasePayload { uploadSessionId: string; requestId: string }
export interface SnapshotExtractPayload { snapshotRequestId: string }
export interface AiTrainingExportPayload { trainingExportId: string }

export const AI_JOBS_CHANNEL = 'ksp_ai_jobs';

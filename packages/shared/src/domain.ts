/** Domain enumerations shared by API, workers and web. Must match CHECK constraints in db/migrations. */
export const ORG_UNIT_TYPES = ['STATE', 'ZONE', 'RANGE', 'COMMISSIONERATE', 'DISTRICT', 'SUBDIVISION', 'CIRCLE', 'STATION', 'UNIT'] as const;
export type OrgUnitType = (typeof ORG_UNIT_TYPES)[number];

export const USER_STATUSES = ['PENDING', 'ACTIVE', 'LOCKED', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const DEVICE_TYPES = ['BODY_WORN_CAMERA', 'DASH_CAMERA', 'HANDHELD', 'CCTV', 'DRONE', 'OTHER'] as const;
export const DEVICE_STATUSES = ['ACTIVE', 'IN_REPAIR', 'LOST', 'RETIRED'] as const;

export const UPLOAD_STATUSES = ['INITIATED', 'UPLOADING', 'COMPLETING', 'COMPLETED', 'ABORTED', 'FAILED', 'EXPIRED'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const EVIDENCE_STATUSES = ['RECEIVED', 'VALIDATING', 'QUARANTINED', 'REJECTED', 'REGISTERED', 'DISPOSAL_PENDING', 'DISPOSED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const MEDIA_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'FAILED', 'UNSUPPORTED'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const STORAGE_TIERS = ['STAGING', 'ACTIVE', 'ARCHIVE', 'LONG_TERM'] as const;
export type StorageTier = (typeof STORAGE_TIERS)[number];

export const DERIVATIVE_KINDS = ['PROXY_MP4', 'HLS', 'THUMBNAIL', 'POSTER', 'SPRITE', 'SNAPSHOT', 'AI_FRAME', 'AI_CROP', 'WATERMARKED'] as const;
export type DerivativeKind = (typeof DERIVATIVE_KINDS)[number];

export const AI_TASKS = ['FACE_DETECTION', 'FACE_RECOGNITION', 'ANPR', 'PERSON_DETECTION', 'OBJECT_DETECTION', 'CLASSIFICATION'] as const;
export type AiTask = (typeof AI_TASKS)[number];
export const AI_JOB_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_SECOND_REVIEW'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const AI_MODEL_STATUSES = ['STAGED', 'ACTIVE', 'RETIRED'] as const;

export const CASE_STATUSES = ['OPEN', 'UNDER_INVESTIGATION', 'PENDING_TRIAL', 'IN_TRIAL', 'CLOSED', 'ARCHIVED'] as const;
export const CASE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export const FIR_STATUSES = ['REGISTERED', 'UNDER_INVESTIGATION', 'CHARGESHEETED', 'FINAL_REPORT', 'CLOSED', 'TRANSFERRED'] as const;

export const EXPORT_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED', 'REVOKED'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const SHARE_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED', 'LOCKED'] as const;

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const ALERT_RULE_CODES = [
  'UPLOAD_FAILED', 'PROCESSING_FAILED', 'STORAGE_THRESHOLD', 'INTEGRITY_FAILURE', 'EXCESSIVE_DOWNLOADS',
  'AUTH_BRUTE_FORCE', 'AUDIT_CHAIN_BROKEN', 'POLICY_VIOLATION', 'AI_FAILURE', 'QUEUE_BACKLOG',
] as const;
export type AlertRuleCode = (typeof ALERT_RULE_CODES)[number];

/** Video container/codec support matrix (validated at ingestion with ffprobe). */
export const SUPPORTED_CONTAINERS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'avi', 'mpegts', 'asf', 'flv', 'mpeg'] as const;
export const SUPPORTED_VIDEO_CODECS = ['h264', 'hevc', 'mpeg4', 'mjpeg', 'vp8', 'vp9', 'av1', 'mpeg2video', 'wmv3', 'msmpeg4v3', 'h263'] as const;
export const ALLOWED_UPLOAD_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.ts', '.mts', '.m2ts', '.3gp', '.wmv', '.asf', '.flv', '.mpg', '.mpeg'] as const;

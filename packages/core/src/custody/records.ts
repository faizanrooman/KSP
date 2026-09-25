/** Full evidence metadata record used by custody reports, export metadata files and fact sheets. */
import type { Database, Tx } from '../db/index.js';

export interface PersonRef {
  id: string;
  username: string | null;
  fullName: string;
  rank: string | null;
  designation: string | null;
  badgeNumber: string | null;
}

export interface EvidenceRecord {
  id: string;
  evidenceNumber: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  status: string;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string | null;
  sha512: string | null;
  storageTier: string;
  legalHold: boolean;
  recordedAt: string | null;
  recordedEndAt: string | null;
  incidentAt: string | null;
  registeredAt: string | null;
  createdAt: string;
  lastVerifiedAt: string | null;
  durationMs: number | null;
  locationText: string | null;
  gps: { latitude: number; longitude: number; source: string | null } | null;
  media: {
    containerFormat: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    frameRate: number | null;
    bitRate: number | null;
  };
  probeSummary: {
    formatName: string | null;
    durationSeconds: number | null;
    streams: Array<{ index: number; type: string; codec: string | null; width?: number; height?: number; frameRate?: string; sampleRate?: string; channels?: number }>;
  } | null;
  deviceMetadata: unknown;
  orgUnit: { id: string; code: string; name: string; path: string };
  uploadedBy: PersonRef | null;
  officer: PersonRef | null;
  device: { id: string; serialNumber: string; deviceType: string; make: string | null; model: string | null; firmwareVersion: string | null } | null;
  cases: Array<{ id: string; caseNumber: string; title: string; linkedAt: string }>;
}

async function person(db: Database | Tx, id: string | null): Promise<PersonRef | null> {
  if (!id) return null;
  const u = await db.selectFrom('users').select(['id', 'username', 'full_name', 'rank', 'designation', 'badge_number']).where('id', '=', id).executeTakeFirst();
  return u ? { id: u.id, username: u.username, fullName: u.full_name, rank: u.rank, designation: u.designation, badgeNumber: u.badge_number } : null;
}

export async function loadPerson(db: Database | Tx, id: string | null): Promise<PersonRef | null> {
  return person(db, id);
}

export async function loadEvidenceRecord(db: Database | Tx, id: string): Promise<EvidenceRecord | null> {
  const e = await db.selectFrom('evidence').selectAll().where('id', '=', id).executeTakeFirst();
  if (!e) return null;
  const org = await db.selectFrom('org_units').select(['id', 'code', 'name', 'path']).where('id', '=', e.org_unit_id).executeTakeFirstOrThrow();
  const dev = e.device_id
    ? await db.selectFrom('devices').select(['id', 'serial_number', 'device_type', 'make', 'model', 'firmware_version']).where('id', '=', e.device_id).executeTakeFirst()
    : undefined;
  const cases = await db
    .selectFrom('case_evidence as ce')
    .innerJoin('cases as c', 'c.id', 'ce.case_id')
    .select(['c.id', 'c.case_number', 'c.title', 'ce.linked_at'])
    .where('ce.evidence_id', '=', id)
    .where('ce.unlinked_at', 'is', null)
    .orderBy('ce.linked_at')
    .execute();
  const probe = (e.probe ?? null) as null | { format?: { format_name?: string; duration?: string }; streams?: Array<Record<string, unknown>> };
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: e.id,
    evidenceNumber: e.evidence_number,
    title: e.title,
    description: e.description,
    category: e.category,
    status: e.status,
    originalFilename: e.original_filename,
    mimeType: e.mime_type,
    sizeBytes: Number(e.size_bytes),
    sha256: e.sha256,
    sha512: e.sha512,
    storageTier: e.storage_tier,
    legalHold: e.legal_hold,
    recordedAt: iso(e.recorded_at),
    recordedEndAt: iso(e.recorded_end_at),
    incidentAt: iso(e.incident_at),
    registeredAt: iso(e.registered_at),
    createdAt: e.created_at.toISOString(),
    lastVerifiedAt: iso(e.last_verified_at),
    durationMs: e.duration_ms === null ? null : Number(e.duration_ms),
    locationText: e.location_text,
    gps: e.gps_latitude !== null && e.gps_longitude !== null ? { latitude: e.gps_latitude, longitude: e.gps_longitude, source: e.gps_source } : null,
    media: {
      containerFormat: e.container_format,
      videoCodec: e.video_codec,
      audioCodec: e.audio_codec,
      width: e.width,
      height: e.height,
      frameRate: e.frame_rate === null ? null : Number(e.frame_rate),
      bitRate: e.bit_rate === null ? null : Number(e.bit_rate),
    },
    probeSummary: probe
      ? {
          formatName: probe.format?.format_name ?? null,
          durationSeconds: probe.format?.duration ? Number(probe.format.duration) : null,
          streams: (probe.streams ?? []).map((s) => ({
            index: Number(s.index ?? 0),
            type: String(s.codec_type ?? 'unknown'),
            codec: (s.codec_name as string | undefined) ?? null,
            ...(s.width ? { width: Number(s.width), height: Number(s.height) } : {}),
            ...(s.r_frame_rate ? { frameRate: String(s.r_frame_rate) } : {}),
            ...(s.sample_rate ? { sampleRate: String(s.sample_rate) } : {}),
            ...(s.channels ? { channels: Number(s.channels) } : {}),
          })),
        }
      : null,
    deviceMetadata: e.device_metadata ?? {},
    orgUnit: { id: org.id, code: org.code, name: org.name, path: org.path },
    uploadedBy: await person(db, e.uploaded_by),
    officer: await person(db, e.officer_id),
    device: dev ? { id: dev.id, serialNumber: dev.serial_number, deviceType: dev.device_type, make: dev.make, model: dev.model, firmwareVersion: dev.firmware_version } : null,
    cases: cases.map((c) => ({ id: c.id, caseNumber: c.case_number, title: c.title, linkedAt: c.linked_at.toISOString() })),
  };
}

export function personLabel(p: PersonRef | null | undefined): string {
  if (!p) return '-';
  return [p.rank, p.fullName].filter(Boolean).join(' ') + (p.badgeNumber ? ` (badge ${p.badgeNumber})` : '') + (p.username ? ` [${p.username}]` : '');
}

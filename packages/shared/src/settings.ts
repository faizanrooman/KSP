/** Configurable system settings (DB table system_settings). Defaults apply when a key is absent. */
export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  historyCount: number; // reject reuse of the last N passwords
  maxAgeDays: number; // force change after N days (0 = never)
}
export interface LockoutPolicy {
  maxFailedAttempts: number;
  lockoutMinutes: number;
  ipMaxFailedPerWindow: number;
  windowMinutes: number;
}
export interface SessionPolicy {
  idleTimeoutMinutes: number;
  absoluteTimeoutHours: number;
  maxConcurrentSessions: number;
  requireMfaForRoles: string[]; // role codes for which MFA enrolment is mandatory
}
export interface UploadPolicy {
  maxFileSizeBytes: number;
  chunkSizeBytes: number;
  sessionTtlHours: number;
  maxConcurrentSessionsPerUser: number;
}
export interface StoragePolicy {
  warnThresholdPercent: number;
  criticalThresholdPercent: number;
  capacityBytes: number; // declared capacity for utilisation dashboards (0 = unknown)
}
export interface ShareExportPolicy {
  maxShareDays: number;
  exportRetentionDays: number;
  excessiveDownloadsPerHour: number;
}

export interface SystemSettings {
  passwordPolicy: PasswordPolicy;
  lockoutPolicy: LockoutPolicy;
  sessionPolicy: SessionPolicy;
  uploadPolicy: UploadPolicy;
  storagePolicy: StoragePolicy;
  shareExportPolicy: ShareExportPolicy;
}

export const DEFAULT_SETTINGS: SystemSettings = {
  passwordPolicy: { minLength: 12, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true, historyCount: 5, maxAgeDays: 90 },
  lockoutPolicy: { maxFailedAttempts: 5, lockoutMinutes: 15, ipMaxFailedPerWindow: 30, windowMinutes: 15 },
  sessionPolicy: {
    idleTimeoutMinutes: 30,
    absoluteTimeoutHours: 12,
    maxConcurrentSessions: 3,
    requireMfaForRoles: ['SYSTEM_ADMINISTRATOR', 'SUPERVISOR', 'AUDITOR', 'EVIDENCE_CUSTODIAN'],
  },
  uploadPolicy: { maxFileSizeBytes: 50 * 1024 ** 3, chunkSizeBytes: 16 * 1024 ** 2, sessionTtlHours: 72, maxConcurrentSessionsPerUser: 20 },
  storagePolicy: { warnThresholdPercent: 75, criticalThresholdPercent: 90, capacityBytes: 0 },
  shareExportPolicy: { maxShareDays: 30, exportRetentionDays: 30, excessiveDownloadsPerHour: 20 },
};

export type SettingKey = keyof SystemSettings;
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export function checkPasswordPolicy(password: string, policy: PasswordPolicy): string[] {
  const errors: string[] = [];
  if (password.length < policy.minLength) errors.push(`must be at least ${policy.minLength} characters`);
  if (password.length > 256) errors.push('must be at most 256 characters');
  if (policy.requireUpper && !/[A-Z]/.test(password)) errors.push('must contain an upper-case letter');
  if (policy.requireLower && !/[a-z]/.test(password)) errors.push('must contain a lower-case letter');
  if (policy.requireDigit && !/[0-9]/.test(password)) errors.push('must contain a digit');
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) errors.push('must contain a symbol');
  return errors;
}

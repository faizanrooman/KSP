export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrgRef {
  id: string;
  name: string;
  code: string;
}

export interface UserListItem {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  badgeNumber: string | null;
  rank: string | null;
  designation: string | null;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  locked: boolean;
  createdAt: string;
  homeOrgUnit: OrgRef;
  roleCodes: string[];
}

export interface RoleAssignment {
  id: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  isSystemRole: boolean;
  orgUnitId: string;
  orgUnitName: string;
  orgUnitPath: string;
  orgUnitActive: boolean;
  grantedAt: string;
  grantedBy: { id: string; fullName: string } | null;
  expiresAt: string | null;
  expired: boolean;
}

export interface UserDetail {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  badgeNumber: string | null;
  rank: string | null;
  designation: string | null;
  phone: string | null;
  status: string;
  homeOrgUnit: OrgRef & { path: string };
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  locked: boolean;
  mfaEnabled: boolean;
  mfaEnrolledAt: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  statusChangedAt: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; fullName: string } | null;
  activeSessions: number;
  roles: RoleAssignment[];
  isSelf: boolean;
  canManage: boolean;
  canManageRoles: boolean;
}

export interface SessionItem {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  mfaVerified: boolean;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  assignmentCount: number;
  totalAssignmentCount: number;
  createdAt: string;
  updatedAt: string;
  sodViolations: string[];
}

export interface PermissionCatalogue {
  groups: Array<{ category: string; label: string; permissions: Array<{ code: string; description: string }> }>;
  sodConflicts: Array<{ a: string; b: string; message: string }>;
}

export interface OrgUnit {
  id: string;
  code: string;
  name: string;
  unitType: string;
  parentId: string | null;
  path: string;
  depth: number;
  address: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  childCount: number;
  userCount: number;
  deviceCount: number;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
}

export interface Device {
  id: string;
  serialNumber: string;
  deviceType: string;
  make: string | null;
  model: string | null;
  firmwareVersion: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  orgUnit: OrgRef;
  assignedOfficer: { id: string; fullName: string; badgeNumber: string | null; username: string } | null;
  canManage: boolean;
}

export interface DeviceDetail extends Device {
  evidenceCount: number;
  history: Array<{ seq: number; occurredAt: string; action: string; actorName: string | null; details: Record<string, unknown> }>;
}

export const DEVICE_TYPES = ['BODY_WORN_CAMERA', 'DASH_CAMERA', 'HANDHELD', 'CCTV', 'DRONE', 'OTHER'] as const;
export const DEVICE_STATUSES = ['ACTIVE', 'IN_REPAIR', 'LOST', 'RETIRED'] as const;
export const UNIT_TYPES = ['ZONE', 'RANGE', 'COMMISSIONERATE', 'DISTRICT', 'SUBDIVISION', 'CIRCLE', 'STATION', 'UNIT'] as const;
export const USER_STATUSES = ['ACTIVE', 'LOCKED', 'DISABLED', 'PENDING'] as const;

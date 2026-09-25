/** Cross-cutting API contracts (HTTP). */
export interface ApiErrorBody {
  error: {
    code: string; // e.g. VALIDATION_FAILED, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, RATE_LIMITED, INTERNAL
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageQuery {
  page?: number; // 1-based
  pageSize?: number; // max 200
  sort?: string; // column name, prefix '-' for descending
}

/** Authenticated principal as returned by GET /api/v1/auth/me */
export interface MeResponse {
  user: {
    id: string;
    username: string;
    fullName: string;
    email: string | null;
    badgeNumber: string | null;
    rank: string | null;
    homeOrgUnit: { id: string; name: string; code: string };
    mfaEnabled: boolean;
    mustChangePassword: boolean;
    mfaEnrollmentRequired: boolean;
  };
  permissions: string[]; // union of all role permissions
  roles: Array<{ code: string; name: string; orgUnitId: string; orgUnitName: string }>;
  sessionId: string;
}

export const API_PREFIX = '/api/v1';
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_COOKIE = 'ksp_csrf';
export const ACCESS_COOKIE = 'ksp_at';
export const REFRESH_COOKIE = 'ksp_rt';

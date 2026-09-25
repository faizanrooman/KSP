/** Application errors mapped to the ApiErrorBody contract by the global error handler. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const validationFailed = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_FAILED', message, details);
export const unauthenticated = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action') => new AppError(403, 'FORBIDDEN', message);
/** Use notFound (not forbidden) for resources outside the caller's jurisdiction, to avoid leaking existence (IDOR). */
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const gone = (message: string) => new AppError(410, 'GONE', message);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE', message, details);
export const tooMany = (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message);

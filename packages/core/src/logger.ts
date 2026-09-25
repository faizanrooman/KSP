import { pino, type Logger } from 'pino';
import { loadConfig } from './config.js';

let root: Logger | undefined;

/** Structured JSON logger. Secrets and tokens are redacted by path. */
export function logger(): Logger {
  if (!root) {
    const cfg = loadConfig();
    root = pino({
      level: cfg.LOG_LEVEL,
      base: { service: process.env.KSP_SERVICE ?? 'ksp' },
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password',
          '*.newPassword', '*.currentPassword', '*.token', '*.refreshToken', '*.accessToken', '*.secret',
          '*.code', '*.accessCode', '*.mfaCode',
        ],
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return root;
}

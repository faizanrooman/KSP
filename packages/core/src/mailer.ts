/**
 * Outbound e-mail (SMTP via nodemailer). One transport per process, configured through the environment:
 *   ALERT_SMTP_URL    smtp://user:pass@host:587 | smtps://host:465   (unset → e-mail is "not configured")
 *   ALERT_EMAIL_FROM  "KSP VMS <no-reply@ksp.example>"               (default no-reply@<host of APP_BASE_URL>)
 *   ALERT_SMTP_TIMEOUT_MS  connection/greeting/socket timeout (default 10 s)
 *   ALERT_SMTP_TLS_REJECT_UNAUTHORIZED=false  (dev relays with self-signed certs only)
 * Used by alert delivery, scheduled report notifications and share-link delivery. Messages never carry
 * evidence content, storage keys, tokens, passwords or share access codes (except the explicit, opt-in
 * share access-code e-mail — see docs/SECURE-SHARING.md).
 */
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Optional headers (e.g. X-KSP-Alert-Id); values must not contain secrets. */
  headers?: Record<string, string>;
}

export interface Mailer {
  readonly configured: boolean;
  readonly from: string;
  send(msg: MailMessage): Promise<{ messageId: string; accepted: string[]; rejected: string[] }>;
}

const cache = new Map<string, Transporter>();

export function mailFrom(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ALERT_EMAIL_FROM?.trim();
  if (explicit) return explicit;
  let host = 'localhost';
  try {
    host = new URL(env.APP_BASE_URL ?? 'http://localhost').hostname || 'localhost';
  } catch {
    /* keep default */
  }
  return `KSP VMS <no-reply@${host}>`;
}

/** Normalise and validate a recipient list (dedupe, lower-case, drop obviously invalid addresses). */
export function cleanRecipients(list: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const a of list) {
    const v = a?.trim().toLowerCase();
    if (v && v.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(v)) out.add(v);
  }
  return [...out];
}

export function createMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const url = env.ALERT_SMTP_URL?.trim();
  const from = mailFrom(env);
  const timeout = Number(env.ALERT_SMTP_TIMEOUT_MS ?? 10_000);
  return {
    configured: !!url,
    from,
    async send(msg) {
      if (!url) throw new Error('SMTP not configured (ALERT_SMTP_URL)');
      const to = cleanRecipients(msg.to);
      if (!to.length) throw new Error('no valid recipients');
      const key = `${url}|${timeout}|${env.ALERT_SMTP_TLS_REJECT_UNAUTHORIZED ?? ''}`;
      let t = cache.get(key);
      if (!t) {
        t = nodemailer.createTransport(url, {
          connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout,
          tls: { rejectUnauthorized: env.ALERT_SMTP_TLS_REJECT_UNAUTHORIZED !== 'false' },
        } as never);
        cache.set(key, t);
      }
      // One message addressed to all recipients (staff / operations addresses).
      const info = await t.sendMail({ from, to, subject: msg.subject.replace(/[\r\n]+/g, ' ').slice(0, 250), text: msg.text, html: msg.html, headers: msg.headers });
      const norm = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String((x as { address?: string }).address ?? x))) : []);
      const rejected = norm(info.rejected);
      if (rejected.length && !norm(info.accepted).length) throw new Error(`all recipients rejected by relay`);
      return { messageId: String(info.messageId ?? ''), accepted: norm(info.accepted), rejected };
    },
  };
}

/** For tests: drop cached transports (e.g. after changing ALERT_SMTP_URL). */
export function resetMailers(): void {
  for (const t of cache.values()) t.close();
  cache.clear();
}

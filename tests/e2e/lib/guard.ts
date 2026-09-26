/**
 * Per-test runtime guard, attached to every browser context a test uses:
 *   - uncaught page errors                       -> always a failure
 *   - console.error messages                     -> failure unless allow-listed for the test
 *   - API responses >= 400 / network failures    -> failure unless declared expected (guard.expectFailure)
 *   - storage URLs / bucket names in API bodies, HLS playlists or final page HTML -> always a failure
 */
import type { BrowserContext, Page, Response } from '@playwright/test';
import { STORAGE_LEAK_PATTERNS } from './env';

export interface Problem {
  kind: 'pageerror' | 'console' | 'http' | 'network' | 'leak';
  text: string;
}

interface Expected {
  status?: number | number[];
  url: RegExp;
  method?: string;
}

/** Normal, non-error noise from an unauthenticated start (session probe + silent refresh). */
const BASELINE_EXPECTED: Expected[] = [
  { status: 401, url: /\/api\/v1\/auth\/me$/, method: 'GET' },
  { status: 401, url: /\/api\/v1\/auth\/refresh$/, method: 'POST' },
];

const TEXT_TYPES = /json|text|mpegurl|xml|javascript|html/i;

export class Guard {
  readonly problems: Problem[] = [];
  private expected: Expected[] = [...BASELINE_EXPECTED];
  private consoleAllow: RegExp[] = [];
  private watched = new WeakSet<BrowserContext>();
  private pages = new Set<Page>();
  private pending = new Set<Promise<unknown>>();
  scannedBodies = 0;

  /** Declare an API failure the test deliberately provokes (e.g. 401 on a bad password). */
  expectFailure(url: RegExp, status?: number | number[], method?: string): void {
    this.expected.push({ url, status, method });
  }

  allowConsole(re: RegExp): void {
    this.consoleAllow.push(re);
  }

  watch(context: BrowserContext): void {
    if (this.watched.has(context)) return;
    this.watched.add(context);
    context.on('page', (p) => this.watchPage(p));
    for (const p of context.pages()) this.watchPage(p);
  }

  private isExpected(url: string, status: number | undefined, method: string): boolean {
    return this.expected.some(
      (e) =>
        e.url.test(url) &&
        (e.method === undefined || e.method === method) &&
        (e.status === undefined || status === undefined || (Array.isArray(e.status) ? e.status.includes(status) : e.status === status)),
    );
  }

  private watchPage(page: Page): void {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    page.on('pageerror', (err) => this.problems.push({ kind: 'pageerror', text: `${err.name}: ${err.message}` }));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Chrome logs every non-2xx fetch as "Failed to load resource"; those are judged by the response check.
      if (/^Failed to load resource/.test(text)) return;
      if (this.consoleAllow.some((re) => re.test(text))) return;
      this.problems.push({ kind: 'console', text: `${text} @ ${msg.location().url}` });
    });
    page.on('response', (res) => {
      const p = this.onResponse(res);
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
    page.on('requestfailed', (req) => {
      const f = req.failure()?.errorText ?? '';
      // Aborted requests are normal (navigation, HLS segment cancellation, React Query cancellation, downloads).
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(f)) return;
      if (!/\/api\//.test(req.url())) return;
      if (this.isExpected(req.url(), undefined, req.method())) return;
      this.problems.push({ kind: 'network', text: `${req.method()} ${req.url()} failed: ${f}` });
    });
  }

  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    const req = res.request();
    // Location headers must not point at the object store either.
    const loc = res.headers()['location'];
    if (loc) this.scan(loc, `Location header of ${url}`);
    if (!/\/api\//.test(url) && !/\.m3u8/.test(url)) return;
    const status = res.status();
    if (status >= 400 && !this.isExpected(url, status, req.method())) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        /* body unavailable */
      }
      this.problems.push({ kind: 'http', text: `${req.method()} ${url} -> ${status} ${body}` });
    }
    const type = res.headers()['content-type'] ?? '';
    if (!TEXT_TYPES.test(type)) return;
    try {
      const text = await res.text();
      this.scannedBodies++;
      this.scan(text, `${req.method()} ${url}`);
    } catch {
      /* redirects / streamed bodies */
    }
  }

  scan(text: string, where: string): void {
    for (const re of STORAGE_LEAK_PATTERNS) {
      const m = re.exec(text);
      if (m) this.problems.push({ kind: 'leak', text: `storage reference ${JSON.stringify(m[0])} in ${where}` });
    }
  }

  /** Final checks: wait for in-flight body scans and scan each open page's HTML. */
  async finish(): Promise<Problem[]> {
    await Promise.allSettled([...this.pending]);
    for (const p of this.pages) {
      if (p.isClosed()) continue;
      try {
        this.scan(await p.content(), `HTML of ${p.url()}`);
      } catch {
        /* page navigating/closed */
      }
    }
    return this.problems;
  }
}

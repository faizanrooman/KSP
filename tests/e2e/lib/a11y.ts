import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { ARTIFACT_DIR } from './env';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export interface AxeSummary {
  page: string;
  url: string;
  violations: Array<{ id: string; impact: string | null; help: string; nodes: number; targets: string[]; wcag: boolean }>;
}

/** Wait until the SPA has rendered real content (no loading spinners). */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 20_000 });
}

/** Run axe (WCAG 2.1 A/AA rules) on the current page; writes the result to artifacts/a11y/<name>.json. */
export async function axe(page: Page, name: string, testInfo: TestInfo, opts: { include?: string } = {}): Promise<AxeSummary> {
  await settle(page);
  let builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS, 'best-practice']);
  if (opts.include) builder = builder.include(opts.include);
  const res = await builder.analyze();
  const summary: AxeSummary = {
    page: name,
    url: new URL(page.url()).pathname,
    violations: res.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')), wcag: v.tags.some((t) => WCAG_TAGS.includes(t)) })),
  };
  const dir = resolve(ARTIFACT_DIR, 'a11y');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name.replace(/[^a-z0-9]+/gi, '-')}.json`), JSON.stringify(summary, null, 2));
  await testInfo.attach(`axe-${name}`, { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
  return summary;
}

/** Serious/critical violations of WCAG 2.1 A/AA rules (best-practice findings are reported, not asserted). */
export function seriousOrCritical(s: AxeSummary): AxeSummary['violations'] {
  return s.violations.filter((v) => v.wcag && (v.impact === 'serious' || v.impact === 'critical'));
}

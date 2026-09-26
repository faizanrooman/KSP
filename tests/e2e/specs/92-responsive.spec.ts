/**
 * Responsive layout at 1280 px (desktop) and 768 px (tablet): no horizontal page scroll, navigation reachable
 * (sidebar ≥1024 px, menu button below), screenshots saved to tests/e2e/artifacts/responsive/ (not committed).
 */
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { settle } from '../lib/a11y';
import { ARTIFACT_DIR } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { getState } from '../lib/state';

const PAGES = (): Array<[string, string | undefined]> => [
  ['dashboard', '/'],
  ['evidence-list', '/evidence'],
  ['evidence-detail', getState('evidenceA') ? `/evidence/${getState('evidenceA')}` : undefined],
  ['playback', getState('evidenceA') ? `/evidence/${getState('evidenceA')}?tab=playback` : undefined],
  ['search', '/search'],
  ['upload', '/upload'],
  ['cases', '/cases'],
  ['case-detail', getState('caseId') ? `/cases/${getState('caseId')}` : undefined],
  ['workspace', getState('workspaceId') ? `/workspaces/${getState('workspaceId')}?tab=compare` : undefined],
  ['exports', '/exports'],
  ['shares', '/shares'],
];

async function overflow(page: Page) {
  return page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
}

for (const width of [1280, 768]) {
  test(`layout at ${width}px`, async ({ as }, testInfo) => {
    test.setTimeout(240_000);
    const page = await as('io.meera', { context: { viewport: { width, height: 1000 } } });
    const offenders: string[] = [];
    for (const [name, path] of PAGES()) {
      if (!path) continue;
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await settle(page);
      const o = await overflow(page);
      if (o.scroll > o.width + 1) offenders.push(`${name}: scrollWidth ${o.scroll} > ${o.width}`);
      await page.screenshot({ path: resolve(ARTIFACT_DIR, 'responsive', `${width}-${name}.png`), fullPage: true });
    }
    await testInfo.attach('overflow.json', { body: JSON.stringify(offenders, null, 2), contentType: 'application/json' });
    expect(offenders, 'no horizontal page scrolling').toEqual([]);

    const nav = page.getByRole('navigation', { name: 'Main' });
    if (width < 1024) {
      await expect(nav).toBeHidden();
      await page.getByRole('button', { name: 'Open menu' }).click();
      await expect(nav).toBeVisible();
      await nav.getByRole('link', { name: 'Search' }).click();
      await expect(page).toHaveURL(/\/search/);
      await expect(nav).toBeHidden();
    } else {
      await expect(nav).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
    }
  });
}

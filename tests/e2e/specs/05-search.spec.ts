/**
 * Scenario 5 — search: text + filters + approved-AI label filter → results → "jump to moment" opens playback at t.
 */
import { videoState } from '../lib/api';
import { expect, test } from '../lib/fixtures';
import { getState, runId } from '../lib/state';

test('text search, filters, saved search', async ({ as }) => {
  test.skip(!getState('evidenceA'), 'needs 02-upload');
  const page = await as('io.meera');
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  const results = page.getByRole('region', { name: 'Results' });
  await page.getByRole('searchbox').or(page.getByLabel('Search text')).fill(runId());
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(results).toContainText(getState('titleA')!);
  await expect(results).toContainText(getState('titleB')!);
  await expect(results).toContainText(/\d+ ms/); // timing shown

  // Words + exclusion.
  await page.getByLabel('Search text').fill(`${runId()} -traffic`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(results).toContainText(getState('titleA')!);
  await expect(results).not.toContainText(getState('titleB')!);

  // Tag filter through the advanced filters (tag added by 03-evidence).
  await page.getByLabel('Search text').fill(runId());
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /^Filters/ }).click();
  const adv = page.getByRole('region', { name: 'Advanced filters' });
  await adv.getByLabel('Tags (comma separated)').fill('night patrol');
  await adv.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('button', { name: /^Filters \(\d+\)/ })).toBeVisible();
  await expect(results).toContainText(getState('titleA')!);
  await expect(results).not.toContainText(getState('titleB')!);

  // Save the search and re-run it from the menu.
  await page.getByRole('button', { name: 'Save search' }).click();
  const dlg = page.getByRole('dialog', { name: 'Save this search' });
  await dlg.getByLabel('Name').fill(`E2E saved ${runId()}`);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Search saved' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('button', { name: 'Saved searches' }).click();
  await page.getByRole('dialog', { name: /Saved searches/ }).getByRole('button', { name: new RegExp(`^E2E saved ${runId()}`) }).click();
  await expect(results).toContainText(getState('titleA')!);
});

test('approved-AI label filter and jump to moment', async ({ as }) => {
  test.skip(!getState('evidenceAI'), 'needs the AI clip (02-upload) and review (04-ai)');
  const page = await as('io.meera');
  await page.goto('/search');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const adv = page.getByRole('region', { name: 'Advanced filters' });
  await adv.getByLabel('Objects / labels').fill('person');
  await adv.getByRole('button', { name: 'Apply filters' }).click();
  const results = page.getByRole('region', { name: 'Results' });
  const hit = results.getByRole('listitem').filter({ hasText: getState('titleAI')! });
  await expect(hit).toBeVisible();
  const moment = hit.getByRole('group', { name: 'Matching AI moments' }).getByRole('link').first();
  await expect(moment).toContainText(/person/);
  const href = (await moment.getAttribute('href'))!;
  const t = Number(new URL(href, 'http://x').searchParams.get('t'));
  await moment.click();
  await expect(page).toHaveURL(new RegExp(`/evidence/${getState('evidenceAI')}\\?tab=playback&t=${t}`));
  await expect(page.getByRole('tab', { name: 'Playback' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await videoState(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => Math.abs((await videoState(page)).t * 1000 - t), { timeout: 20_000 }).toBeLessThan(100);
});

/**
 * Scenario 7 — investigation workspace: create, add 2 items, SyncPlayer comparison with an offset change that
 * persists, bookmark + region annotation, incident timeline.
 */
import { apiGet, waitForMediaReady } from '../lib/api';
import { expect, test } from '../lib/fixtures';
import { getState, runId, setState } from '../lib/state';

test('workspace: add items, sync offsets persist, bookmark + region, timeline', async ({ as }) => {
  test.setTimeout(240_000);
  test.skip(!getState('evidenceB'), 'needs 02-upload');
  const page = await as('io.meera');
  await waitForMediaReady(page, getState('evidenceA')!);
  await waitForMediaReady(page, getState('evidenceB')!);

  await page.getByRole('link', { name: 'Workspaces' }).click();
  await page.getByRole('button', { name: /New workspace/ }).click();
  const dlg = page.getByRole('dialog', { name: 'New investigation workspace' });
  const title = `E2E workspace ${runId()}`;
  await expect(dlg.getByLabel('Title')).toBeFocused();
  await dlg.getByLabel('Title').fill(title);
  await dlg.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}/);
  const wsId = new URL(page.url()).pathname.split('/').pop()!;
  setState('workspaceId', wsId);

  await page.getByRole('button', { name: 'Add evidence' }).click();
  const picker = page.getByRole('dialog', { name: /evidence/i });
  await picker.getByLabel('Search evidence').fill(`${runId()} Clip`);
  await picker.getByRole('button', { name: 'Search' }).click();
  await picker.getByRole('checkbox', { name: new RegExp(getState<string>('titleA')!) }).check();
  await picker.getByRole('checkbox', { name: new RegExp(getState<string>('titleB')!) }).check();
  await picker.getByRole('button', { name: 'Add 2 items' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 item(s) added' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Evidence/ })).toContainText('2');

  // Compare in sync; nudge the second video's offset by +100 ms twice and check it is saved.
  await page.getByRole('tab', { name: 'Compare' }).click();
  const videos = page.getByRole('region', { name: 'Videos (up to 4)' });
  const boxes = videos.getByRole('checkbox');
  for (let i = 0; i < 2; i++) if (!(await boxes.nth(i).isChecked())) await boxes.nth(i).check();
  const transport = page.getByRole('group', { name: 'Synchronised transport' });
  await expect(transport).toBeVisible();
  await expect(page.locator('video')).toHaveCount(2);
  const plus = page.getByRole('button', { name: /offset \+100 ms$/ });
  await plus.nth(1).click();
  await plus.nth(1).click();
  await expect(page.getByText('+00:00.200').or(page.getByText('+0:00.200'))).toBeVisible();
  await expect
    .poll(async () => (await apiGet<{ items: Array<{ syncOffsetMs: number }> }>(page, `/workspaces/${wsId}/items`)).items.map((i) => i.syncOffsetMs).sort((a, b) => a - b), { timeout: 10_000 })
    .toEqual([0, 200]);
  await page.reload();
  await expect(page.getByText('+00:00.200').or(page.getByText('+0:00.200'))).toBeVisible();
  for (const v of await page.locator('video').all()) await expect.poll(() => v.evaluate((e: HTMLVideoElement) => e.readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await transport.getByRole('button', { name: 'Play all' }).click();
  await expect.poll(async () => page.locator('video').first().evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.5);
  await transport.getByRole('button', { name: 'Pause all' }).click();

  // Bookmark + region annotation on the first video.
  await page.getByRole('tab', { name: 'Review & annotate' }).click();
  await page.getByRole('textbox', { name: /^Bookmark at/ }).fill('Suspect enters frame');
  await page.getByRole('button', { name: 'Add bookmark' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Bookmark added' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bookmarks' })).toContainText('Suspect enters frame');

  await page.getByRole('button', { name: 'Region', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Drag to draw a region on the frame' });
  const b = (await canvas.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText(/Region set \(\d+% × \d+%\)/)).toBeVisible();
  await page.getByLabel('Description (optional)').fill('Vehicle of interest');
  await page.getByRole('button', { name: 'Save annotation' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Annotation saved' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Annotations' })).toContainText('Vehicle of interest');

  // Timeline shows the lanes and the bookmark in the chronology.
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByRole('list', { name: 'Timeline lanes' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Chronology' })).toContainText('Suspect enters frame');
});

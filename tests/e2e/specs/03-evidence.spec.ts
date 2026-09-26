/**
 * Scenario 3 — investigating officer: evidence list (filters, sort, pagination) → detail: Overview edit + tags,
 * Playback (HLS, play/pause, frame step, rate, zoom, snapshot), Snapshots tab, Integrity verify, Lifecycle,
 * Chain of custody + signed PDF download.
 */
import { readFileSync } from 'node:fs';
import { apiGet, videoState, waitForMediaReady } from '../lib/api';
import { expect, test } from '../lib/fixtures';
import { getState, runId } from '../lib/state';

const evA = () => getState<string>('evidenceA')!;
const evB = () => getState<string>('evidenceB')!;

test.beforeEach(() => {
  test.skip(!getState('evidenceA'), 'needs the evidence uploaded by 02-upload.spec.ts');
});

test('evidence list: search, filters, sort, pagination', async ({ as }) => {
  const page = await as('io.meera');
  await page.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Evidence', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Evidence' });

  await page.getByLabel('Search').fill(runId());
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(new RegExp(`q=${runId()}`));
  await expect(table.getByRole('row').filter({ hasText: getState('titleA')! })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: getState('titleB')! })).toBeVisible();

  await page.getByLabel('Status').selectOption('REGISTERED');
  await expect(page).toHaveURL(/status=REGISTERED/);
  await expect(table.getByRole('row').filter({ hasText: getState('titleA')! })).toBeVisible();
  await page.getByLabel('Status').selectOption('QUARANTINED');
  await expect(table.getByRole('row').filter({ hasText: 'not a video' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: getState('titleA')! })).toHaveCount(0);
  await page.getByLabel('Status').selectOption('DISPOSED');
  await expect(page.getByText('No evidence matches these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/status=/);

  // Sort by duration (ascending, then descending) — aria-sort reflects the state.
  await page.getByLabel('Search').fill(runId());
  await page.getByRole('button', { name: 'Search' }).click();
  const durationHeader = table.getByRole('columnheader', { name: /Duration/ });
  await durationHeader.getByRole('button').click();
  await expect(durationHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(page).toHaveURL(/sort=duration_ms/);
  await durationHeader.getByRole('button').click();
  await expect(durationHeader).toHaveAttribute('aria-sort', 'descending');
  // Clip A (8 s) sorts before clip B (6 s) when descending.
  const rows = table.getByRole('row');
  const order = await rows.allTextContents();
  expect(order.findIndex((t) => t.includes(getState('titleA')!))).toBeLessThan(order.findIndex((t) => t.includes(getState('titleB')!)));

  // Pagination with a small page size.
  await page.goto(`/evidence?q=${runId()}&pageSize=1&sort=-duration_ms`);
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toContainText(/1–1 of \d+/);
  await expect(pager).toContainText('Page 1 /');
  await pager.getByRole('button', { name: 'Next page' }).click();
  await expect(pager).toContainText('Page 2 /');
  await expect(page).toHaveURL(/page=2/);
  await pager.getByRole('button', { name: 'Previous page' }).click();
  await expect(pager).toContainText('Page 1 /');

  // Keyboard: rows are focusable and open with Enter.
  await page.goto(`/evidence?q=${runId()}&sort=-duration_ms`);
  await table.getByRole('row').filter({ hasText: getState('titleA')! }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/evidence/${evA()}`));
});

test('overview: edit metadata and tags', async ({ as }) => {
  const page = await as('io.meera');
  await page.goto(`/evidence/${evA()}`);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  const desc = page.getByRole('region', { name: 'Description' });
  await desc.getByRole('button', { name: 'Edit' }).click();
  const text = `Edited by E2E ${runId()}`;
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill(text);
  await page.getByRole('textbox', { name: 'Location' }).fill('MG Road junction, Bengaluru');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(desc).toContainText(text);

  const tags = page.getByRole('list', { name: 'Tags' });
  await page.getByLabel('New tag').fill('Night Patrol');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(tags).toContainText('night patrol');
  await page.getByLabel('New tag').fill('e2e-temp');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(tags).toContainText('e2e-temp');
  await tags.getByRole('button', { name: 'Remove tag e2e-temp' }).click();
  await expect(tags).not.toContainText('e2e-temp');
  // Invalid tags are refused client-side.
  await page.getByLabel('New tag').fill('!bad');
  await expect(page.getByText(/must start with a letter or digit/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();

  // Persisted server-side.
  const ev = await apiGet<{ description: string; tags: Array<{ tag: string }> }>(page, `/evidence/${evA()}`);
  expect(ev.description).toBe(text);
  expect(ev.tags.map((t) => t.tag)).toContain('night patrol');
});

test('playback: HLS plays; pause, frame step, rate, zoom, snapshot', async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as('io.meera');
  await waitForMediaReady(page, evA());
  const playlists: string[] = [];
  page.on('response', (r) => {
    if (/\.m3u8/.test(r.url()) && r.ok()) playlists.push(r.url());
  });
  await page.goto(`/evidence/${evA()}?tab=playback`);
  const player = page.getByRole('region', { name: 'Evidence video player' });
  await expect(player).toBeVisible();
  await expect.poll(async () => (await videoState(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  expect(playlists.length, 'HLS playlists fetched').toBeGreaterThan(0);
  expect(playlists.every((u) => /[?&]t=/.test(u)), 'media URLs carry short-lived tokens').toBeTruthy();
  expect((await videoState(page)).src).toMatch(/^blob:/); // hls.js via MSE

  await player.getByRole('button', { name: 'Play' }).click();
  await expect.poll(async () => (await videoState(page)).t, { timeout: 20_000 }).toBeGreaterThan(1);
  await player.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  // Frame stepping at 25 fps: exactly one frame forward, then back.
  const frame = async () => Math.floor((await videoState(page)).t * 25 + 1e-6);
  const before = await frame();
  await player.getByRole('button', { name: 'Next frame' }).click();
  await expect.poll(frame).toBe(before + 1);
  await expect(player.getByText(`F ${before + 1}`, { exact: true })).toBeVisible();
  await player.getByRole('button', { name: 'Next frame' }).click();
  await expect.poll(frame).toBe(before + 2);
  await player.getByRole('button', { name: 'Previous frame' }).click();
  await expect.poll(frame).toBe(before + 1);

  await player.getByLabel('Playback rate').selectOption('2');
  await expect.poll(async () => (await videoState(page)).rate).toBe(2);

  await player.getByRole('button', { name: 'Zoom in' }).click();
  await expect(player.getByRole('button', { name: 'Reset zoom' })).toBeEnabled();
  await player.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(player.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();

  await player.getByRole('button', { name: 'Take snapshot of current frame' }).click();
  await expect(page.getByRole('status').filter({ hasText: /snapshot/i })).toBeVisible({ timeout: 60_000 });

  // Snapshots tab lists it with its hash and a download link.
  await page.getByRole('tab', { name: 'Snapshots' }).click();
  const snaps = page.getByRole('list', { name: 'Snapshots' });
  await expect(snaps.getByRole('listitem').first()).toContainText('SHA-256');
  const [dl] = await Promise.all([page.waitForEvent('download'), snaps.getByRole('link', { name: /Download PNG/ }).first().click()]);
  expect(readFileSync((await dl.path())!).subarray(1, 4).toString()).toBe('PNG');
});

test('integrity verify, lifecycle, chain of custody + signed PDF', async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as('io.meera');
  await page.goto(`/evidence/${evB()}?tab=integrity`);
  await expect(page.getByRole('region', { name: 'Fixity' })).toBeVisible();
  await page.getByRole('button', { name: /Verify/ }).first().click();
  await expect(page.getByRole('status').filter({ hasText: /verification (is already )?queued/i })).toBeVisible();
  // The tab polls while a check is pending; the result appears without a reload.
  const history = page.getByRole('table', { name: 'Integrity checks' });
  await expect(history.getByRole('row').filter({ hasText: /On demand|Manual/i }).first()).toContainText('Match', { timeout: 120_000 });
  await expect(page.getByRole('region', { name: 'Fixity' })).toContainText('Match');

  await page.getByRole('tab', { name: 'Lifecycle' }).click();
  await expect(page.getByRole('region', { name: 'Storage tier' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Retention' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Processing jobs' })).toBeVisible();

  await page.getByRole('tab', { name: 'Chain of custody' }).click();
  await expect(page.getByText('Chain intact')).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Custody timeline' });
  await expect(timeline).toContainText(/registered/i);
  await expect(timeline).toContainText(/verif/i);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Signed report (PDF)' }).click()]);
  const buf = readFileSync((await pdf.path())!);
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
});

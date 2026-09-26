/**
 * Scenario 2 — station operator uploads through the web uploader: one clip by drag-and-drop, one via the file
 * input, a non-video with a video extension (→ Quarantined) and a .txt (skipped client-side); per-file metadata;
 * progress; Registered; upload history. Evidence ids are recorded for later specs.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { makeAiClip, makeClip, makeFakeVideo } from '../lib/media';
import { runId, setState } from '../lib/state';
import { expect, test } from '../lib/fixtures';

test('station operator uploads videos via drag-and-drop and file input', async ({ as }) => {
  test.setTimeout(240_000);
  const run = runId();
  const clipA = makeClip(`clipA-${run}`, { seconds: 8, label: `A ${run}` });
  const clipB = makeClip(`clipB-${run}`, { seconds: 6, pattern: 'smptebars', freq: 660, label: `B ${run}` });
  const fake = makeFakeVideo(`notvideo-${run}`, run);
  const ai = makeAiClip(`ai-${run}`, `AI ${run}`);

  const page = await as('op.cubbon');
  await page.getByRole('link', { name: 'Upload evidence' }).first().click();
  await expect(page.getByRole('heading', { name: 'Upload evidence', level: 1 })).toBeVisible();
  // Station defaults to the operator's home station.
  await expect(page.getByLabel('Police station')).not.toHaveValue('');
  await page.getByLabel('Batch label').fill(`E2E batch ${run}`);
  await page.getByLabel('Category').fill('PATROL');

  // Drag and drop clip A onto the drop zone.
  const bytes = readFileSync(clipA).toString('base64');
  const dt = await page.evaluateHandle(
    ({ b64, name }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const d = new DataTransfer();
      d.items.add(new File([bin], name, { type: 'video/mp4' }));
      return d;
    },
    { b64: bytes, name: basename(clipA) },
  );
  const zone = page.getByRole('region', { name: 'Drop files or folders here' });
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  const queue = page.getByRole('list', { name: 'Upload queue' });
  await expect(queue.getByRole('listitem')).toHaveCount(1);

  // The rest through the (visually hidden) file input; a .txt is refused client-side.
  const txt = fake.replace(/\.mp4$/, '.txt');
  copyFileSync(fake, txt);
  const files = [clipB, fake, txt, ...(ai.path ? [ai.path] : [])];
  await page.locator('input[type=file][aria-label="Choose files"]').setInputFiles(files);
  await expect(page.getByText(/1 file\(s\) skipped — not an accepted video type/)).toBeVisible();
  await expect(queue.getByRole('listitem')).toHaveCount(ai.path ? 4 : 3);

  // Per-file metadata.
  const titles: Record<string, string> = {
    [basename(clipA)]: `E2E ${run} Clip A night patrol`,
    [basename(clipB)]: `E2E ${run} Clip B traffic stop`,
    [basename(fake)]: `E2E ${run} not a video`,
    ...(ai.path ? { [basename(ai.path)]: `E2E ${run} AI street scene` } : {}),
  };
  for (const [file, title] of Object.entries(titles)) {
    await queue.getByRole('listitem').filter({ hasText: file }).getByRole('button', { name: 'Details' }).click();
    const dlg = page.getByRole('dialog', { name: `Details — ${file}` });
    await dlg.getByLabel('Title').fill(title);
    if (file === basename(clipA)) await dlg.getByLabel('Location').fill('MG Road, Bengaluru');
    // Two angles of the same incident (same minute) (used by the workspace timeline in 07).
    if (file === basename(clipA)) await dlg.getByLabel('Recorded at').fill('2026-09-20T22:15');
    if (file === basename(clipB)) await dlg.getByLabel('Recorded at').fill('2026-09-20T22:15');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(queue.getByRole('listitem').filter({ hasText: file })).toContainText(title);
  }

  await page.getByRole('button', { name: /Start upload \(\d\)/ }).click();
  // Progress is reported per file.
  await expect(queue.getByRole('progressbar').first()).toBeVisible();

  const itemOf = (file: string) => queue.getByRole('listitem').filter({ hasText: file });
  for (const f of [clipA, clipB, ...(ai.path ? [ai.path] : [])]) {
    await expect(itemOf(basename(f)).getByText('Registered', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(itemOf(basename(f)).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  }
  await expect(itemOf(basename(fake)).getByText('Quarantined', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(itemOf(basename(fake))).toContainText(/Quarantined — /);

  const idOf = async (f: string) => {
    const href = await itemOf(basename(f)).getByRole('link').getAttribute('href');
    return href!.split('/').pop()!;
  };
  setState('evidenceA', await idOf(clipA));
  setState('evidenceB', await idOf(clipB));
  setState('titleA', titles[basename(clipA)]);
  setState('titleB', titles[basename(clipB)]);
  if (ai.path) {
    setState('evidenceAI', await idOf(ai.path));
    setState('titleAI', titles[basename(ai.path)]);
  } else setState('aiSkipReason', ai.reason);

  // Upload history lists the batch with outcomes.
  await page.getByRole('link', { name: 'Upload history' }).first().click();
  await expect(page.getByRole('heading', { name: 'Upload history' })).toBeVisible();
  const table = page.getByRole('table', { name: /upload/i });
  for (const f of [clipA, clipB]) await expect(table.getByRole('row').filter({ hasText: basename(f) })).toContainText(/Registered/);
  await expect(table.getByRole('row').filter({ hasText: basename(fake) })).toContainText(/Quarantined/i);
});

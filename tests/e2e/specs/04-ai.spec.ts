/**
 * Scenario 4 — AI: forensic analyst builds a FACE watchlist; IO requests analysis; the job completes on the real
 * ONNX ai-worker; detections are listed; reviewer approves/rejects in the review queue with keyboard shortcuts;
 * the approved tag appears on the evidence; face matches enforce the two-person rule.
 */
import { resolve } from 'node:path';
import { apiGet, waitForMediaReady } from '../lib/api';
import { ENV } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { getState, runId, setState } from '../lib/state';

const evAI = () => getState<string>('evidenceAI')!;
const portrait = () => resolve(ENV.AI_MODELS_DIR ?? '', '..', 'ai-test-media', 'portrait_obama.jpg');

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  test.skip(!getState('evidenceAI'), `needs the AI clip uploaded by 02-upload.spec.ts (${getState('aiSkipReason') ?? 'not run'})`);
});

test('forensic analyst creates a FACE watchlist with a reference image', async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as('fa.naveen');
  const tasks = await apiGet<{ items: Array<{ task: string; available: boolean }> }>(page, '/ai/tasks');
  test.skip(!tasks.items.find((t) => t.task === 'FACE_RECOGNITION')?.available, 'no ACTIVE face-recognition model (run npm run fetch-models -w @ksp/ai-worker)');

  await page.getByRole('link', { name: 'Watchlists' }).click();
  await page.getByRole('button', { name: /New watchlist/ }).click();
  const dlg = page.getByRole('dialog', { name: 'New watchlist' });
  const name = `E2E faces ${runId()}`;
  await dlg.getByLabel('Name').fill(name);
  await dlg.getByLabel('Kind').selectOption('FACE');
  await dlg.getByRole('button', { name: /Create/ }).click();
  await expect(page.getByRole('heading', { name: `${name} (faces)` })).toBeVisible();

  await page.getByRole('textbox', { name: 'Name / reference' }).fill(`Reference person ${runId()}`);
  await page.getByLabel(/Reference image/).setInputFiles(portrait());
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const entry = page.getByRole('listitem').filter({ hasText: `Reference person ${runId()}` });
  await expect(entry).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(entry).toContainText('READY', { timeout: 3000 });
  }).toPass({ timeout: 120_000, intervals: [3000] });
  setState('watchlist', name);
});

test('IO requests analysis; job completes; detections listed', async ({ as }) => {
  test.setTimeout(420_000);
  const page = await as('io.meera');
  await waitForMediaReady(page, evAI());
  await page.goto(`/evidence/${evAI()}?tab=ai`);
  for (const t of ['Person detection', 'Face detection', 'Face recognition (watchlist)', 'Object & vehicle detection', 'Evidence tagging']) {
    await page.getByRole('checkbox', { name: new RegExp(`^${t.replace(/[()&]/g, '\\$&')}`) }).check();
  }
  await expect(page.getByRole('group', { name: 'Watchlists covering this jurisdiction' })).toContainText(getState<string>('watchlist') ?? 'E2E faces');
  await page.getByLabel('Frames sampled per second').fill('1');
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Analysis queued' })).toBeVisible();

  const jobs = page.getByRole('region', { name: 'Analysis jobs' });
  await expect(jobs.getByRole('listitem').first()).toContainText(/Queued|Running|Completed/);
  await expect(jobs.getByRole('listitem').first()).toContainText('Completed', { timeout: 360_000 });
  await expect(jobs.getByRole('listitem').first()).toContainText(/\d+ frames/);

  const detections = page.getByRole('region', { name: /^Detections \(\d+\)/ });
  await expect(detections).toBeVisible();
  await expect(detections.getByRole('region', { name: 'Person detection' })).toBeVisible();
  await expect(detections.getByRole('region', { name: 'Face detection' })).toBeVisible();
  await expect(detections.getByRole('region', { name: 'Evidence tagging' })).toBeVisible();
  // Every result is advisory until reviewed.
  await expect(detections.getByRole('region', { name: 'Person detection' }).getByRole('listitem').first()).toContainText(/Pending/);
});

test('reviewer approves and rejects with keyboard shortcuts; approved tag appears on the evidence', async ({ as }) => {
  const page = await as('fa.naveen');
  await page.goto(`/review?evidenceId=${evAI()}&task=CLASSIFICATION&status=PENDING`);
  const items = page.getByRole('list', { name: 'Review items' });
  await expect(items.getByRole('listitem').first()).toBeVisible();
  const first = items.getByRole('listitem').first();
  const label = (await first.locator('.text-base').first().textContent())!.trim();
  await expect(page.getByTestId('rq-current')).toContainText(`Item 1 of`);

  // Shortcuts can be switched off (WCAG 2.1.4): 'a' then does nothing.
  await page.getByRole('checkbox', { name: 'Keyboard shortcuts' }).uncheck();
  await page.getByRole('heading', { name: 'AI review queue' }).click();
  await page.keyboard.press('a');
  await expect(page.getByRole('status').filter({ hasText: /approved/i })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Keyboard shortcuts' }).check();

  await page.getByRole('heading', { name: 'AI review queue' }).click();
  await page.keyboard.press('a');
  // First approval of a label adds it as an evidence tag; later runs find the tag already present.
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`"${label}": approved`) })).toBeVisible();

  // Reject a person detection with a reason (R opens the reason dialog).
  await page.goto(`/review?evidenceId=${evAI()}&task=PERSON_DETECTION&status=PENDING`);
  await expect(items.getByRole('listitem').first()).toBeVisible();
  const before = await apiGet<{ total: number }>(page, `/review/queue?evidenceId=${evAI()}&task=PERSON_DETECTION&status=PENDING`);
  await page.getByRole('heading', { name: 'AI review queue' }).click();
  await page.keyboard.press('j');
  await expect(page.getByTestId('rq-current')).toContainText(/Item 2 of|Item 1 of 1:/);
  await page.keyboard.press('r');
  const dlg = page.getByRole('dialog', { name: 'Reject AI result' });
  await expect(dlg).toBeVisible();
  // Focus lands in the reason field, so typing never reaches the page's single-key shortcuts (BUG-05).
  await expect(dlg.getByRole('textbox', { name: /Reason/ })).toBeFocused();
  await page.keyboard.type('Not a person - approve shortcut must not fire');
  await dlg.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('status').filter({ hasText: /rejected/i })).toBeVisible();
  await expect.poll(async () => (await apiGet<{ total: number }>(page, `/review/queue?evidenceId=${evAI()}&task=PERSON_DETECTION&status=PENDING`)).total).toBe(before.total - 1);

  // The approved tag is on the evidence (AI-approved source).
  await page.goto(`/evidence/${evAI()}`);
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText(label);
});

test('face match needs two different approvers', async ({ as }) => {
  const naveen = await as('fa.naveen');
  const q = await apiGet<{ total: number }>(naveen, `/review/queue?evidenceId=${evAI()}&task=FACE_RECOGNITION`);
  test.skip(q.total === 0, 'no face-recognition match produced for the reference image (model output) — two-person rule not exercised');
  await naveen.goto(`/review?evidenceId=${evAI()}&task=FACE_RECOGNITION&status=PENDING`);
  const card = naveen.getByRole('list', { name: 'Review items' }).getByRole('listitem').first();
  await expect(card).toContainText('Needs 2 approvals (0/2)');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(naveen.getByRole('status').filter({ hasText: /second review/i })).toBeVisible();
  await naveen.goto(`/review?evidenceId=${evAI()}&task=FACE_RECOGNITION&status=NEEDS_SECOND_REVIEW`);
  await expect(card).toContainText('Needs 2 approvals (1/2)');
  await expect(card).toContainText('You already reviewed this — a different reviewer must decide.');
  await expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled();

  const kavya = await as('sup.kavya');
  await kavya.goto(`/review?evidenceId=${evAI()}&task=FACE_RECOGNITION&status=NEEDS_SECOND_REVIEW`);
  const card2 = kavya.getByRole('list', { name: 'Review items' }).getByRole('listitem').first();
  await card2.getByRole('button', { name: 'Approve' }).click();
  await expect(kavya.getByRole('status').filter({ hasText: /approved/i })).toBeVisible();
});

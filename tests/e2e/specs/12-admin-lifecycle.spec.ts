/**
 * Scenario 12 — admin & lifecycle screens driven end to end (FN-18):
 *  - integrations: admin adds a `fixture` CCTNS system, enables it, runs the health check and a contract test with
 *    a probe FIR; an IO imports that FIR through the UI and lands on the imported FIR;
 *  - API clients: admin creates a client → secret shown once (works for Basic auth, never listed again) → revoke
 *    with reason → the secret is refused;
 *  - retention: custodian creates a policy and assigns it to a fresh upload on its Lifecycle tab;
 *  - disposal: custodian requests disposal → a second officer (supervisor) approves → the worker executes →
 *    the evidence shows DISPOSED and the request shows the execution time.
 */
import { basename } from 'node:path';
import { makeClip } from '../lib/media';
import { apiGet, waitForMediaReady } from '../lib/api';
import { runId } from '../lib/state';
import { expect, test } from '../lib/fixtures';

/** Unique per test execution (run id + time) so re-running a spec with E2E_REUSE=1 never collides with its own data. */
const uid = () => `${runId()}${String(Date.now()).slice(-5)}`;
const FIXTURE_FIR = { station: 'ps_cubbonpark', year: '2026', number: '0142' };

test('integrations: fixture system, health + contract test, FIR import by an IO', async ({ as }) => {
  const run = uid();
  const name = `E2E fixture CCTNS ${run}`;
  const admin = await as('admin');
  await admin.goto('/admin/integrations');
  await admin.getByRole('button', { name: 'Add system' }).click();
  const dlg = admin.getByRole('dialog', { name: 'Add integration system' });
  await dlg.getByLabel(/^Code/).fill(`e2e_fx_${run}`);
  await dlg.getByLabel(/^Name/).fill(name);
  await dlg.getByLabel('System type').selectOption('CCTNS');
  await dlg.getByLabel('Adapter').selectOption('fixture');
  await dlg.getByLabel('Authentication').selectOption('none');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Integration created (disabled, unverified)' })).toBeVisible();

  const table = admin.getByRole('table', { name: 'Integration systems' });
  await table.getByRole('row').filter({ hasText: name }).click();
  const panel = admin.getByRole('region', { name });
  await panel.getByRole('button', { name: 'Enable' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'System enabled' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: name })).toContainText('Enabled');

  const testCard = admin.getByRole('region', { name: 'Test connection' });
  await testCard.getByRole('button', { name: 'Health check' }).click();
  await expect(testCard.getByText(/^Passed \(\d+ ms\)$/)).toBeVisible();
  await testCard.getByLabel('Probe station code').fill(FIXTURE_FIR.station);
  await testCard.getByLabel('Year').fill(FIXTURE_FIR.year);
  await testCard.getByLabel('FIR number').fill(FIXTURE_FIR.number);
  await testCard.getByRole('button', { name: 'Run contract test' }).click();
  await expect(testCard.getByText(/^Passed \(\d+ ms\)$/)).toBeVisible();
  await expect(testCard).toContainText(/fixture/i); // the note says fixture systems are never "verified"
  const log = admin.getByRole('table', { name: 'Sync log' });
  await expect(log.getByRole('row').nth(1)).toContainText('Success');

  // IO imports the fixture FIR through the FIR list.
  const io = await as('io.meera');
  await io.goto('/firs');
  await io.getByRole('button', { name: 'Import from CCTNS' }).click();
  const im = io.getByRole('dialog', { name: 'Import FIR from CCTNS / FIR system' });
  const source = im.getByLabel('Source system');
  const value = await source.locator('option', { hasText: name }).getAttribute('value');
  await source.selectOption(value!);
  await expect(im).toContainText('Fixture data');
  await im.getByLabel('Station code (source)').fill(FIXTURE_FIR.station);
  await im.getByLabel('Year').fill(FIXTURE_FIR.year);
  await im.getByLabel('FIR number').fill(FIXTURE_FIR.number);
  await im.getByRole('button', { name: 'Import' }).click();
  await expect(io.getByRole('status').filter({ hasText: /FIR .*142.* (imported|refreshed from source)/ })).toBeVisible();
  await expect(io).toHaveURL(/\/firs\/[0-9a-f-]{36}$/);
  await expect(io.getByText('Imported from an external system.', { exact: false })).toBeVisible();
  await expect(io.getByText(/Chain snatching near the park gate/)).toBeVisible();

  // The import is logged on the system; then the admin disables it again (keeps FIR sources tidy across runs).
  await admin.reload();
  await admin.getByRole('table', { name: 'Integration systems' }).getByRole('row').filter({ hasText: name }).click();
  await expect(admin.getByRole('table', { name: 'Sync log' })).toContainText('FIR_IMPORT');
  await admin.getByRole('region', { name }).getByRole('button', { name: 'Disable' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'System disabled' })).toBeVisible();
});

test('API clients: the System Administrator cannot mint a credential with evidence rights it does not hold (refused, explained)', async ({ as, guard }) => {
  guard.expectFailure(/\/api-clients$/, 403, 'POST');
  // Code audit 2026-10-10 (req 9/63): an API client only receives rights its creator holds at that unit. The create →
  // secret-once → use → revoke flow is covered with an Integration officer in apps/api/test/api-clients.test.ts.
  const run = uid();
  const admin = await as('admin');
  await admin.goto('/admin/api-clients');
  await admin.getByRole('button', { name: 'New client' }).click();
  const dlg = admin.getByRole('dialog', { name: 'New API client' });
  await dlg.getByLabel('Name').fill(`E2E client ${run}`);
  const org = dlg.getByLabel('Jurisdiction (org unit)');
  await expect(org.locator('option', { hasText: 'Cubbon Park Police Station' })).toHaveCount(1);
  await org.selectOption((await org.locator('option', { hasText: 'Cubbon Park Police Station' }).getAttribute('value'))!);
  await dlg.getByRole('button', { name: 'Create' }).click();
  await expect(dlg.getByRole('alert')).toContainText('rights you hold yourself');
  await expect(admin.getByRole('dialog', { name: 'Client credentials' })).toHaveCount(0);
});

test('retention policy + disposal: create/assign policy, request, second-officer approval, DISPOSED', async ({ as }) => {
  test.setTimeout(300_000);
  const run = uid();
  // A dedicated recording (disposal is irreversible; the shared evidence of earlier specs stays untouched).
  const clip = makeClip(`dispose-${Date.now()}`, { seconds: 3, label: `D ${Date.now()}` });
  // No run id in the title: other specs search the evidence list by run id and must never see this (DISPOSED) item.
  const title = `E2E disposal candidate ${Date.now()}`;
  const op = await as('op.cubbon');
  await op.goto('/upload');
  await op.locator('input[type=file][aria-label="Choose files"]').setInputFiles([clip]);
  const queue = op.getByRole('list', { name: 'Upload queue' });
  const item = queue.getByRole('listitem').filter({ hasText: basename(clip) });
  await item.getByRole('button', { name: 'Details' }).click();
  const det = op.getByRole('dialog', { name: `Details — ${basename(clip)}` });
  await det.getByLabel('Title').fill(title);
  await det.getByRole('button', { name: 'Save' }).click();
  await op.getByRole('button', { name: /Start upload \(1\)/ }).click();
  await expect(item.getByText('Registered', { exact: true })).toBeVisible({ timeout: 120_000 });
  const evidenceId = (await item.getByRole('link').getAttribute('href'))!.split('/').pop()!;
  await waitForMediaReady(op, evidenceId);

  // Custodian: new retention policy, assigned on the Lifecycle tab.
  const policyName = `E2E policy ${run}`;
  const ec = await as('ec.latha');
  await ec.goto('/retention/policies');
  await ec.getByRole('button', { name: 'New policy' }).click();
  const pd = ec.getByRole('dialog', { name: 'New retention policy' });
  await pd.getByLabel(/^Code/).fill(`e2e_${run}`);
  await pd.getByLabel('Name').fill(policyName);
  await pd.getByLabel('Retain (days)').fill('30');
  await pd.getByLabel('Archive after (days)').fill('10');
  await pd.getByRole('button', { name: 'Save' }).click();
  await expect(ec.getByRole('status').filter({ hasText: 'Policy created' })).toBeVisible();
  const prow = ec.getByRole('table', { name: 'Retention policies' }).getByRole('row').filter({ hasText: policyName });
  await expect(prow).toContainText('30 d');
  await expect(prow).toContainText('10 d');

  await ec.goto(`/evidence/${evidenceId}?tab=lifecycle`);
  const assign = ec.getByLabel('Assign retention policy');
  await assign.selectOption((await assign.locator('option', { hasText: policyName }).getAttribute('value'))!);
  await ec.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(ec.getByRole('status').filter({ hasText: 'Retention policy assigned' })).toBeVisible();
  await expect(ec.getByRole('region', { name: 'Retention' })).toContainText(policyName);
  await ec.goto('/retention/policies');
  await expect(ec.getByRole('table', { name: 'Retention policies' }).getByRole('row').filter({ hasText: policyName }).getByRole('cell').nth(4)).toHaveText('1'); // evidence count

  // Custodian requests disposal.
  await ec.goto(`/evidence/${evidenceId}?tab=lifecycle`);
  await ec.getByRole('button', { name: 'Request disposal' }).click();
  const rd = ec.getByRole('dialog', { name: 'Request authorised disposal' });
  await rd.getByLabel('Authority reference').fill(`E2E-ORDER-${run}`);
  // The 30-day policy has not ended: disposal now needs a court / government order (type + date).
  await rd.getByLabel('Order type').selectOption('COURT_ORDER');
  await rd.getByLabel('Order date').fill(new Date().toISOString().slice(0, 10));
  await rd.getByLabel('Reason').fill('E2E: duplicate recording, retention order applies');
  await rd.getByRole('button', { name: 'Submit request' }).click();
  await expect(ec.getByRole('status').filter({ hasText: 'Disposal requested' })).toBeVisible();
  const reqs = ec.getByRole('table', { name: 'Disposal requests' });
  await expect(reqs.getByRole('row').nth(1)).toContainText(/Pending/i);
  await expect(reqs.getByRole('button', { name: 'Approve' })).toHaveCount(0); // the requester cannot approve

  // A different officer (supervisor) approves from the approvals queue.
  const sup = await as('sup.kavya');
  await sup.goto('/evidence/disposals');
  const row = sup.getByRole('row').filter({ hasText: `E2E-ORDER-${run}` });
  await row.getByRole('button', { name: 'Approve' }).click();
  const ad = sup.getByRole('dialog', { name: 'Approve disposal' });
  await ad.getByRole('textbox', { name: /Decision note/ }).fill('Approved per order');
  await ad.getByRole('button', { name: 'Approve and dispose' }).click();
  await expect(sup.getByRole('status').filter({ hasText: 'Approved — disposal execution queued' })).toBeVisible();

  // The worker executes the disposal; the evidence and the request show the outcome.
  await expect.poll(async () => (await apiGet<{ status: string }>(sup, `/evidence/${evidenceId}`)).status, { timeout: 120_000, intervals: [2000] }).toBe('DISPOSED');
  await sup.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: 'Executed' }).click();
  await expect(sup.getByRole('row').filter({ hasText: `E2E-ORDER-${run}` })).toContainText(/Disposed \d/);
  await ec.goto(`/evidence/${evidenceId}?tab=lifecycle`);
  await expect(ec.getByText('Disposed', { exact: true }).first()).toBeVisible();
});

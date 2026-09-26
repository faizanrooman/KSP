/**
 * Scenario 6 — cases: register FIR, open a case on it, link evidence, add a member from another station
 * (keyboard-only user picker), diary note, timeline; case-based visibility for the member; removal → not-found.
 */
import { expect, test } from '../lib/fixtures';
import { getState, runId, setState } from '../lib/state';

test.describe.configure({ mode: 'serial' });
const FIR_NO = `E${runId().slice(-5)}${Math.floor(Math.random() * 900 + 100)}`;
const firNo = () => FIR_NO;

test('IO registers a FIR and opens a case, links evidence, adds a member, writes the diary', async ({ as }) => {
  test.skip(!getState('evidenceA'), 'needs 02-upload');
  const page = await as('io.meera');
  await page.getByRole('link', { name: 'FIRs' }).click();
  await page.getByRole('button', { name: 'Register FIR' }).click();
  const fir = page.getByRole('dialog', { name: 'Register FIR' });
  await fir.getByLabel('FIR number').fill(firNo());
  await fir.getByLabel('Station').selectOption({ label: 'Cubbon Park Police Station' });
  await fir.getByLabel('Registered at').fill('2026-09-20T10:30');
  await fir.getByLabel('Acts / sections').fill('BNS 303(2)');
  await fir.getByLabel('Complainant').fill('E2E complainant');
  await fir.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'FIR registered' })).toBeVisible();
  await expect(page).toHaveURL(/\/firs\/[0-9a-f-]{36}$/);

  await page.getByRole('link', { name: 'Cases', exact: true }).click();
  await page.getByRole('button', { name: 'New case' }).click();
  const nc = page.getByRole('dialog', { name: 'Open a new case' });
  const title = `E2E case ${runId()} MG Road robbery`;
  await nc.getByLabel('Title').fill(title);
  await nc.getByLabel('Linked FIR').fill(firNo());
  await nc.getByRole('list', { name: 'Matching FIRs' }).getByRole('button').first().click();
  await expect(nc).toContainText(firNo());
  await nc.getByRole('button', { name: 'Create case' }).click();
  await expect(page).toHaveURL(/\/cases\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/.+/);
  const caseId = new URL(page.url()).pathname.split('/').pop()!;
  setState('caseId', caseId);
  setState('caseTitle', title);

  // Link evidence A.
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await page.getByRole('button', { name: 'Link evidence' }).click();
  const le = page.getByRole('dialog', { name: 'Link evidence to case' });
  await le.getByLabel('Search evidence').fill(getState<string>('titleA')!);
  await le.getByRole('checkbox').first().check();
  await le.getByRole('button', { name: /^Link 1 item/ }).click();
  await expect(page.getByRole('table', { name: 'Linked evidence' })).toContainText(getState<string>('titleA')!);

  // Add io.arjun (another station) — keyboard only through the combobox.
  await page.getByRole('tab', { name: /Team/ }).click();
  const picker = page.getByRole('combobox', { name: 'Officer' });
  await picker.fill('arjun');
  await expect(page.getByRole('listbox', { name: 'Matching users' }).getByRole('option').first()).toContainText('Arjun Shetty');
  // Results refresh after the debounce (which resets the highlight): retry ↓ until an Arjun option is active.
  await expect(async () => {
    await picker.press('ArrowDown');
    const id = await picker.getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    await expect(page.locator(`[id="${id}"]`)).toContainText('Arjun Shetty', { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await picker.press('Enter');
  await expect(page.getByRole('button', { name: 'Change', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Add to team' }).click();
  await expect(page.getByRole('region', { name: 'Case team' })).toContainText('Arjun Shetty');

  // Diary + timeline.
  await page.getByRole('tab', { name: 'Case diary' }).click();
  const note = `Visited the scene; CCTV requested. E2E ${runId()}`;
  await page.getByRole('textbox', { name: 'Entry', exact: true }).fill(note);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.getByRole('region', { name: 'Case diary' })).toContainText(note);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const tl = page.getByRole('region', { name: 'Case timeline' });
  await expect(tl).toContainText(/linked/i);
  await expect(tl).toContainText(/member/i);
  await expect(tl).toContainText(/diary/i);
});

test('member from another station sees linked evidence; after removal gets not-found', async ({ as, guard }) => {
  guard.expectFailure(/\/api\/v1\/(evidence|custody|ai|media|cases)\//, 404); // out of scope after removal → 404, never 403
  test.skip(!getState('caseId'), 'needs the case from the previous test');
  const arjun = await as('io.arjun');
  await arjun.goto(`/evidence/${getState('evidenceA')}`);
  await expect(arjun.getByRole('heading', { level: 1 })).toContainText(/KSP-/);
  await arjun.goto(`/cases/${getState('caseId')}`);
  await expect(arjun.getByRole('heading', { level: 1 })).toBeVisible();

  const meera = await as('io.meera');
  await meera.goto(`/cases/${getState('caseId')}?tab=team`);
  await meera.getByRole('button', { name: 'Remove Arjun Shetty' }).click();
  const dlg = meera.getByRole('dialog', { name: 'Remove team member' });
  await expect(dlg.getByRole('textbox', { name: /Reason/ })).toBeFocused();
  await meera.keyboard.type('Reassigned to another case');
  await dlg.getByRole('button', { name: 'Remove' }).click();
  await expect(meera.getByRole('status').filter({ hasText: 'Team member removed' })).toBeVisible();

  await arjun.goto(`/evidence/${getState('evidenceA')}`);
  await expect(arjun.getByRole('heading', { level: 1, name: 'Evidence not found' })).toBeVisible();
  await expect(arjun.getByText('It does not exist or is outside your jurisdiction.')).toBeVisible();
});

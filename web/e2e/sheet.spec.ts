import { test, expect } from '@playwright/test';

const SCREENS = 'e2e/__screens__';

test('design sheet: add, evaluate to a mix of pass/fail, recompute on edit, persist', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.locator('.grid .panel')).toHaveCount(5); // canonical preset

  // Add a design sheet → a 6th panel, pre-loaded with the vetted single-device sizing example.
  await page.getByRole('button', { name: '+ sheet' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('.sheet')).toBeVisible();
  await expect(sp.locator('.shead')).toContainText('Single NMOS gm/ID sizing');

  // The device is sized: a width and operating point are reported, no error.
  await expect(sp.locator('.bind')).toContainText('W=');
  await expect(sp.locator('.perr')).toHaveCount(0);

  // Constraints evaluate to a MIX: feasibility/noise pass; headroom fails at the default
  // gm/ID = 12 (V* ≈ 167 mV < the 200 mV floor) — the gm/ID trade made visible.
  await expect(sp.locator('.srules tr.st-pass').first()).toBeVisible();
  await expect(sp.locator('.srules tr.st-fail').first()).toBeVisible();
  const headroom = sp.locator('.srules tr', { hasText: 'headroom' });
  await expect(headroom).toHaveClass(/st-fail/);
  await page.screenshot({ path: `${SCREENS}/sheet.png`, fullPage: true });

  // Lower the efficiency knob (more headroom): gm/ID = 8 → V* ≈ 250 mV ≥ floor → headroom passes.
  const gmId = sp.locator('.svar', { hasText: 'gm_id' }).locator('.num');
  await gmId.fill('8');
  await gmId.blur();
  await expect(headroom).toHaveClass(/st-pass/);

  // The edited sheet (and the panel) survive a reload through the dashboard sanitizer.
  await page.reload();
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.sheet')).toBeVisible();
  await expect(sp2.locator('.svar', { hasText: 'gm_id' }).locator('.num')).toHaveValue('8');
  await expect(sp2.locator('.srules tr', { hasText: 'headroom' })).toHaveClass(/st-pass/);

  expect(errors).toEqual([]);
});

test('design sheet: sweep a parameter into a feasibility curve, persisted', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // Sweep the efficiency knob → a margin-vs-gm/ID chart and a feasibility-window readout appear.
  await sp.locator('.swsel select').selectOption('gm_id');
  await expect(sp.locator('.pchart canvas')).toBeVisible();
  await expect(sp.locator('.feas')).toContainText('feasible');
  await page.screenshot({ path: `${SCREENS}/sheet-sweep.png`, fullPage: true });

  // The sweep selection survives a reload through the dashboard sanitizer.
  await page.reload();
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.swsel select')).toHaveValue('gm_id');
  await expect(sp2.locator('.pchart canvas')).toBeVisible();

  expect(errors).toEqual([]);
});

test('device swap preserves the user’s tabs (an authored sheet is not wiped)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ sheet' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(6);

  // Swap the active device (reload the demo). The user's panels — including the sheet — must
  // survive; before the fix this re-seeded the canonical preset and dropped them back to 5.
  await page.getByRole('button', { name: 'demo', exact: true }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  await expect(page.locator('.grid .panel').last().locator('.sheet')).toBeVisible();
});

test('device swap keeps an EDITED canonical panel (editing clears its auto marker)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.grid .panel')).toHaveCount(5);

  // Edit a canonical panel — flip the first one to a table. That makes it the user's own.
  await page.locator('.grid .panel').first().getByRole('button', { name: 'table', exact: true }).click();
  await expect(page.locator('.grid .ptable')).toHaveCount(1);

  // Swap the device: the canonical charts regenerate, but the edited (now user-owned) table
  // survives. Before the fix it kept auto:true and was deleted with the rest of the preset.
  await page.getByRole('button', { name: 'demo', exact: true }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  await expect(page.locator('.grid .ptable')).toHaveCount(1);
});

test('device swap respects a deleted Overview tab (no canonical panels misplaced into a user tab)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.grid .panel')).toHaveCount(5);

  // Add a user tab, then delete the (active) Overview tab so no auto-marked tab remains.
  await page.locator('.tab.add').click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'remove tab' }).click();

  // The surviving user tab is now at index 0. A device swap must NOT inject the canonical panels
  // into it (the old code assumed Overview was always tab 0 and dumped them there).
  await page.getByRole('button', { name: 'demo', exact: true }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(0);
});

test('design sheet: switching the example replaces the doc; a removed sheet is gone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // The example picker offers the vetted sheets and (re)loads one without typing.
  await sp.locator('.shead select.rm').selectOption({ label: 'Single NMOS gm/ID sizing' });
  await expect(sp.locator('.srules tr')).not.toHaveCount(0);
  await expect(sp.locator('.shead select.rm')).toHaveValue(''); // snaps back to the placeholder

  // Removing the sheet panel drops it.
  await sp.locator('.ptools .rm', { hasText: '×' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(5);
});

test('design sheet: the noise & matching example evaluates and sweeps to a feasible window', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  await sp.locator('.shead select.rm').selectOption({ label: 'NMOS noise & matching' });
  // The integrated-noise and Pelgrom-offset constraints are present.
  await expect(sp.locator('.srules tr', { hasText: 'noise-spec' })).toBeVisible();
  await expect(sp.locator('.srules tr', { hasText: 'offset-spec' })).toBeVisible();

  // Sweep gm/ID → a margin chart and a bounded feasible window.
  await sp.locator('.swsel select').selectOption('gm_id');
  await expect(sp.locator('.pchart canvas')).toBeVisible();
  await expect(sp.locator('.feas')).toContainText('feasible');
});

test('design sheet: a composed cascode shows its child block and composes feasibility, persisted', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // Switch to the composed (parent → child) cascode example.
  await sp.locator('.shead select.rm').selectOption({ label: 'NMOS cascode (gain-boosted output)' });

  // The embedded common-source child renders in the children summary and is feasible,
  // and the scalars it exposes (cs__av0, …) are shown.
  await expect(sp.locator('.suse')).toHaveCount(1);
  await expect(sp.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-pass/);
  await expect(sp.locator('.suse .prov')).toContainText('cs__av0');
  // The parent's composed gain rule evaluates over the child's provided scalars.
  await expect(sp.locator('.srules tr', { hasText: 'gain-spec' })).toBeVisible();

  // Sweep the shared knob → a feasibility curve over the WHOLE composition.
  await sp.locator('.swsel select').selectOption('gm_id');
  await expect(sp.locator('.pchart canvas')).toBeVisible();
  await expect(sp.locator('.feas')).toContainText('feasible');
  await page.screenshot({ path: `${SCREENS}/sheet-cascode.png`, fullPage: true });

  // The nested child doc survives a reload through the dashboard sanitizer.
  await page.reload();
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.suse', { hasText: 'cs' })).toBeVisible();
  await expect(sp2.locator('.swsel select')).toHaveValue('gm_id');

  expect(errors).toEqual([]);
});

test('design sheet: a composed child sizes against a chosen loaded device (multi-device), persisted', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // Load a second device so children have a choice. The import accumulates and becomes active,
  // so switch back to the demo (the cascode's defaults size cleanly on it).
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo active
  await expect(page.locator('header .device')).toContainText('nmos_demo');

  // Add a composed sheet (the cascode); its child gets a per-child device picker now that >1
  // device is loaded.
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await sp.locator('.shead select.rm').selectOption({ label: 'NMOS cascode (gain-boosted output)' });
  const child = sp.locator('.suse', { hasText: 'cs' });
  await expect(child.locator('.dsel')).toBeVisible();

  // The child inherits the active (demo) device; point it at the imported device → a different
  // table ⇒ a different sized result.
  const before = (await child.locator('.prov').innerText()).trim();
  await child.locator('.dsel').selectOption({ index: 2 }); // the imported nch_lvt
  await expect(child.locator('.prov')).not.toHaveText(before);

  // The choice persists. After reload only the demo is loaded, so the still-set device no longer
  // resolves and the child fails closed with a clear message — proving the key was stored.
  await page.reload();
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-fail/);
  // The persisted device key (nch_lvt) is what fails to resolve — proving the choice was stored.
  await expect(sp2.locator('.pwarn', { hasText: 'nch_lvt' })).toContainText('did not resolve');
  // The picker honestly surfaces the still-set-but-absent device (not a false "active device")
  // and stays available so it can be cleared in place even with one device loaded.
  await expect(sp2.locator('.suse', { hasText: 'cs' }).locator('.dsel')).toContainText('not loaded');

  expect(errors).toEqual([]);
});

test('design sheet: two loaded devices sharing a label are each individually selectable (unique keys)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // Two DIFFERENT tables that share the same display label (device·corner·temp), different data.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2); // let the first import land
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample-alt.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(3); // demo + two same-label nch_lvt
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo active (sizes the parent)

  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await sp.locator('.shead select.rm').selectOption({ label: 'NMOS cascode (gain-boosted output)' });
  const dsel = sp.locator('.suse', { hasText: 'cs' }).locator('.dsel');

  // The two same-label devices appear as DISTINCT options (one disambiguated with a suffix) —
  // not collapsed to a single unselectable entry.
  const opts = dsel.locator('option');
  await expect(opts.filter({ hasText: 'nch_lvt' })).toHaveCount(2);
  await expect(opts.filter({ hasText: '#2' })).toHaveCount(1);

  // Selecting the second same-label device takes effect (the child now sizes against the fixture,
  // which can't reach gm/ID=12, so it goes infeasible — proving the selection is not inherit/demo)
  // AND the device RESOLVES (no "device … did not resolve"; the unique key targeted the right table).
  const second = await opts.filter({ hasText: '#2' }).getAttribute('value');
  await dsel.selectOption(second!);
  await expect(sp.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-fail/);
  await expect(sp.locator('.pwarn', { hasText: 'device "' })).toHaveCount(0);

  expect(errors).toEqual([]);
});

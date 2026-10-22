import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { loadDemo, loadDemoNoVsb, pickSheet } from './helpers';

const SCREENS = 'e2e/__screens__';

test('design sheet: add, evaluate to a mix of pass/fail, recompute on edit, persist', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
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

  // Fields render engineering notation (2e-12 → "2p", 0.5e-6 → "500n"), and the description
  // carries inline math ($C_L$, $I_D/W$…) typeset with subscripts rather than raw prose.
  await expect(sp.locator('.svar[data-param="CL"] .num')).toHaveValue('2p');
  await expect(sp.locator('.svar[data-param="L"] .num')).toHaveValue('500n');
  await expect(sp.locator('.sdesc sub').first()).toBeVisible();

  // Constraints evaluate to a MIX: feasibility/noise pass; headroom fails at the default
  // gm/ID = 12 (V* ≈ 167 mV < the 200 mV floor) — the gm/ID trade made visible.
  await expect(sp.locator('.srules tr.st-pass').first()).toBeVisible();
  await expect(sp.locator('.srules tr.st-fail').first()).toBeVisible();
  const headroom = sp.locator('.srules tr', { hasText: 'headroom' });
  await expect(headroom).toHaveClass(/st-fail/);
  await page.screenshot({ path: `${SCREENS}/sheet.png`, fullPage: true });

  // Lower the efficiency knob (more headroom): gm/ID = 8 → V* ≈ 250 mV ≥ floor → headroom passes.
  const gmId = sp.locator('.svar[data-param="gm_id"]').locator('.num');
  await gmId.fill('8');
  await gmId.blur();
  await expect(headroom).toHaveClass(/st-pass/);

  // The edited sheet (and the panel) survive a reload through the dashboard sanitizer (the device
  // is not persisted, so re-load the demo; the saved layout — including the sheet — then restores).
  await page.reload();
  await loadDemo(page);
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.sheet')).toBeVisible();
  await expect(sp2.locator('.svar[data-param="gm_id"]').locator('.num')).toHaveValue('8');
  await expect(sp2.locator('.srules tr', { hasText: 'headroom' })).toHaveClass(/st-pass/);

  // An engineering-suffixed entry parses back to SI and normalizes on commit ("1u" → 1e-6 → "1u").
  const lNum = sp2.locator('.svar[data-param="L"]').locator('.num');
  await lNum.fill('1u');
  await lNum.blur();
  await expect(lNum).toHaveValue('1u');

  expect(errors).toEqual([]);
});

test('design sheet: sweep a parameter into a feasibility curve, persisted', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // Sweep the efficiency knob → a margin-vs-gm/ID chart and a feasibility-window readout appear.
  await sp.locator('.swsel select').selectOption('gm_id');
  await expect(sp.locator('.pchart canvas')).toBeVisible();
  await expect(sp.locator('.feas')).toContainText('feasible');
  await page.screenshot({ path: `${SCREENS}/sheet-sweep.png`, fullPage: true });

  // The sweep selection survives a reload through the dashboard sanitizer (re-load the demo, since
  // the device itself is not persisted; the saved layout then restores).
  await page.reload();
  await loadDemo(page);
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.swsel select')).toHaveValue('gm_id');
  await expect(sp2.locator('.pchart canvas')).toBeVisible();

  expect(errors).toEqual([]);
});

test('tab rename: inline edit commits on Enter and persists', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);

  // Double-click the active tab to edit its name in place (inline edit, keyboard-reachable).
  const tab = page.locator('.tabs .tab').first();
  await expect(tab).toHaveText('Overview');
  await tab.dblclick();
  const edit = page.locator('.tabs .tabedit');
  await expect(edit).toBeFocused();
  await edit.fill('Bias sweep');
  await edit.press('Enter');

  // The edit box is gone and the tab shows the new name.
  await expect(page.locator('.tabs .tabedit')).toHaveCount(0);
  await expect(page.locator('.tabs .tab').first()).toHaveText('Bias sweep');

  // The rename lives in the persisted layout: reload, re-load the demo (the device is never
  // persisted), and the renamed tab restores.
  await page.reload();
  await loadDemo(page);
  await expect(page.locator('.tabs .tab').first()).toHaveText('Bias sweep');
});

test('device swap preserves the user’s tabs (an authored sheet is not wiped)', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(6);

  // Swap the active device by loading a DIFFERENT device. The user's panels — including the
  // sheet — must survive the reseat; before the fix this re-seeded the canonical preset and
  // dropped them back to 5. The second device carries the bias sweeps the sheet states, so the
  // sheet that survives is still a working one: it is sized on the new device and gives its
  // verdict there.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/demo-half.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nmos_half');
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('.sheet')).toBeVisible();
  await expect(sp.locator('.feasb')).toHaveText(/feasible|infeasible/);
  await expect(sp.locator('.bind')).toContainText('W=');
});

test('device swap keeps an EDITED canonical panel (editing clears its auto marker)', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await expect(page.locator('.grid .panel')).toHaveCount(5);

  // Edit a canonical panel — flip the first one to a table. That makes it the user's own.
  await page
    .locator('.grid .panel')
    .first()
    .getByRole('button', { name: 'table', exact: true })
    .click();
  await expect(page.locator('.grid .ptable')).toHaveCount(1);

  // Swap the device (load a DIFFERENT one): the canonical charts regenerate, but the edited (now
  // user-owned) table survives. Before the fix it kept auto:true and was deleted with the preset.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  await expect(page.locator('.grid .ptable')).toHaveCount(1);
});

test('device swap respects a deleted Overview tab (no canonical panels misplaced into a user tab)', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await expect(page.locator('.grid .panel')).toHaveCount(5);

  // Add a user tab, then delete the (active) Overview tab so no auto-marked tab remains.
  await page.locator('.tab.add').click();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'remove tab' }).click();

  // The surviving user tab is now at index 0. A device swap (load a DIFFERENT device) must NOT
  // inject the canonical panels into it (the old code assumed Overview was always tab 0).
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  await expect(page.locator('.grid .panel')).toHaveCount(0);
});

test('design sheet: switching the example replaces the doc; a removed sheet is gone', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // The example picker offers the vetted sheets and (re)loads one without typing.
  await pickSheet(sp, 'Single NMOS gm/ID sizing');
  await expect(sp.locator('.srules tr')).not.toHaveCount(0);
  await expect(sp.locator('.shead select.rm')).toHaveValue(''); // snaps back to the placeholder

  // Removing the sheet panel drops it.
  await sp.locator('.ptools .rm', { hasText: '×' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(5);
});

test('design sheet: the noise & matching example evaluates and sweeps to a feasible window', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  await pickSheet(sp, 'NMOS noise & matching');
  // The integrated-noise and Pelgrom-offset constraints are present.
  await expect(sp.locator('.srules tr', { hasText: 'noise-spec' })).toBeVisible();
  await expect(sp.locator('.srules tr', { hasText: 'offset-spec' })).toBeVisible();

  // Sweep gm/ID → a margin chart and a bounded feasible window.
  await sp.locator('.swsel select').selectOption('gm_id');
  await expect(sp.locator('.pchart canvas')).toBeVisible();
  await expect(sp.locator('.feas')).toContainText('feasible');
});

test('design sheet: a composed cascode shows its block and composes feasibility, persisted', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // Switch to the composed (parent → child) cascode example.
  await pickSheet(sp, 'NMOS cascode (gain-boosted output)');

  // The embedded common-source child renders in the children summary and is feasible,
  // and the scalars it exposes (cs__av0 → typeset A_{v0,cs}, …) are shown.
  await expect(sp.locator('.suse')).toHaveCount(1);
  await expect(sp.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-pass/);
  await expect(sp.locator('.suse .prov')).toContainText('Av0,cs');
  // The parent's composed gain check evaluates over the child's provided scalars.
  await expect(sp.locator('.srules tr', { hasText: 'gain-spec' })).toBeVisible();

  // Sweep the shared knob → a feasibility curve over the WHOLE composition.
  await sp.locator('.swsel select').selectOption('gm_id');
  await expect(sp.locator('.pchart canvas')).toBeVisible();
  await expect(sp.locator('.feas')).toContainText('feasible');
  await page.screenshot({ path: `${SCREENS}/sheet-cascode.png`, fullPage: true });

  // The nested child doc survives a reload through the dashboard sanitizer (re-load the demo, since
  // the device is not persisted; the saved layout with the nested child then restores).
  await page.reload();
  await loadDemo(page);
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.suse', { hasText: 'cs' })).toBeVisible();
  await expect(sp2.locator('.swsel select')).toHaveValue('gm_id');

  expect(errors).toEqual([]);
});

test('design sheet: a composed child sizes against a chosen loaded device (multi-device), persisted', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  // Load a second device so children have a choice — one that sweeps the drain and body bias
  // the cascode's devices state, so a child pointed at it is really sized on it. The import
  // accumulates and becomes active, so switch back to the demo (the cascode's defaults size
  // cleanly on it).
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/demo-half.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo active
  await expect(page.locator('header .device')).toContainText('nmos_demo');

  // Add a composed sheet (the cascode); its child gets a per-child device picker now that >1
  // device is loaded.
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'NMOS cascode (gain-boosted output)');
  const child = sp.locator('.suse', { hasText: 'cs' });
  await expect(child.locator('.dsel')).toBeVisible();

  // The child inherits the active (demo) device; point it at the imported device → a different
  // table re-sizes the block. That device carries half the current per unit width, so the same
  // 20 µA needs twice the width: the block still sizes, and its card shows different numbers.
  await expect(child).toHaveClass(/st-pass/);
  const before = (await child.locator('.susebind').textContent())?.trim();
  await child.locator('.dsel').selectOption({ index: 2 }); // the imported nmos_half
  await expect
    .poll(async () => (await child.locator('.susebind').textContent())?.trim())
    .not.toBe(before);
  await expect(child).toHaveClass(/st-pass/);
  await expect(sp.locator('.feasb')).toHaveText(/^(in)?feasible/); // a verdict, on both devices

  // Both the choice AND the device survive a reload (tables restore from local storage),
  // so the child keeps sizing against the picked table.
  await page.reload();
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.suse', { hasText: 'cs' }).locator('.dsel')).toHaveValue(/nmos_half/);
  await expect(sp2.locator('.pwarn', { hasText: 'nmos_half' })).toHaveCount(0);
  await expect(sp2.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-pass/);

  // Removing the chosen device leaves the choice set-but-absent: the run is refused before the
  // engine sees it and says which device is missing — not a design that fails, and never a
  // silent fallback to the active device. The block still renders its device control, since
  // that is what the refusal is fixed with.
  await page.locator('.devices .dev', { hasText: 'nmos_half' }).locator('.drm').click();
  await expect(sp2.locator('[data-not-evaluated]')).toContainText('nmos_half');
  await expect(sp2.locator('.feasb')).toHaveText('not evaluated');
  await expect(sp2.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-skip/);
  await expect(sp2.locator('.suse', { hasText: 'cs' }).locator('.dsel')).toContainText(
    'not loaded',
  );

  expect(errors).toEqual([]);
});

test('design sheet: two loaded devices sharing a label are each individually selectable (unique keys)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  // Two DIFFERENT tables that share the same display label (device·corner·temp) with different
  // data — and EACH declaring its own process namespace, which is what keeps them two devices
  // rather than one device claiming the same condition twice. Declaring on one file alone would
  // not separate them: an undeclared namespace joins the sole declared candidate of the same
  // name (the re-export upgrade path), so a deliberate name collision must be declared on both.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample-fab.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2); // demo + first import
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample-alt.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(3); // demo + two same-label nch_lvt
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo active (sizes the parent)

  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'NMOS cascode (gain-boosted output)');
  const dsel = sp.locator('.suse', { hasText: 'cs' }).locator('.dsel');

  // The two same-named devices appear as DISTINCT options, told apart by the process namespace
  // one of them declares — not collapsed into a single unselectable entry, and not merged into
  // one device because their display labels happen to match.
  const opts = dsel.locator('option');
  await expect(opts.filter({ hasText: 'nch_lvt' })).toHaveCount(2);
  await expect(opts.filter({ hasText: 'otherfab' })).toHaveCount(1);

  // Selecting the namespaced one takes effect AND the device RESOLVES (no "device … did not
  // resolve"; the binding named the right one). The child states a drain voltage and that
  // fixture sweeps only length and gate voltage, so the block is refused there — its card says
  // why, which it could only do having been asked on that table and not on the demo it inherits.
  const second = await opts.filter({ hasText: 'otherfab' }).getAttribute('value');
  await dsel.selectOption(second!);
  await expect(sp.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-fail/);
  await expect(sp.locator('.suse', { hasText: 'cs' }).locator('.perr')).toContainText(
    'no vds sweep',
  );
  await expect(sp.locator('.pwarn', { hasText: 'device "' })).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('design sheet: a table that lacks a sweep the sheet uses refuses the device, with the reason and no verdict', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // The demo device characterized body-grounded only: it sweeps the drain voltage and has no
  // body-bias column. The import says what that rules out, as information beside the QA.
  await loadDemoNoVsb(page);
  await expect(page.locator('.qa .w.info', { hasText: 'no-vsb-sweep' })).toBeVisible();
  await expect(page.locator('.qa')).not.toContainText('no-vds-sweep');

  // A sheet whose device sits with its source at its body does not use the missing sweep: it
  // is sized on this table and gets its verdict.
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'Single NMOS gm/ID sizing');
  await expect(sp.locator('.feasb')).toHaveText(/^(in)?feasible/);
  await expect(sp.locator('.shead .bind')).toContainText('W=');
  await expect(sp.locator('[data-not-evaluated]')).toHaveCount(0);

  // The cascode stands its upper device on the node between the two, 0.3 V above its body.
  // This table cannot answer for that bias, so the device is not sized: no verdict and no
  // sized line — the reason instead, naming the given and the sweep the table lacks.
  await pickSheet(sp, 'NMOS cascode (gain-boosted output)');
  await expect(sp.locator('.feasb')).toHaveText('no answer');
  await expect(sp.locator('[data-not-evaluated]')).toContainText('given vsb = 0.3');
  await expect(sp.locator('[data-not-evaluated]')).toContainText('no vsb sweep');
  await expect(sp.locator('.shead .bind')).toHaveCount(0);
  await expect(sp.locator('.shead .perr')).toContainText('no vsb sweep');
  // The block under it has its source at its body, and still sizes.
  await expect(sp.locator('.suse', { hasText: 'cs' })).toHaveClass(/st-pass/);

  // A device whose givens leave the body bias out is sized at the default the table was taken
  // at, and the bias is marked as assumed, as it is on a table that sweeps it.
  await pickSheet(sp, 'Gm-C filter pole');
  await expect(sp.locator('.shead .bind')).toContainText('W=');
  await expect(sp.locator('.shead .sbias')).toContainText(/vsb 0\s*V\?/);

  expect(errors).toEqual([]);
});

test('design sheet: a failing advisory check reads as advisory, distinct from a hard failure', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // At the default gm/ID = 12 two checks fail with DIFFERENT severities: headroom (a physical
  // check, a hard failure) and gbw-margin (an advisory check). Only the advisory check carries the
  // advisory marker + wording — the two must be visually distinct (the audit finding this
  // addresses).
  const headroom = sp.locator('.srules tr', { hasText: 'headroom' });
  const gbw = sp.locator('.srules tr', { hasText: 'gbw-margin' });
  await expect(headroom).toHaveClass(/st-fail/);
  await expect(headroom).not.toHaveClass(/advisory/);
  await expect(gbw).toHaveClass(/st-fail/);
  await expect(gbw).toHaveClass(/advisory/);
  await expect(gbw).toContainText('advisory');

  // Lower the efficiency knob so every HARD check passes → the design is feasible-labeled, yet the
  // advisory check still fails (cgg loads GBW below target) and still reads advisory — a red
  // advisory check over a feasible design must not look like the design failed.
  const gmId = sp.locator('.svar[data-param="gm_id"]').locator('.num');
  await gmId.fill('8');
  await gmId.blur();
  await expect(sp.locator('.feasb')).toHaveClass(/ok/);
  await expect(gbw).toHaveClass(/st-fail/);
  await expect(gbw).toHaveClass(/advisory/);
});

test('design sheet: a second sweep param renders a 2-D feasibility heatmap, persisted', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // First sweep param → the 1-D margin chart.
  await sp.locator('.swsel select').selectOption('gm_id');
  await expect(sp.locator('.pchart canvas')).toBeVisible();

  // Add the second (×) param → the heatmap replaces the 1-D chart, with a caption that names what
  // limits the region.
  await sp.locator('.swsel2 select').selectOption('L');
  const canvas = sp.locator('.smapc');
  await expect(canvas).toBeVisible();
  await expect(sp.locator('.pchart')).toHaveCount(0);
  await expect(sp.locator('.scap')).toContainText('×');

  // The heatmap canvas has a real (nonzero) size.
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  // The second param survives a reload through the dashboard sanitizer.
  await page.reload();
  await loadDemo(page);
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.swsel2 select')).toHaveValue('L');
  await expect(sp2.locator('.smapc')).toBeVisible();

  expect(errors).toEqual([]);
});

test('design sheet: a param note surfaces as a title tooltip', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // The CL spec param carries a note; it shows as the param row's title attribute.
  await expect(sp.locator('.svar', { hasText: 'CL' })).toHaveAttribute('title', 'load capacitance');
});

test('design sheet: library topologies load from the grouped picker and evaluate', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // The picker groups examples and the curated library; load a Stages topology by title.
  await pickSheet(sp, 'CS amp, current-source load');
  await expect(sp.locator('.shead')).toContainText('CS amp, current-source load');

  // The input device is a block sized from the bandwidth spec, and the load is a second block
  // that reads its current; both cards show the sized width and the stated operating point, and
  // the sheet is feasible at defaults (the core golden pins the same numbers).
  const input = sp.locator('.suse', { hasText: 'input device' });
  await expect(input.locator('.susebind')).toContainText('W=');
  await expect(input.locator('.sbias')).toContainText('vds');
  await expect(sp.locator('.suse', { hasText: 'load' })).toBeVisible();
  await expect(sp.locator('.feasb')).toHaveText('feasible');

  // The targets it opens with are an example specification, labelled as one: a plausible number
  // for the class, to be replaced by the design's own.
  const example = sp.locator('[data-example-spec]');
  await expect(example.locator('.glabel')).toHaveText('example spec — replace with your design’s');
  await expect(example.locator('.glabel')).toHaveAttribute('title', /not a requirement/);
  await expect(example.locator('.svar[data-param="GBW_target"]')).toBeVisible();

  // Each block owns its operating point: a per-block bias control shows the vds axis, typeset
  // (V_DS). The curated sheet drives vds from a param, so the block links to it read-only rather
  // than borrowing the (now retired) shared dashboard slider.
  await expect(input.locator('.sbiasctl .bx sub').first()).toHaveText('DS'); // V_DS
  await expect(input.locator('.sbiasctl .bx.ro').first()).toBeVisible();

  // Equations render (not raw source) and the author notes are shown in place, so a
  // designer can read what each equation computes and why without opening the JSON.
  const gainRow = sp.locator('.srow', { hasText: 'Av' }).first();
  await expect(gainRow.locator('.seq sub')).not.toHaveCount(0); // subscripted g_m/g_ds, not "gm"
  await expect(sp.locator('.srows .snote').first()).toBeVisible();
  // A check's physical-meaning note sits under its rendered comparison.
  await expect(sp.locator('.srules .snote').first()).toBeVisible();

  // Authored names typeset instead of showing raw underscores: a composed provide renders the
  // quantity with the block as a subscript (load__gm → g_{m,load}), and check operators prettify.
  await expect(sp.locator('.suse .prov code sub').first()).not.toHaveCount(0);
  await expect(sp.locator('.srules')).toContainText('≥');

  // The picker offers titles ONLY: a verdict at a sheet's shipped defaults would read as a
  // recommendation while saying nothing about whether that topology can meet the user's spec.
  const options = sp.locator('.shead select.rm option:not([value=""])');
  await expect(options.first()).not.toHaveText(/^[✓✗]/);

  // A composed multi-child library sheet (no parent givens) loads from another group.
  await pickSheet(sp, '5T OTA');
  await expect(sp.locator('.shead')).toContainText('5T OTA');
  // Six blocks: the bias reference and the tail device that mirrors it, the two transistors of
  // the input pair, and the two sides of the mirror load.
  await expect(sp.locator('.suse')).toHaveCount(6);
  await expect(sp.locator('.srules tr').first()).toBeVisible();
  // Each composed block explains itself: the author's description of what the device IS in the
  // topology, typeset (the 5T's blocks all carry $V_{GS}$-style math in that prose).
  await expect(sp.locator('.suse .sudesc').first()).toBeVisible();
  await expect(sp.locator('.suse .sudesc sub').first()).not.toHaveCount(0);
  // An infeasible verdict names the binding check rather than stopping at "infeasible".
  const badge = sp.locator('.shead .feasb');
  if ((await badge.getAttribute('class'))?.includes('no'))
    await expect(badge.locator('i')).not.toHaveCount(0);

  expect(errors).toEqual([]);
});

test('design sheet: a by-reference child resolves live, flattens to a frozen export, detaches to a local copy', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // The Miller OTA's stage-2 load is included BY REFERENCE from the curated library:
  // the child card resolves, sizes, and wears the library id as a provenance badge.
  await pickSheet(sp, 'Two-stage Miller OTA');
  await expect(sp.locator('.shead')).toContainText('Two-stage Miller OTA');
  const ld2 = sp.locator('.suse', { hasText: 'ld2' });
  await expect(ld2.locator('.refb')).toContainText('multistage/stage2-current-source-load');
  await expect(ld2.locator('.susebind')).toContainText('W=');
  await expect(sp.locator('.pwarn', { hasText: 'ref' })).toHaveCount(0);
  await page.screenshot({ path: `${SCREENS}/sheet-ref.png`, fullPage: true });

  // Flatten export: the download inlines the referenced block — no `ref` keys survive,
  // the child doc is embedded, and the file is named after the sheet.
  const dlPromise = page.waitForEvent('download');
  await sp.locator('.sexp button', { hasText: 'flat' }).click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('two-stage-miller-ota.json');
  const flatText = readFileSync((await dl.path()) as string, 'utf8');
  expect(flatText).not.toContain('"ref"');
  expect(flatText).toContain('Stage-2 current-source load');

  // Detach: the reference becomes an embedded local copy — badge gone, sizing intact,
  // and the block's operating point is now shown by the local bias control (read-only
  // here: the block drives vds from a param). Survives a reload via the sanitizer.
  await ld2.locator('.detach').click();
  await expect(ld2.locator('.refb')).toHaveCount(0);
  await expect(ld2.locator('.susebind')).toContainText('W=');
  await expect(ld2.locator('.sbiasctl .bx.ro')).toBeVisible();
  await page.reload();
  await loadDemo(page);
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('.suse', { hasText: 'ld2' }).locator('.refb')).toHaveCount(0);
  await expect(sp2.locator('.suse', { hasText: 'ld2' }).locator('.susebind')).toContainText('W=');

  expect(errors).toEqual([]);
});

test('design sheet: a nested block inherits its parent block’s device, and is rebound from its own menu once local', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  // A second device the leaf really sizes on, at half the current per unit width — the same
  // current needs twice the width there, so which device a block reads shows in its own numbers.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/demo-half.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo active
  await expect(page.locator('header .device')).toContainText('nmos_demo');

  // A sub-sheet whose device is a block of its own, and a sheet that includes it by reference.
  const sheetFile = (name: string, doc: object) => ({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await page.locator('.load input[type=file]').setInputFiles(
    sheetFile('nested-stage.json', {
      title: 'Nested stage',
      formatVersion: 2,
      params: [],
      equations: [],
      checks: [],
      // The leaf names no wires of its own, so the block that composes it does.
      levels: { out: '0.6' },
      ports: ['in'],
      blocks: [
        {
          name: 'cs',
          nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
          doc: {
            title: 'Leaf',
            polarity: 'n',
            params: [
              { name: 'L', value: 5e-7 },
              { name: 'Ib', value: 2e-5 },
            ],
            givens: { L: 'L', gm_id: '12', id: 'Ib', vds: '0.6' },
            equations: [],
            checks: [],
          },
        },
      ],
    }),
  );
  await page.locator('.load input[type=file]').setInputFiles(
    sheetFile('nested-outer.json', {
      title: 'Nested outer',
      // The stage wires itself, so this sheet states wiring too: it connects the stage through
      // the block's port map, its one port left open.
      formatVersion: 2,
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'st', ref: 'user/nested-stage', ports: { in: null } }],
    }),
  );

  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'Nested outer');
  const st = sp.locator('.suse').first();
  const stMenu = st.locator('.suseh').first().locator('.dsel');
  const cs = sp.locator('.suse .suse');
  const width = async () => (await cs.locator('.susebind').textContent())?.trim();
  await expect(cs).toHaveCount(1);
  await expect(cs).toHaveClass(/st-pass/);
  const onDemo = await width();

  // Inside the reference the leaf belongs to the library sheet: no menu of its own. It names no
  // device, so it reads whatever its parent block does — rebinding `st` moves it.
  await expect(cs.locator('.dsel')).toHaveCount(0);
  await stMenu.selectOption({ label: 'nmos_half' });
  await expect.poll(width).not.toBe(onDemo);
  const onHalf = await width();
  await stMenu.selectOption({ index: 0 }); // back to the active device
  await expect.poll(width).toBe(onDemo);

  // Detached, the leaf's entry is part of this sheet, so it gets a menu — inheriting from the
  // enclosing block, not from the active device — and a binding of its own.
  await st.locator('.detach').click();
  const csMenu = cs.locator('.dsel');
  await expect(csMenu).toBeVisible();
  await expect(csMenu.locator('option').first()).toHaveText('↳ parent block’s device');
  await csMenu.selectOption({ label: 'nmos_half' });
  await expect.poll(width).toBe(onHalf);
  await expect(cs).toHaveClass(/st-pass/);
  await expect(stMenu).toHaveValue(''); // only the leaf moved

  // The binding is written into the sheet, so it survives a reload.
  await page.reload();
  await expect(page.locator('.devices .dlabel').first()).toHaveText('devices (2)');
  const cs2 = page.locator('.grid .panel').last().locator('.suse .suse');
  await expect(cs2.locator('.dsel')).toHaveValue(/nmos_half/);
  await expect(cs2.locator('.susebind')).toHaveText(onHalf as string);

  expect(errors).toEqual([]);
});

test('composed sheet: a signed-PMOS child with its sign param still +1 gets a root-cause hint', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/pmos-demo.mostab.csv');
  await page.locator('.devices .dev').first().locator('.dname').click(); // NMOS active

  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  // The diode-load stage used to carry this hint; declaring the connection retired its sign
  // param, because the vds = vgs diagonal follows whichever convention the table itself uses.
  // The hint still matters wherever a child's vds is an AUTHORED expression, as here.
  await pickSheet(sp, '5T OTA');

  // Until they are bound, the p-channel load devices are sized on the active NMOS table, which
  // declares the other polarity: said once per block, for the run — the range-end chips, which
  // re-evaluate the same binding, do not repeat it.
  const inherited = sp.locator('.pwarn', { hasText: 'names no device, so it is sized on' });
  await expect(inherited.filter({ hasText: 'block "ld"' })).toHaveCount(1);
  await expect(inherited.filter({ hasText: 'block "ldr"' })).toHaveCount(1);
  await expect(sp.locator('[data-range-end]').first()).toBeVisible();
  await expect(sp.locator('[data-range-end][title*="names no device"]')).toHaveCount(0);

  // Bind both sides of the mirror load to the signed PMOS table — they share a gate, so they
  // are read from one table. Only the output side's vds is authored, and ld_sign still reads +1,
  // so the panel names the ONE root cause instead of a wall of derived n/a warnings. The diode
  // side has no sign param and gets no hint: its drain follows its own gate.
  for (const name of ['ldr', 'ld']) {
    const block = sp.locator('.suse', {
      has: page.locator('.suseh b', { hasText: new RegExp(`^${name}$`) }),
    });
    await block.locator('.dsel').selectOption({ index: 2 });
  }
  await expect(sp.locator('.pwarn', { hasText: 'set ld_sign = -1' })).toBeVisible();
  await expect(sp.locator('.pwarn', { hasText: 'ldr_sign' })).toHaveCount(0);
  await expect(inherited).toHaveCount(0); // bound to a p-channel table: nothing to compare

  // Fixing the param clears the hint.
  const sign = sp.locator('.svar[data-param="ld_sign"] .num');
  await sign.fill('-1');
  await sign.blur();
  await expect(sp.locator('.pwarn', { hasText: 'set ld_sign = -1' })).toHaveCount(0);
});

test('design sheet: an imported fT given survives import and reload (not silently stripped)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // A sheet that states a speed spec directly. Every save/restore path runs the document
  // through the same sanitizer, so a given quantity it does not recognise is deleted — which
  // turns these legal two-quantity givens into "needs exactly two" on the next reload.
  await page.locator('.load input[type=file]').setInputFiles({
    name: 'speed-spec.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Speed spec',
        polarity: 'n',
        formatVersion: 2,
        params: [
          { name: 'L', value: 5e-7 },
          { name: 'ft_target', value: 2e9 },
          { name: 'Ib', value: 2e-5 },
        ],
        givens: { L: 'L', ft: 'ft_target', id: 'Ib', vds: '0.9' },
        nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
        levels: { out: '0.9' },
        ports: ['in'],
        equations: [{ name: 'speed', expr: 'ft' }],
        checks: [],
      }),
    ),
  });

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Speed spec');
  const sheet = page.locator('.sheet').first();
  await expect(sheet).toContainText('speed');
  await expect(sheet).not.toContainText('exactly two');

  // And again after a reload, which restores the sheet from persisted state.
  await page.reload();
  const after = page.locator('.sheet').first();
  await expect(after).toContainText('speed');
  await expect(after).not.toContainText('exactly two');

  expect(errors).toEqual([]);
});

test('design sheet: an imported solveFor survives import and reload (not silently stripped)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // `vstar_est` is solved: it drives gm/ID, and solves for the vstar that results, searched in
  // its [min, max]. Its authored value of 0.3 deliberately FAILS the physical check; the root
  // (~0.22) passes it. So the check chip reports whether the loop was actually closed — and if the
  // sanitizer drops solveFor on the way in or out of storage, the sheet silently reverts to the
  // stale value and this check fails.
  await page.locator('.load input[type=file]').setInputFiles({
    name: 'solved-loop.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Solved bias loop',
        polarity: 'n',
        formatVersion: 2,
        params: [
          { name: 'L', value: 5e-7 },
          { name: 'Ib', value: 1e-5 },
          { name: 'vstar_est', value: 0.3, min: 0.05, max: 0.6, solveFor: 'vstar_actual' },
        ],
        givens: { L: 'L', id: 'Ib', gm_id: '8 + 5*vstar_est', vds: '0.9' },
        nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
        levels: { out: '0.9' },
        ports: ['in'],
        equations: [{ name: 'vstar_actual', expr: 'vstar' }],
        checks: [{ id: 'loop-closed', kind: 'physical', lhs: 'vstar_est', op: '<=', rhs: '0.25' }],
      }),
    ),
  });

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Solved bias loop');
  const sheet = page.locator('.sheet').first();
  await expect(sheet.locator('.srules tr.st-pass')).toHaveCount(1);
  await expect(sheet.locator('.srules tr.st-fail')).toHaveCount(0);

  // And again after a reload, which restores the sheet from persisted state.
  await page.reload();
  const after = page.locator('.sheet').first();
  await expect(after.locator('.srules tr.st-pass')).toHaveCount(1);
  await expect(after.locator('.srules tr.st-fail')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('design sheet: an imported diode connection survives import and reload (not silently stripped)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // The connection is a BOOLEAN in givens whose other members are all expression strings, so a
  // sanitizer that type-checks every member as a string deletes it — leaving the device with no
  // vds at all. The check below reads the drop the diagonal produced: on the demo device a diode
  // sits well above 0.2 V, and a stripped connection makes the sizing fail outright rather than
  // report a smaller number, so the chip catches either outcome. The wires state the same
  // connection — the gate on the drain wire — and the flag agrees with them.
  await page.locator('.load input[type=file]').setInputFiles({
    name: 'diode-block.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Diode connection',
        polarity: 'n',
        formatVersion: 2,
        params: [
          { name: 'L', value: 5e-7 },
          { name: 'Ib', value: 1e-5 },
        ],
        givens: { L: 'L', id: 'Ib', gm_id: '10', diode: true },
        nodes: { d: 'd', g: 'd', s: 'gnd', b: 'gnd' },
        ports: ['d'],
        equations: [{ name: 'drop', expr: 'vgs' }],
        checks: [{ id: 'diode-drop', kind: 'physical', lhs: 'drop', op: '>=', rhs: '0.2' }],
      }),
    ),
  });

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Diode connection');
  const sheet = page.locator('.sheet').first();
  await expect(sheet.locator('.srules tr.st-pass')).toHaveCount(1);
  await expect(sheet.locator('.srules tr.st-fail')).toHaveCount(0);
  // The imported copy keeps both statements of the connection: the flag and the wires.
  const stored = await page.evaluate(() => localStorage.getItem('gmid.sheets.v2') ?? '');
  expect(stored).toContain('"diode":true');
  expect(stored).toContain('"nodes":{"d":"d","g":"d","s":"gnd","b":"gnd"}');

  await page.reload();
  const after = page.locator('.sheet').first();
  await expect(after.locator('.srules tr.st-pass')).toHaveCount(1);
  await expect(after.locator('.srules tr.st-fail')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('design sheet: a sheet written with the earlier key names still imports and runs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // Every renamed key at once: rows, rules and their kinds, a pin, and a child under uses that
  // publishes through provide. The check passes only at the constrained root (x = 0.25, so y = 0.5
  // and z = c__w + y = 1.5), so a key dropped on the way in would show as a missing or failing
  // check.
  await page.locator('.load input[type=file]').setInputFiles({
    name: 'earlier-keys.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Earlier keys',
        polarity: 'n',
        params: [{ name: 'x', value: 0.3, min: 0, max: 1, pin: { lhs: 'y', rhs: '0.5' } }],
        uses: [
          {
            name: 'c',
            doc: {
              title: 'child',
              polarity: 'n',
              params: [{ name: 'k', value: 1 }],
              rows: [{ name: 'w', expr: 'k' }],
              rules: [],
              provide: ['w'],
            },
          },
        ],
        rows: [
          { name: 'y', expr: '2*x' },
          { name: 'z', expr: 'c__w + y' },
        ],
        rules: [{ id: 'at-root', kind: 'invariant', lhs: 'abs(z - 1.5)', op: '<=', rhs: '0.001' }],
      }),
    ),
  });
  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Earlier keys');
  const sheet = page.locator('.sheet').first();
  await expect(sheet.locator('.srules tr.st-pass')).toHaveCount(1);
  await expect(sheet.locator('.srules tr.st-fail')).toHaveCount(0);

  // What is kept is the current spelling only: the stored copy carries no earlier key.
  const stored = await page.evaluate(() => localStorage.getItem('gmid.sheets.v2') ?? '');
  expect(stored).toContain('"equations"');
  expect(stored).toContain('"designConstraint"');
  expect(stored).toContain('"physical"');
  for (const old of ['"rows"', '"rules"', '"uses"', '"provide"', '"pin"', '"invariant"'])
    expect(stored).not.toContain(old);

  // A key written in both spellings is ambiguous, and is refused rather than merged.
  await page.locator('.load input[type=file]').setInputFiles({
    name: 'two-spellings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Two spellings',
        polarity: 'n',
        params: [],
        rows: [{ name: 'y', expr: '1' }],
        equations: [{ name: 'y', expr: '2' }],
        checks: [],
      }),
    ),
  });
  await expect(page.locator('.qa.error')).toContainText('rows and equations');

  expect(errors).toEqual([]);
});

test('design sheet: an imported hold survives import and reload, and its gate bias is shown', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // A hold changes nothing at the design point, so a loader that dropped it would leave every
  // check and value as they were. The readout is what shows it is still there: the held
  // expression and what it came to, X + B = 0.2 + 0.1.
  await page.locator('.load input[type=file]').setInputFiles({
    name: 'held-node.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Held node',
        polarity: 'n',
        params: [
          { name: 'X', value: 0.2, min: 0, max: 1, hold: 'X + B' },
          { name: 'B', value: 0.1 },
        ],
        equations: [],
        checks: [{ id: 'ok', kind: 'physical', lhs: 'X', op: '>=', rhs: '0' }],
      }),
    ),
  });

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Held node');
  const held = page.locator('.sheet').first().locator('[data-held]');
  await expect(held).toContainText('holds X + B at 300m');

  await page.reload();
  await expect(page.locator('.sheet').first().locator('[data-held]')).toContainText(
    'holds X + B at 300m',
  );

  expect(errors).toEqual([]);
});

test('design sheet: an imported design constraint survives import and reload (not silently stripped)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // The design constraint is an OBJECT on a param whose siblings are scalars, so a sanitizer that
  // only carries known scalar fields deletes it — and the param then silently reverts to its stored
  // default. The check below passes only at the solved root (x = 0.25), never at the default (0.3).
  await page.locator('.load input[type=file]').setInputFiles({
    name: 'constrained-node.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Constrained node',
        polarity: 'n',
        params: [
          { name: 'x', value: 0.3, min: 0, max: 1, designConstraint: { lhs: 'y', rhs: '0.5' } },
        ],
        equations: [{ name: 'y', expr: '2*x' }],
        checks: [{ id: 'at-root', kind: 'physical', lhs: 'abs(x - 0.25)', op: '<=', rhs: '0.001' }],
      }),
    ),
  });

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Constrained node');
  const sheet = page.locator('.sheet').first();
  await expect(sheet.locator('.srules tr.st-pass')).toHaveCount(1);
  await expect(sheet.locator('.srules tr.st-fail')).toHaveCount(0);

  await page.reload();
  const after = page.locator('.sheet').first();
  await expect(after.locator('.srules tr.st-pass')).toHaveCount(1);
  await expect(after.locator('.srules tr.st-fail')).toHaveCount(0);

  expect(errors).toEqual([]);
});

/** A one-device sheet whose drain bias is the voltage param `V_d`, given DC-level class `cls`
 *  (none when omitted). The drain wire is a port rather than a held wire: a level an assumed
 *  param states may not hold a wire, and the drain bias here is the assumption under test. */
const vdSheet = (title: string, cls?: string) => ({
  title,
  polarity: 'n',
  formatVersion: 2,
  params: [
    { name: 'L', value: 5e-7 },
    { name: 'Ib', value: 1e-5 },
    { name: 'V_d', value: 0.6, unit: 'V', ...(cls === undefined ? {} : { class: cls }) },
  ],
  givens: { L: 'L', id: 'Ib', gm_id: '10', vds: 'V_d' },
  nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
  ports: ['in', 'out'],
  equations: [],
  checks: [],
});

test('design sheet: a DC-level class survives import and reload, and the assumption is listed', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // `V_d` is a voltage the device is biased from, so it must carry a class. A sanitizer that
  // drops the field turns it back into an unclassified DC input, which is a validation error —
  // the verdict would flip to infeasible and the assumption line would vanish.
  const load = (name: string, cls: string) =>
    page.locator('.load input[type=file]').setInputFiles({
      name,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(vdSheet(`Classed level ${cls}`, cls))),
    });
  await load('classed-level.json', 'assumed');

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Classed level assumed');
  const sheet = page.locator('.sheet').first();
  await expect(sheet.locator('.feasb')).toHaveText('feasible');
  await expect(sheet.locator('.sassume')).toHaveText('sized under 1 assumption: V_d');

  await page.reload();
  const after = page.locator('.sheet').first();
  await expect(after.locator('.feasb')).toHaveText('feasible');
  await expect(after.locator('.sassume')).toHaveText('sized under 1 assumption: V_d');

  // "solved" is derived from designConstraint/solveFor, never written — an import carrying it is
  // refused by name rather than silently losing the class.
  await load('solved-level.json', 'solved');
  await expect(page.locator('.qa.error')).toContainText(
    'malformed sheet content at params[2].class',
  );

  expect(errors).toEqual([]);
});

test('design sheet: a stored sheet from before DC-input classes is kept, and says what it needs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // A sheet persisted before classes existed: its voltage bias carries none. It must survive the
  // boot that follows — dropping it would delete the user's work without a word — and the reason
  // it no longer validates must show when it is opened: a sheet that does not validate is not
  // evaluated, and the refusal names what is missing.
  await page.evaluate(
    (doc) => localStorage.setItem('gmid.sheets', JSON.stringify([{ name: 'old-sheet', doc }])),
    vdSheet('Stored before classes'),
  );
  await page.reload();
  await loadDemo(page);
  await expect(page.locator('.usheets .dev', { hasText: 'old-sheet' })).toBeVisible();

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Stored before classes');
  const sheet = page.locator('.sheet').first();
  await expect(sheet.locator('.feasb')).toHaveText('not evaluated');
  await expect(sheet.locator('.sissue', { hasText: '"V_d"' }).first()).toContainText(
    'carries no class',
  );

  expect(errors).toEqual([]);
});

test('design sheet: a stored sheet that fails validation is kept, opens with its error unevaluated, and can be removed', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // Two checks share an id, which validation refuses (`sheet-check`): results are keyed by check
  // id. The stored sheet stays in the library across boots; the user, not the loader, removes it.
  const doc = {
    ...vdSheet('Stored with a duplicate check id', 'independent'),
    checks: [
      { id: 'ib-range', kind: 'spec', lhs: 'Ib', op: '>=', rhs: '1e-6' },
      { id: 'ib-range', kind: 'spec', lhs: 'Ib', op: '<=', rhs: '1e-4' },
    ],
  };
  await page.evaluate(
    (d) => localStorage.setItem('gmid.sheets.v2', JSON.stringify([{ name: 'dup-check', doc: d }])),
    doc,
  );
  await page.reload();
  await loadDemo(page);
  const entry = page.locator('.usheets .dev', { hasText: 'dup-check' });
  await expect(entry).toBeVisible();

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Stored with a duplicate check id');
  const sheet = page.locator('.sheet').first();
  await expect(sheet.locator('.svar[data-param="V_d"]')).toBeVisible();
  await expect(sheet.locator('.feasb')).toHaveText('not evaluated');
  await expect(sheet.locator('.sissue').first()).toContainText('duplicate check id "ib-range"');

  await entry.locator('.drm').click();
  await expect(entry).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem('gmid.sheets.v2'));
  expect(JSON.parse(stored ?? '[]')).toEqual([]);

  expect(errors).toEqual([]);
});

test('design sheet: imported sheets join the library — pickable, referenceable, removable, persistent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // Import two sheets through the same load control as a CSV: a block with no givens, and a
  // top sheet that includes it BY REFERENCE (user sheets resolve like curated ones).
  const asFile = (name: string, doc: object) => ({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const input = page.locator('.load input[type=file]');
  await input.setInputFiles(
    asFile('my-block.json', {
      title: 'My block',
      polarity: 'n',
      params: [{ name: 'x', value: 2 }],
      equations: [{ name: 'y', expr: '2*x' }],
      checks: [],
      provides: ['y'],
    }),
  );
  await expect(page.locator('.usheets .dev', { hasText: 'my-block' })).toBeVisible();

  // An absurdly large "sheet" is refused before parse/persist (a real sheet is a few
  // KB) — otherwise it would be saved to localStorage and re-hang every future load.
  await input.setInputFiles({
    name: 'huge.json',
    mimeType: 'application/json',
    buffer: Buffer.from(`{"title":"x","pad":"${'x'.repeat(2_100_000)}"}`),
  });
  await expect(page.locator('.qa.error')).toContainText('refusing to import');
  await expect(page.locator('.usheets .dev', { hasText: 'huge' })).toHaveCount(0);

  // A sheet whose check is malformed (mistyped op) is REJECTED, not imported with the
  // check silently dropped — a dropped check would read feasible without the requirement.
  await input.setInputFiles(
    asFile('bad-check.json', {
      title: 'Bad check',
      polarity: 'n',
      params: [{ name: 'x', value: 2 }],
      equations: [{ name: 'y', expr: '2*x' }],
      checks: [{ id: 'y-max', kind: 'spec', lhs: 'y', op: '=<', rhs: '10' }],
    }),
  );
  await expect(page.locator('.qa.error')).toContainText('malformed sheet content at checks[0]');
  await expect(page.locator('.usheets .dev', { hasText: 'bad-check' })).toHaveCount(0);

  // Same for a malformed FIELD inside a kept entry: a non-string device binding
  // would silently inherit the parent's table — reject, do not repair.
  await input.setInputFiles(
    asFile('bad-device.json', {
      title: 'Bad device',
      polarity: 'n',
      params: [{ name: 'x', value: 2 }],
      equations: [{ name: 'y', expr: '2*x' }],
      checks: [],
      blocks: [{ name: 'b', ref: 'my-block', device: 7 }],
    }),
  );
  await expect(page.locator('.qa.error')).toContainText(
    'malformed sheet content at blocks[0].device',
  );
  await expect(page.locator('.usheets .dev', { hasText: 'bad-device' })).toHaveCount(0);

  // A key the core does not know is rejected on the same footing: the sanitizer rebuilds each
  // container field by field, so an unrecognized one is dropped as surely as a malformed one —
  // silently, until it is recorded. That silence is how a legal fT given and a legal design
  // constraint were lost.
  await input.setInputFiles(
    asFile('unknown-key.json', {
      title: 'Unknown key',
      polarity: 'n',
      params: [{ name: 'x', value: 2, sweep: true }],
      equations: [{ name: 'y', expr: '2*x' }],
      checks: [],
    }),
  );
  await expect(page.locator('.qa.error')).toContainText(
    'malformed sheet content at params[0].sweep',
  );
  await expect(page.locator('.usheets .dev', { hasText: 'unknown-key' })).toHaveCount(0);

  await input.setInputFiles(
    asFile('my-top.json', {
      title: 'My top',
      polarity: 'n',
      params: [{ name: 'x_top', value: 3 }],
      equations: [{ name: 'z', expr: 'b__y + 1' }],
      checks: [{ id: 'z-min', kind: 'spec', lhs: 'z', op: '>=', rhs: '1' }],
      blocks: [{ name: 'b', ref: 'my-block', params: { x: 'x_top' } }],
    }),
  );

  // Both appear in the picker's "Your sheets" group; the top sheet resolves its user ref:
  // the child card carries the badge, the provide flows (y = 2·3 = 6 → z = 7), feasible.
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'My top');
  await expect(sp.locator('.shead')).toContainText('My top');
  await expect(sp.locator('.suse .refb')).toContainText('my-block');
  await expect(sp.locator('.suse .prov')).toContainText('6');
  await expect(sp.locator('.srow', { hasText: 'z' })).toContainText('7');
  await expect(sp.locator('.feasb')).toHaveText('feasible');

  // Imported sheets persist across a reload (the runtime stand-in for the sheets/ folder).
  await page.reload();
  await loadDemo(page);
  await expect(page.locator('.usheets .dev', { hasText: 'my-top' })).toBeVisible();
  const sp3 = page.locator('.grid .panel').last();
  await expect(sp3.locator('.suse .refb')).toContainText('my-block');
  await expect(sp3.locator('.feasb')).toHaveText('feasible');

  // Removing the referenced sheet fails closed: the document no longer assembles, so it is not
  // evaluated at all — an error naming the missing ref, never a silent fallback and never a
  // verdict about a design that could not be built.
  await page.locator('.usheets .dev', { hasText: 'my-block' }).locator('.drm').click();
  await expect(sp3.locator('.feasb')).toHaveText('not evaluated');
  await expect(sp3.locator('.pwarn', { hasText: 'my-block' }).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test('discoverability: device bar counts from the first import, child picker labeled, provenance popover', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  // The devices bar shows from the FIRST import, with a count — a second import
  // must read as "accumulates", not "replaces".
  await expect(page.locator('.devices .dlabel')).toHaveText('devices (1)');

  // A composed sheet's child offers its labeled device picker even with one device loaded.
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'NMOS cascode (gain-boosted output)');
  const child = sp.locator('.suse', { hasText: 'cs' });
  await expect(child.locator('.dsl').first()).toHaveText('device');
  await expect(child.locator('.dsel').first()).toBeVisible();

  // The active-device label opens a provenance readout with the table's identity.
  await page.locator('header .device summary').click();
  await expect(page.locator('header .device .prov')).toBeVisible();
  await expect(page.locator('header .device .prov')).toContainText('device');
  await expect(page.locator('header .device .prov')).toContainText('nmos_demo');
});

test('operating range: chips report each range end; an end the solve cannot reach is no answer, with the reason', async ({
  page,
}) => {
  // The sweep below evaluates the sheet and both range ends at every sample, and the 5T now
  // solves how its tail current splits between the pair's two transistors inside each of those
  // evaluations, so the sweep takes several times as long as the rest of this suite's steps.
  test.slow();
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, '5T OTA');

  // The 5T claims a CM range; the engine checks both ends on every evaluation and the
  // panel reports one chip per range end. (Whether they read ✓ or ✗ on the demo device is the
  // demo's business — budgets are tuned for real tables — the report SHAPE is the contract.)
  const chips = sp.locator('.sedge');
  await expect(chips).toHaveCount(2);
  // Each end is named by the quantity and value its `set` fixes and which end of the range it is,
  // never by its bare name alone.
  await expect(chips.nth(0)).toHaveAttribute('data-range-end', 'cm-lo');
  await expect(chips.nth(0)).toContainText(
    /CM_dc = [\d.]+ m?V, the low end of the claimed CM_dc range/,
  );
  await expect(chips.nth(1)).toContainText(
    /CM_dc = [\d.]+ m?V, the high end of the claimed CM_dc range/,
  );

  // The strip and the sweep legend both name the QUESTION a range end answers. A chip says
  // whether the held design complies at that end; the curve says by how much. Locked here
  // because the words are the whole point of keeping the two questions apart, and prose drifts
  // silently.
  await expect(sp.locator('.sedges .glabel')).toHaveText('operating range');
  // The second question has its own badge, a count of points: the centre and the two ends.
  // On the demo device the design misses its offset target where it is sized and again at the
  // low end; the high end sits past the table's drain range, so it is no answer.
  await expect(sp.locator('[data-compliance]')).toHaveText(
    'complies at 0 of 3 points · 2 fail · 1 no answer',
  );
  await expect(sp.locator('.feasb')).toContainText('infeasible');
  await expect(sp.locator('.feasb i')).toContainText('offset-spec');
  await expect(chips.nth(0)).toHaveClass(/\bno\b/);
  await expect(chips.nth(1)).toHaveClass(/skip/);
  await sp.locator('.swsel select').selectOption('CM_dc');
  // The sweep runs in the background and the chart lands when it is done.
  await expect(sp.locator('.pchart canvas')).toBeVisible({ timeout: 60_000 });
  await expect(sp.locator('.skey')).toContainText('complies at CM_dc = ', { timeout: 60_000 });
  await expect(sp.locator('.skey')).toContainText('the low end of the claimed CM_dc range');
  await expect(sp.locator('[data-sweep-caption]')).toContainText(
    'each sample holds its OWN design',
  );
  // With a range there is more than one point to read, so every check row says where it is
  // tightest — at this one condition, its own operating point or a named range end.
  await expect(sp.locator('[data-worst-at="offset-spec"]')).toContainText(/^worst .+ at tt, /);

  // Make the low end unreachable: no tail-node position produces CM_in = 0.3 (the demo
  // table's diode drop alone exceeds it). Nothing was measured there, so the chip is neither
  // red nor green — it is an open question, and it carries the solver's reason.
  const lo = sp.locator('.svar[data-param="CM_lo"] .num');
  await lo.fill('0.3');
  await lo.blur();
  await expect(chips.nth(0)).toHaveClass(/skip/);
  await expect(chips.nth(0)).not.toHaveClass(/\bno\b/);
  await expect(chips.nth(0)).toContainText('?');
  await expect(chips.nth(0)).toContainText(/no answer — .*does not change sign/);
  await expect(sp.locator('[data-compliance]')).toHaveText(
    'complies at 0 of 3 points · 1 fail · 2 no answer',
  );
});

test('design sheet: evaluation runs off the page — it stays responsive, says so, and cancels a superseded sweep', async ({
  page,
}) => {
  // The 5T claims an operating range, so each sweep sample is three evaluations of the whole
  // sheet: seconds of work, which used to freeze the page until it was done.
  test.slow();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  let workers = 0;
  page.on('worker', () => (workers += 1));

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, '5T OTA');
  await expect(sp.locator('.feasb')).toContainText('infeasible');
  await expect(sp.locator('[data-busy]')).toHaveCount(0);

  await sp.locator('.swsel select').selectOption('CM_dc');
  await expect(sp.locator('[data-busy]')).toHaveText('sweeping…');
  await expect(sp.locator('[data-sweeping]')).toHaveText('sweeping CM_dc…');
  // The page answers while the sweep runs: nothing is evaluating on its thread.
  const t0 = Date.now();
  await page.evaluate(() => 0);
  expect(Date.now() - t0).toBeLessThan(1000);

  // Asking for another sweep before the first is done cancels it: the worker running it is
  // stopped, and a fresh one takes the sweep now asked for.
  const before = workers;
  await sp.locator('.swsel select').selectOption('gm_id_in');
  await expect(sp.locator('[data-sweeping]')).toHaveText('sweeping gm_id_in…');
  await expect.poll(() => workers).toBeGreaterThan(before);
  await expect(sp.locator('.pchart canvas')).toBeVisible({ timeout: 60_000 });
  await expect(sp.locator('.scap', { hasText: 'margin (%) vs' })).toContainText('gm_id_in');
  await expect(sp.locator('[data-busy]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('design sheet: picking another sheet of the same title does not show the first one’s verdict while it is evaluated', async ({
  page,
}) => {
  // A verdict belongs to the sheet it answers, and two sheets can share a title. Picking the
  // second must clear the first one's verdict until its own arrives — while an edit to the same
  // sheet keeps the last verdict on screen.
  test.slow();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  const asFile = (name: string, doc: object) => ({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const input = page.locator('.load input[type=file]');
  // A sheet with nothing to size, which answers at once, and the folded cascode OTA, which takes
  // seconds — both titled "Twin", imported in that order.
  await input.setInputFiles(
    asFile('twin-light.json', {
      title: 'Twin',
      polarity: 'n',
      formatVersion: 2,
      nodes: 'none',
      params: [{ name: 'x', value: 2 }],
      equations: [{ name: 'y', expr: '2*x' }],
      checks: [{ id: 'y-max', kind: 'spec', lhs: 'y', op: '<=', rhs: '10' }],
    }),
  );
  await expect(page.locator('.usheets .dev', { hasText: 'twin-light' })).toBeVisible();
  const folded = JSON.parse(readFileSync('../sheets/otas/folded-cascode-ota.json', 'utf8'));
  await input.setInputFiles(asFile('twin-heavy.json', { ...folded, title: 'Twin' }));
  await expect(page.locator('.usheets .dev', { hasText: 'twin-heavy' })).toBeVisible();

  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  const sel = sp.locator('.shead select.rm');
  const twins = await sel
    .locator('option', { hasText: 'Twin' })
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(twins).toHaveLength(2);

  await sel.selectOption(twins[0]);
  await expect(sp.locator('.feasb')).toHaveText('feasible');
  await sel.selectOption(twins[1]);
  // The light sheet's verdict is gone at once, though the title is the same.
  await expect(sp.locator('.feasb')).toHaveText('evaluating…');
  await expect(sp.locator('[data-busy]')).toHaveCount(0, { timeout: 60_000 });
  await expect(sp.locator('.feasb')).not.toHaveText('evaluating…');

  expect(errors).toEqual([]);
});

test('design sheet: where no worker can be started, the sheet is evaluated on the page instead', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    // A browser that offers no workers to this page.
    (window as unknown as { Worker: unknown }).Worker = undefined;
  });

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('.feasb')).toHaveText(/^(in)?feasible/);
  await expect(sp.locator('.bind')).toContainText('W=');
  await expect(sp.locator('[data-busy]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('operating range: a range end that was not run reads as a question nobody asked, not a failure', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, '5T OTA');
  const chips = sp.locator('.sedge');
  await expect(chips).toHaveCount(2);

  // Push the CENTRE past what the tail node can produce (still inside the sliders, so this is
  // a point the sweep and the picker both visit). The pair's source is the tail node, so the
  // node carries the pair's body effect and the common mode it produces rises 1.2 V per volt of
  // node. The tail is searched over the whole range its wiring allows, up to the output wire
  // at 0.9 V, once the author's range finds no root; with the input pair at the top of ITS
  // slider (gm/ID 18, the least gate drive) the most that range produces is 0.9 V plus that
  // pair's gate-source voltage there, under 1.6 V on this table, against a CM_dc of 1.6 V.
  // The tail is one member of a solved set, and a set member that finds no root is "no
  // answer", never a verdict. There is now no design at all here, so neither range end has a
  // design to hold — and the whole reason the engine reports that as its own outcome is that
  // showing it as a failure would answer a question it never asked. A red "cm-lo" beside an
  // empty design is a statement about the claimed range that nothing measured.
  // At the default centre the low end IS run and reads red, so the strip starting from a state
  // this test would fail on is what makes the transition below mean something. It is still run
  // once the pair has moved, which is the state the centre is pushed out of.
  await expect(chips.nth(0)).toHaveClass(/no/);
  const gmId = sp.locator('.svar[data-param="gm_id_in"] .num');
  await gmId.fill('18');
  await gmId.blur();
  await expect(chips.nth(0)).not.toHaveClass(/skip/);

  const cm = sp.locator('.svar[data-param="CM_dc"] .num');
  await cm.fill('1.6');
  await cm.blur();

  for (const i of [0, 1]) {
    await expect(chips.nth(i)).toHaveClass(/skip/);
    await expect(chips.nth(i)).not.toHaveClass(/\bno\b/);
    await expect(chips.nth(i)).toContainText('not run');
    await expect(chips.nth(i)).not.toContainText('infeasible');
    await expect(chips.nth(i)).not.toContainText('✗');
  }
  // The centre's own solve did not land: feasibility has no answer, and the badge names no
  // check — a margin read where the solve stopped is not a cause. The count keeps the centre
  // (asked, unanswered) apart from the two ends (never asked).
  await expect(sp.locator('.feasb')).toHaveText('no answer');
  await expect(sp.locator('[data-compliance]')).toHaveText(
    'complies at 0 of 3 points · 1 no answer · 2 not run',
  );
  await expect(sp.locator('[data-not-evaluated] b').first()).toHaveText('no answer at tt');

  // Recentre: the same two ends go back to being answerable, so the neutral state is a
  // property of the point and not a latch.
  await cm.fill('1.1');
  await cm.blur();
  await expect(chips.nth(0)).not.toHaveClass(/skip/);
});

test('design sheet: the sensitivity readout ranks the knobs that move the binding check', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // Nothing is computed until asked: every knob costs two full re-evaluations, so the readout
  // must never ride along with the badge.
  await expect(sp.locator('.ssens')).toHaveCount(0);

  await sp.locator('.sensb').click();
  const sens = sp.locator('.ssens');
  await expect(sens).toBeVisible();
  // The default example fails `headroom` at gm/ID = 12 (V* ≈ 167 mV under a 200 mV floor), so
  // that is the check the knobs are ranked against — the same one the badge names.
  await expect(sens.locator('.scap')).toContainText('headroom');

  // One line per design knob, ranked by how far it moves that margin over a common fractional
  // step. V* = 2/(gm/ID) depends on the efficiency knob and not at all on L, so gm_id leads.
  const lines = sens.locator('.skline');
  await expect(lines).toHaveCount(2);
  await expect(lines.first().locator('code')).toHaveText('gm_id');
  await expect(lines.first()).toContainText('↑');
  await expect(lines.first()).toContainText('↓');
  await page.screenshot({ path: `${SCREENS}/sheet-sensitivity.png`, fullPage: true });

  // It is a snapshot of one operating point: moving the design retires it rather than letting a
  // stale ranking describe a sheet that has changed underneath it.
  const gmId = sp.locator('.svar[data-param="gm_id"] .num');
  await gmId.fill('8');
  await gmId.blur();
  await expect(sp.locator('.ssens')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('design sheet: an imported netlist survives import and reload (still checked)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // A block's `nodes` is an OBJECT on a block whose siblings are strings, so a sanitizer that
  // rebuilds the block field by field deletes it — and the wiring check goes quiet on the next
  // reload without anything on screen saying so. Here the sheet holds the device's gate wire at
  // 0 V, which contradicts the block's own sized V_GS by hundreds of millivolts, so a live check
  // must say so out loud: the loop through the gate does not close.
  const wiredSheet = (nodes: unknown): string =>
    JSON.stringify({
      title: 'Wired gate',
      polarity: 'n',
      formatVersion: 2,
      params: [{ name: 'V_g', value: 0, class: 'independent' }],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 'n1',
          doc: {
            title: 'input device',
            polarity: 'n',
            params: [
              { name: 'L', value: 5e-7 },
              { name: 'Ib', value: 1e-5 },
            ],
            givens: { L: 'L', id: 'Ib', gm_id: '10', vds: '0.9' },
            equations: [],
            checks: [],
          },
          nodes,
        },
      ],
      levels: { g: 'V_g', out: '0.9' },
    });
  const load = page.locator('.load input[type=file]');
  await load.setInputFiles({
    name: 'wired-gate.json',
    mimeType: 'application/json',
    buffer: Buffer.from(wiredSheet({ d: 'out', g: 'g', s: 'gnd', b: 'gnd' })),
  });

  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  await pickSheet(page, 'Wired gate');
  const warn = page.locator('.sheet .pwarn', { hasText: 'wiring' });
  await expect(warn).toContainText('does not close');
  // The wiring check's verdict sits beside the feasibility badge: one finding, the loop.
  await expect(page.locator('.sheet [data-wiring]')).toHaveText('wiring: 1 finding');
  // The finding IS the two claims and the residual of the loop, so the line has to survive to its
  // last word — captured at panel scope, where a clipped one would show.
  await warn.scrollIntoViewIfNeeded();
  await page
    .locator('.grid .panel')
    .last()
    .screenshot({ path: `${SCREENS}/sheet-wiring.png` });

  // A placement of the wrong shape — a bare string where the four wires belong — is the same hole
  // from the other side: carried as written it would be refused by the core, and dropped it would
  // leave the sheet reading CLEANER than the core reads it. Fail closed at the door, naming the
  // field.
  await load.setInputFiles({
    name: 'empty-wiring.json',
    mimeType: 'application/json',
    buffer: Buffer.from(wiredSheet('out')),
  });
  await expect(page.locator('.qa.error')).toContainText(
    'malformed sheet content at blocks[0].nodes',
  );
  await expect(page.locator('.usheets .dev', { hasText: 'empty-wiring' })).toHaveCount(0);

  // And again after a reload, which restores the sheet through the same sanitizer.
  await page.reload();
  await expect(page.locator('.sheet .pwarn', { hasText: 'wiring' })).toContainText(
    'does not close',
  );

  expect(errors).toEqual([]);
});

test('design sheet: a format this app does not read is refused at import, and a stored copy opens with the refusal alone', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // A document a later build wrote: its JSON is fine, so the refusal says what is wrong with it —
  // the format — and nothing about malformed content or a stored copy that an import never made.
  const future = {
    title: 'From a later build',
    polarity: 'n',
    formatVersion: 3,
    params: [],
    equations: [],
    checks: [],
    wires3: { x: 1 },
  };
  const load = page.locator('.load input[type=file]');
  const file = (name: string, doc: object) => ({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const sentence =
    'format version 3 is not one this app reads (it reads documents with no format version, and ' +
    'format version 2)';
  await load.setInputFiles(file('future.json', future));
  const refusal = page.locator('.qa.error');
  await expect(refusal).toContainText(`${sentence} — nothing was imported`);
  await expect(refusal).not.toContainText('malformed');
  await expect(refusal).not.toContainText('stored copy');

  // A child in that format, embedded in a sheet this app reads, refuses the whole import alike.
  await load.setInputFiles(
    file('nested-future.json', {
      title: 'Parent of a later child',
      polarity: 'n',
      formatVersion: 2,
      nodes: 'none',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'a', doc: future }],
    }),
  );
  await expect(refusal).toContainText(`block "a": ${sentence} — nothing was imported`);
  await expect(refusal).not.toContainText('malformed');
  await expect(page.locator('.usheets .dev')).toHaveCount(0);

  // A copy a later build stored is kept as stored. Its menu entry names its format, not its title,
  // and the panel opened on it shows the refusal and reads nothing else from it.
  await page.evaluate(
    (doc) => localStorage.setItem('gmid.sheets.v2', JSON.stringify([{ name: 'future', doc }])),
    future,
  );
  await page.reload();
  await loadDemo(page);
  await expect(page.locator('.usheets .dev', { hasText: 'future' })).toBeVisible();
  await page.locator('button.btn', { hasText: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('.shead select.rm option', { hasText: sentence })).toHaveCount(1);
  await expect(
    sp.locator('.shead select.rm option', { hasText: 'From a later build' }),
  ).toHaveCount(0);
  await pickSheet(sp, sentence);
  const shown = sp.locator('[data-refused]');
  await expect(shown).toContainText(sentence);
  await expect(shown).toContainText('a stored copy is kept as it was stored');
  await expect(sp.locator('.feasb')).toHaveCount(0);
  await expect(sp.locator('.sheet strong')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('design sheet: a stored panel restored without a check gives no verdict until the user evaluates without it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  type StoredDash = {
    tabs: {
      panels: {
        render: string;
        sheet?: { checks: { id: string; kind: string; note?: unknown }[] };
      }[];
    }[];
  };
  /** The stored sheet panel's checks, as localStorage holds them. */
  const storedChecks = () =>
    page.evaluate(() => {
      const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{"tabs":[]}') as StoredDash;
      const p = dash.tabs.flatMap((t) => t.panels).find((x) => x.render === 'sheet');
      return (p?.sheet?.checks ?? []).map((c) => `${c.id}:${c.kind}`);
    });

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('.shead strong')).toHaveText('Single NMOS gm/ID sizing');
  // At its defaults the headroom check fails, so the design reads infeasible.
  await expect(sp.locator('.srules tr', { hasText: 'headroom' })).toHaveClass(/st-fail/);
  await expect(sp.locator('.feasb')).toHaveText(/infeasible/);
  await expect(sp.locator('[data-refused]')).toHaveCount(0);

  // The stored copy as a later build might write it: the headroom check under a kind this build
  // does not read. Restored without that check the design would read feasible, so the panel gives
  // no verdict at all — no badge, no rows — names the check, and saves nothing over the stored copy.
  await page.evaluate(() => {
    const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{}') as StoredDash;
    for (const tab of dash.tabs)
      for (const p of tab.panels)
        if (p.render === 'sheet' && p.sheet)
          for (const c of p.sheet.checks) if (c.id === 'headroom') c.kind = 'contract';
    localStorage.setItem('gmid.dash.v3', JSON.stringify(dash));
  });
  await page.reload();
  await loadDemo(page);
  const sp2 = page.locator('.grid .panel').last();
  const refused = sp2.locator('[data-refused]');
  await expect(refused).toContainText('could not be read whole');
  await expect(refused).toContainText('checks[1]');
  await expect(sp2.locator('.feasb')).toHaveCount(0);
  await expect(sp2.locator('.srules')).toHaveCount(0);
  await expect(sp2.locator('.shead strong')).toHaveCount(0);
  await expect.poll(storedChecks).toContain('headroom:contract');

  // A reload restores from the same stored copy, so it is refused again rather than having
  // become the document.
  await page.reload();
  await loadDemo(page);
  const sp3 = page.locator('.grid .panel').last();
  await expect(sp3.locator('[data-refused]')).toContainText('checks[1]');
  await expect(sp3.locator('.feasb')).toHaveCount(0);
  await expect.poll(storedChecks).toContain('headroom:contract');

  // Evaluating without the check is the user's choice, and it makes the restored sheet their
  // document: it is evaluated — without headroom, so it now reads feasible — and that is what is
  // saved from then on.
  await sp3.locator('[data-restore-accept]').click();
  await expect(sp3.locator('[data-refused]')).toHaveCount(0);
  await expect(sp3.locator('.shead strong')).toHaveText('Single NMOS gm/ID sizing');
  await expect(sp3.locator('.feasb')).toBeVisible();
  await expect(sp3.locator('.srules tr', { hasText: 'headroom' })).toHaveCount(0);
  await expect.poll(storedChecks).not.toContain('headroom:contract');

  expect(errors).toEqual([]);
});

test('design sheet: a stored panel restored without prose only is evaluated, says so, and keeps the stored copy', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  type StoredDash = {
    tabs: { panels: { render: string; sheet?: { checks: { note?: unknown }[] } }[] }[];
  };
  const storedNote = () =>
    page.evaluate(() => {
      const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{"tabs":[]}') as StoredDash;
      const p = dash.tabs.flatMap((t) => t.panels).find((x) => x.render === 'sheet');
      return p?.sheet?.checks[0]?.note;
    });

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  await expect(page.locator('.grid .panel').last().locator('.shead strong')).toHaveText(
    'Single NMOS gm/ID sizing',
  );
  // A note this build cannot read (a number where it reads text): prose, which no verdict reads.
  await page.evaluate(() => {
    const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{}') as StoredDash;
    for (const tab of dash.tabs)
      for (const p of tab.panels) if (p.render === 'sheet' && p.sheet) p.sheet.checks[0].note = 42;
    localStorage.setItem('gmid.dash.v3', JSON.stringify(dash));
  });
  await page.reload();
  await loadDemo(page);
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('[data-refused]')).toHaveCount(0);
  await expect(sp.locator('[data-restore-lost]')).toContainText('checks[0].note');
  await expect(sp.locator('.feasb')).toBeVisible();
  // The restored numbers are not offered for copying while the stored copy is kept.
  await expect(sp.locator('.sexp button', { hasText: 'copy results' })).toBeDisabled();
  await expect.poll(storedNote).toBe(42);

  expect(errors).toEqual([]);
});

test('dashboard: a saved layout the loader cannot read whole is kept, not saved over, until the user keeps it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  type StoredDash = { tabs: { panels: { xExpr: unknown }[] }[] };
  /** The stored first tab's panel count and its sixth panel's X axis. */
  const stored = () =>
    page.evaluate(() => {
      const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{"tabs":[]}') as StoredDash;
      const panels = dash.tabs[0]?.panels ?? [];
      return { count: panels.length, x5: panels[5]?.xExpr };
    });

  await page.goto('/');
  await loadDemo(page);
  // A panel of the user's own (the canonical ones are regenerated for every device anyway).
  await page.getByRole('button', { name: '+ sheet' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  await expect.poll(async () => (await stored()).count).toBe(6);
  // Its axis written in a shape this build does not read.
  await page.evaluate(() => {
    const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{}') as StoredDash;
    dash.tabs[0].panels[5].xExpr = { expr: '' };
    localStorage.setItem('gmid.dash.v3', JSON.stringify(dash));
  });
  await page.reload();
  await loadDemo(page);
  const line = page.locator('[data-layout-lost]');
  await expect(line).toContainText('tabs[0].panels[5]');
  await expect(page.locator('.grid .panel')).toHaveCount(5);
  // A change on the dashboard is not saved while the stored layout is held.
  await page.getByRole('button', { name: '+ sheet' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  await expect.poll(stored).toEqual({ count: 6, x5: { expr: '' } });

  // Keeping the layout saves it as it is now.
  await line.locator('[data-layout-keep]').click();
  await expect(line).toHaveCount(0);
  await expect.poll(stored).toEqual({ count: 6, x5: '' });

  expect(errors).toEqual([]);
});

test('design sheet: a stored panel whose sheet cannot be read at all opens refused, keeps it, and is not replaced', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  type StoredDash = { tabs: { panels: { render: string; sheet?: unknown }[] }[] };
  const storedSheet = () =>
    page.evaluate(() => {
      const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{"tabs":[]}') as StoredDash;
      return dash.tabs.flatMap((t) => t.panels).find((x) => x.render === 'sheet')?.sheet;
    });

  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  await expect(page.locator('.grid .panel').last().locator('.shead strong')).toHaveText(
    'Single NMOS gm/ID sizing',
  );
  await page.evaluate(() => {
    const dash = JSON.parse(localStorage.getItem('gmid.dash.v3') ?? '{}') as StoredDash;
    for (const tab of dash.tabs)
      for (const p of tab.panels) if (p.render === 'sheet') p.sheet = 'not a sheet';
    localStorage.setItem('gmid.dash.v3', JSON.stringify(dash));
  });
  await page.reload();
  await loadDemo(page);
  const sp = page.locator('.grid .panel').last();
  // Refused with the reason, evaluating nothing — never another sheet in its place.
  await expect(sp.locator('[data-refused]')).toContainText('could not be restored');
  await expect(sp.locator('.feasb')).toHaveCount(0);
  await expect(sp.locator('.shead strong')).toHaveCount(0);
  await expect.poll(storedSheet).toBe('not a sheet');

  // Picking a sheet replaces it, and that is what is stored.
  await pickSheet(sp, 'NMOS noise & matching');
  await expect(sp.locator('.shead strong')).toHaveText('NMOS noise & matching');
  await expect
    .poll(async () => ((await storedSheet()) as { title?: string } | undefined)?.title)
    .toBe('NMOS noise & matching');

  expect(errors).toEqual([]);
});

test('copy results: the pasted numbers carry the verdict and what they rest on', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  // Its device leaves the body bias to the default, which the result records as assumed.
  await pickSheet(sp, 'Gm-C filter pole');
  await expect(sp.locator('.shead .bind')).toContainText('W=');
  await sp.locator('.sexp button', { hasText: 'copy results' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split('\n');
  expect(lines[0]).toBe('# Gm-C filter pole');
  expect(lines[1]).toMatch(/^# (in)?feasible/);
  expect(lines).toContain("# rests on: vsb left at its default: this sheet's own device");
  // The values follow the comment lines, one name and value per line.
  const values = lines.filter((l) => !l.startsWith('#'));
  expect(values.length).toBeGreaterThan(5);
  expect(values.every((l) => l.split('\t').length === 2)).toBe(true);
});

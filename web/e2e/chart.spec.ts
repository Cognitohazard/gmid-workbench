import { test, expect } from '@playwright/test';

const SCREENS = 'e2e/__screens__';

test('explore: renders the gm/ID family chart and reacts to the expression', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');

  // uPlot mounts a <div class="uplot"> with a <canvas> inside our .chart container.
  const canvas = page.locator('.chart canvas').first();
  await expect(canvas).toBeVisible();
  const cbox = await canvas.boundingBox();
  expect(cbox!.width).toBeGreaterThan(200);
  expect(cbox!.height).toBeGreaterThan(150);

  // We own the color key in the footer (uPlot's own legend is off): demo nMOS
  // has 4 lengths, shown immediately on load before any hover.
  await expect(page.locator('footer')).toContainText('l=180nm');
  await expect(page.locator('footer')).toContainText('l=2um');

  // Hover the plot → footer readout reacts (vgs value appears).
  const box = await page.locator('.chart').boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await expect(page.locator('footer')).toContainText('vgs');
  await page.screenshot({ path: `${SCREENS}/explore-gm_id.png` });

  // Switch the Y expression to fT (a derived NAME, resolved by the engine) →
  // chart refits to a new scale, no error, still renders.
  await page.locator('.expr input').fill('ft');
  await page.locator('.expr input').blur();
  await expect(page.locator('.err')).toHaveCount(0); // resolved as a derived name, no error
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.4);
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/explore-ft.png` });

  // Move the vds slider to its max — fT is vds-sensitive (CLM), so the chart
  // re-slices and refits; the value readout tracks the slider; no error.
  const vds = page.locator('.slider input').first();
  await vds.fill('1.2');
  await expect(page.locator('.slider .val')).toContainText('1.2');
  await expect(page.locator('.err')).toHaveCount(0);
  await expect(canvas).toBeVisible();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.4);
  await page.screenshot({ path: `${SCREENS}/explore-ft-vds.png` });

  // Every advertised picker option is computable on the active table — selecting
  // any of them must NOT raise the error banner (the picker reflects the grid).
  const optionValues = await page
    .locator('#exprs option')
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(optionValues.length).toBeGreaterThan(3);
  for (const v of optionValues) {
    await page.locator('.expr input').fill(v);
    await expect(page.locator('.err'), `option "${v}" raised an error`).toHaveCount(0);
  }

  // Input-referred thermal noise is a first-class plottable — the gm/ID methodology
  // IS the noise-efficiency axis. The demo carries no `sth` PSD, so the γ-MODEL key
  // (vnth_m) charts; the measured `vnth` would error here (no sth), which is the
  // honest behaviour — a model is never silently dressed up as measured data.
  await page.locator('.expr input').fill('vnth_m');
  await page.locator('.expr input').blur();
  await expect(page.locator('.err')).toHaveCount(0);
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/explore-noise.png` });

  // A bad expression surfaces an error and keeps the last good chart.
  await page.locator('.expr input').fill('gm/(');
  await page.locator('.expr input').blur();
  await expect(page.locator('.err')).toBeVisible();
  await expect(canvas).toBeVisible();

  expect(errors).toEqual([]);
});

test('importer: loads a mostab CSV, swaps the device, surfaces QA', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.locator('header .device')).toContainText('nmos_demo'); // demo first

  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');

  // Device swapped to the imported table; QA panel surfaces the 200mV vgs step.
  await expect(page.locator('header .device')).toContainText('nch_lvt');
  await expect(page.locator('.qa')).toContainText('vgs-step');
  // Deepened data-trust: the fixture's gm is not d(id)/d(vgs), and the QA panel says so.
  await expect(page.locator('.qa')).toContainText('gm-consistency');
  // Chart re-rendered for the new device (2 L lines from the fixture).
  await expect(page.locator('.chart canvas').first()).toBeVisible();
  await expect(page.locator('footer')).toContainText('l=');
  await page.screenshot({ path: `${SCREENS}/import-mostab.png` });

  // The matching panel seeds A_Vth / A_β from the table's Pelgrom metadata, not
  // generic defaults: # AVT 3.5e-9 V·m → 3.5 mV·µm, # ABETA 2e-8 ·m → 2 %·µm.
  await page.locator('header button.size').click();
  const sizer = page.locator('aside.sizer');
  await expect(sizer.getByPlaceholder('mV·µm')).toHaveValue('3.5');
  await expect(sizer.getByPlaceholder('%·µm')).toHaveValue('2');
  await expect(sizer).toContainText('from device');
  // The 1/f corner seeds from # FCO: 2e6 too, shown in engineering notation.
  await expect(sizer.getByPlaceholder('Hz · e.g. 1meg')).toHaveValue('2meg');
  await expect(sizer).toContainText('corner from device');
  await page.locator('header button.size').click(); // close

  // Back to the demo clears QA and restores the EKV device.
  await page.locator('button.demo').click();
  await expect(page.locator('header .device')).toContainText('nmos_demo');
  await expect(page.locator('.qa')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('importer: a single-axis table (no L) charts as one curve, no error', async ({ page }) => {
  await page.goto('/');
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/single-l.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nch_singleL');
  // family auto-resolves to (none); the chart renders a single curve, no error.
  await expect(page.locator('header .err')).toHaveCount(0);
  await expect(page.locator('.chart canvas').first()).toBeVisible();
  await expect(page.locator('header .axis select').nth(1)).toHaveValue(''); // family = (none)
});

test('size: bind any two of {gm, gm/ID, ID} → width, vgs, feasibility', async ({ page }) => {
  await page.goto('/');
  await page.locator('header button.size').click();
  const sizer = page.locator('aside.sizer');
  await expect(sizer).toBeVisible();
  await expect(sizer).toContainText('enter exactly two'); // nothing entered yet

  // gm/ID = 15 (below the demo's ~30 ceiling) at ID = 100 µA.
  await sizer.getByPlaceholder('S/A').fill('15');
  await sizer.getByPlaceholder('A · e.g. 100u').fill('100u');

  await expect(sizer.locator('.sz')).toContainText('W'); // solved a width
  await expect(sizer.locator('.feas.ok')).toBeVisible(); // 15 < ceiling → feasible

  // The sizing bias is surfaced and tracks the explore vds slider (not a hidden
  // midpoint): move vds to 1.2 V and the panel reflects it.
  await expect(sizer.locator('.bias')).toContainText('vds=');
  await page.locator('header .slider input').first().fill('1.2');
  await expect(sizer.locator('.bias')).toContainText('vds=1.2');
  // Matching & noise budget: the sized geometry yields a Pelgrom offset, and the
  // thermal-noise density (γ-model) sits in its own line.
  await expect(sizer).toContainText('matching');
  await expect(sizer.locator('.budget')).toContainText('σ(Vos) pair');
  await expect(sizer.locator('.noise')).toContainText('V/√Hz'); // thermal noise (γ-model)
  // Total integrated input-referred noise (thermal + 1/f over the band); raising the
  // 1/f corner increases it.
  const rms = sizer.locator('.noise dd').last();
  const rms0 = await rms.textContent();
  await sizer.getByPlaceholder('Hz · e.g. 1meg').fill('100meg');
  await expect(rms).not.toHaveText(rms0 ?? '');
  // Offset tracks the matching coefficient — doubling A_Vth changes σ(Vth)
  // (area-domain physics, separate from gm/ID).
  const sigVth = sizer.locator('.budget dd').first();
  const before = await sigVth.textContent();
  await sizer.getByPlaceholder('mV·µm').fill('8'); // 2× A_Vth
  await expect(sigVth).not.toHaveText(before ?? '');
  // Noise is independent of the matching coeffs: a garbage A_Vth hides the matching
  // budget but the noise line stays visible.
  await sizer.getByPlaceholder('mV·µm').fill('oops');
  await expect(sizer.locator('.budget')).toHaveCount(0);
  await expect(sizer.locator('.noise')).toContainText('V/√Hz');
  await sizer.getByPlaceholder('mV·µm').fill('4'); // restore
  await page.screenshot({ path: `${SCREENS}/size-panel.png` });

  // An out-of-range gm/ID (above the achievable ceiling) reports a clear error.
  await sizer.getByPlaceholder('S/A').fill('60');
  await expect(sizer.locator('.err')).toContainText('range');
});

test('explore: the X / family axis selector re-pivots the chart', async ({ page }) => {
  await page.goto('/');
  // Demo fans out over L by default.
  await expect(page.locator('footer')).toContainText('l=180nm');
  // Switch the family axis to vds → curves now fan out over vds, labelled in volts.
  await page.locator('header .axis select').nth(1).selectOption('vds');
  await expect(page.locator('footer')).toContainText('vds=');
  await expect(page.locator('footer')).not.toContainText('l=180nm');
  // l is now the remaining fixed axis (its slider appears); the chart still renders.
  await expect(page.locator('.chart canvas').first()).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/explore-family-vds.png` });
});

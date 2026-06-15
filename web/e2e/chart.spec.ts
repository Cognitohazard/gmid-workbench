import { test, expect } from '@playwright/test';

const SCREENS = 'e2e/__screens__';

// Drive a range <input> reliably (Playwright's fill() is flaky on type=range).
async function setSlider(input: import('@playwright/test').Locator, value: string) {
  await input.evaluate((el, v) => {
    (el as HTMLInputElement).value = v as string;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test('panels: canonical grid renders, every picker option computes, hover gives the operating point', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');

  // Five canonical gm/ID design charts are drawn immediately, no expression typing.
  await expect(page.locator('.grid canvas')).toHaveCount(5);
  const p0 = page.locator('.grid .panel').first();
  const cbox = await p0.locator('canvas').boundingBox();
  expect(cbox!.width).toBeGreaterThan(150);
  expect(cbox!.height).toBeGreaterThan(120);

  // Each panel owns its L color key (uPlot's own legend is off): demo nMOS has 4 lengths.
  await expect(p0.locator('.pfoot')).toContainText('l=180nm');
  await expect(p0.locator('.pfoot')).toContainText('l=2um');

  // Every advertised picker option is computable on this device — setting it as a panel's
  // Y must NOT raise the per-panel error (the picker reflects what the grid can resolve).
  const opts = await page
    .locator('#exprs option')
    .evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  expect(opts.length).toBeGreaterThan(3);
  const yInput = p0.locator('.ex').first();
  for (const v of opts) {
    await yInput.fill(v);
    await yInput.blur();
    await expect(p0.locator('.perr'), `option "${v}" raised an error`).toHaveCount(0);
  }

  // Hover a panel with spread curves (gm/gds) → the FULL operating point: the sweep
  // coordinate (vgs) is recovered from the gm/ID cursor (invertX), then looked up.
  const gmgds = page.locator('.grid .panel').nth(2);
  const b = await gmgds.locator('canvas').boundingBox();
  await page.mouse.move(b!.x + b!.width * 0.7, b!.y + b!.height * 0.4);
  await expect(gmgds.locator('.pfoot')).toContainText('vgs');
  await expect(gmgds.locator('.pfoot')).toContainText('fT');
  await page.screenshot({ path: `${SCREENS}/panels.png`, fullPage: true });

  // A bad expression shows the panel error and keeps the last good chart.
  await yInput.fill('gm/(');
  await yInput.blur();
  await expect(p0.locator('.perr')).toBeVisible();
  await expect(p0.locator('canvas')).toBeVisible();

  expect(errors).toEqual([]);
});

test('importer: loads a mostab CSV, swaps the device, surfaces QA, seeds the sizer', async ({ page }) => {
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
  // Panels re-seed for the new device and render (fixture has 2 L lines).
  await expect(page.locator('.grid canvas').first()).toBeVisible();
  await expect(page.locator('.grid .panel').first().locator('.pfoot')).toContainText('l=');
  await page.screenshot({ path: `${SCREENS}/import-mostab.png` });

  // The matching panel seeds A_Vth / A_β from the table's Pelgrom metadata, not generic
  // defaults: # AVT 3.5e-9 V·m → 3.5 mV·µm, # ABETA 2e-8 ·m → 2 %·µm.
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

test('importer: a single-axis table (no L) renders one curve per panel, no error', async ({ page }) => {
  await page.goto('/');
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/single-l.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nch_singleL');
  // No L axis → the preset family is (none); panels chart a single curve, no per-panel error.
  await expect(page.locator('.grid canvas').first()).toBeVisible();
  await expect(page.locator('.grid .perr')).toHaveCount(0);
  await expect(page.locator('.grid .panel').first().locator('select.fam')).toHaveValue('');
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

  // The sizing bias is surfaced and tracks the dashboard's shared vds slider (not a hidden
  // midpoint): move vds to 1.2 V and the panel reflects it.
  await expect(sizer.locator('.bias')).toContainText('vds=');
  await setSlider(page.locator('header .slider input').first(), '1.2');
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

test('dense family: colorbar by default, switchable to a sampled subset, persisted', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');

  // Fan gm/gds over vds (19 values > 8) → a colormap + colorbar, NOT a 19-swatch legend
  // that would bury the chart.
  const pg = page.locator('.grid .panel').nth(2);
  await pg.locator('select.fam').selectOption('vds');
  await expect(pg.locator('.cbar')).toBeVisible();
  await expect(pg.locator('.cbar')).toContainText('1.2'); // colorbar max label
  await expect(pg.locator('.plegend')).toContainText('colorbar');
  expect(await pg.locator('.pfoot .sw').count()).toBeLessThanOrEqual(1); // no swatch dump

  // Switch to a sampled subset: N=5 → 5 discrete legend swatches, no colorbar; the sampled
  // labels span the family (endpoints kept — confirms the drawn subset's identity).
  await pg.locator('.plegend button', { hasText: 'colorbar' }).click();
  await expect(pg.locator('.plegend')).toContainText('sample');
  await pg.locator('.num').fill('5');
  await pg.locator('.num').blur();
  await expect(pg.locator('.cbar')).toHaveCount(0);
  await expect(pg.locator('.pfoot .sw')).toHaveCount(5);
  await expect(pg.locator('.pfoot')).toContainText('vds=300mV');
  await expect(pg.locator('.pfoot')).toContainText('vds=1.2V');

  // The legend config persists across a reload.
  await page.reload();
  const pg2 = page.locator('.grid .panel').nth(2);
  await expect(pg2.locator('.plegend')).toContainText('sample');
  await expect(pg2.locator('.pfoot .sw')).toHaveCount(5);

  expect(errors).toEqual([]);
});

test('near-constant X (gm/ID swept over L) draws with a non-fatal warning', async ({ page }) => {
  await page.goto('/');
  const p0 = page.locator('.grid .panel').first();
  await p0.locator('select.fam').selectOption('vds'); // family ≠ l so the sweep ≠ family
  await page.locator('header .axis select').selectOption('l'); // gm/ID barely varies along L
  await expect(p0.locator('.pwarn')).toContainText(/nearly constant/i);
  await expect(p0.locator('canvas')).toBeVisible(); // non-fatal — the chart still draws
});

test('a panel that does not fan L exposes an L bias slider (no silent first-L bias)', async ({ page }) => {
  await page.goto('/');
  // Overview: every panel fans L → only the vds slider is shown (L would be inert).
  await expect(page.locator('header .slider')).toHaveCount(1);
  await expect(page.locator('header .slider')).toContainText('vds');
  // Make the first panel single-curve (family = none): it now pins L, so the L slider must
  // appear — otherwise L would be silently fixed to its first node with no control.
  await page.locator('.grid .panel').first().locator('select.fam').selectOption('');
  await expect(page.locator('header .slider')).toHaveCount(2);
  await expect(page.locator('header .slider').first()).toContainText('l'); // l axis, first
  await expect(page.locator('header .slider').last()).toContainText('vds');
});

test('overlay: a second loaded device draws alongside the active one, dashed and labelled', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // Only the demo is loaded → no device strip.
  await expect(page.locator('.devices')).toHaveCount(0);

  // Import a real device; it ACCUMULATES (the demo stays) and the strip appears with both.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await expect(page.locator('header .device')).toContainText('nch_lvt'); // the import is active

  // QA follows the ACTIVE device (derived, not a stale stored array): nch_lvt has warnings;
  // making the clean demo active must clear them — not keep showing the last import's QA.
  await expect(page.locator('.qa')).toContainText('gm-consistency');
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo active
  await expect(page.locator('.qa')).toHaveCount(0);
  await page.locator('.devices .dev').nth(1).locator('.dname').click(); // back to nch_lvt
  await expect(page.locator('.qa')).toContainText('gm-consistency');

  const p0 = page.locator('.grid .panel').first();
  const before = await p0.locator('.pfoot .sw').count(); // active device's curves only
  expect(before).toBeGreaterThan(0);
  await expect(p0.locator('.pfoot')).not.toContainText('nmos_demo'); // demo not overlaid yet

  // Overlay the demo (device 0, not the active one): its curves join every panel, device-prefixed.
  await page.locator('.devices .dev').first().locator('input[type=checkbox]').check();
  await expect(p0.locator('.pfoot')).toContainText('nmos_demo'); // overlay curves present
  expect(await p0.locator('.pfoot .sw').count()).toBeGreaterThan(before); // more curves than before
  await expect(p0.locator('.perr')).toHaveCount(0); // both devices resolve the panel's expressions
  await expect(p0.locator('canvas')).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/overlay.png`, fullPage: true });

  // Removing the overlaid device drops its curves and collapses the strip.
  await page.locator('.devices .dev').first().locator('.drm').click();
  await expect(page.locator('.devices')).toHaveCount(0);
  await expect(p0.locator('.pfoot')).not.toContainText('nmos_demo');

  expect(errors).toEqual([]);
});

test('dashboard: editing, tables, tabs, degeneracy, persistence', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');

  // Canonical preset: five gm/ID charts, every one with X = gm_id and family = L.
  await expect(page.locator('.grid .panel')).toHaveCount(5);
  await expect(page.locator('.grid canvas')).toHaveCount(5);
  const p0 = page.locator('.grid .panel').first();
  await expect(p0.locator('.ex').nth(1)).toHaveValue('gm_id'); // the X picker reads gm_id
  await expect(p0.locator('.ex').first()).toHaveValue('id_w'); // first canonical Y

  // One shared bias slider (vds): vgs is the sweep, l is every panel's family. Driving it
  // re-slices every panel with no error (fT / ID-W are vds-sensitive, gm/ID is not).
  await expect(page.locator('header .slider')).toHaveCount(1);
  await expect(page.locator('header .slider')).toContainText('vds');
  await setSlider(page.locator('header .slider input'), '1.0');
  await expect(page.locator('.grid canvas')).toHaveCount(5);
  await expect(page.locator('.grid .perr')).toHaveCount(0);

  // Table view of a panel: the resampled curves as a numeric grid (X column + one column
  // per L), no canvas. Toggling reuses the same derived data.
  await p0.getByRole('button', { name: 'table', exact: true }).click();
  await expect(p0.locator('table')).toBeVisible();
  await expect(p0.locator('canvas')).toHaveCount(0);
  await expect(p0.locator('thead th').first()).toHaveText('gm/ID'); // subscripted label
  await expect(p0.locator('thead th')).toHaveCount(5); // gm/ID + four L curves

  // Degeneracy guard: gm/ID is ~constant along a vds sweep, so switching the sweep to vds
  // flags every panel instead of drawing a collapsed smear.
  await page.locator('header .axis select').selectOption('vds');
  await expect(page.locator('.grid .perr').first()).toContainText(/constant|monoton/i);
  await page.locator('header .axis select').selectOption('vgs'); // restore

  // Tabs: add an empty tab (charts gone, hint shown), switch back (charts return; p0 is a
  // table now, so four canvases).
  await page.locator('.tab.add').click();
  await expect(page.locator('.empty')).toBeVisible();
  await expect(page.locator('.grid canvas')).toHaveCount(0);
  await page.locator('.tab').first().click();
  await expect(page.locator('.grid canvas')).toHaveCount(4);
  await page.screenshot({ path: `${SCREENS}/dashboard.png`, fullPage: true });

  // Persistence: the customized layout (p0 = table) survives a reload.
  await page.reload();
  await expect(page.locator('.grid .panel').first().locator('table')).toBeVisible();

  // A corrupt saved layout falls back to the canonical preset rather than crashing.
  await page.evaluate(() => localStorage.setItem('gmid.dash', '{not valid json'));
  await page.reload();
  await expect(page.locator('.grid .panel')).toHaveCount(5);
  await expect(page.locator('.grid canvas')).toHaveCount(5);

  expect(errors).toEqual([]);
});

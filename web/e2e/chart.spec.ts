import { test, expect } from '@playwright/test';
import { loadDemo, pickQuantity } from './helpers';

const SCREENS = 'e2e/__screens__';

// Drive a range <input> reliably (Playwright's fill() is flaky on type=range).
async function setSlider(input: import('@playwright/test').Locator, value: string) {
  // Fire input (live drag) AND change (release): controls that commit only on release — e.g.
  // the UI-scale slider, which applies its zoom on pointer-up to avoid a moving-target drag —
  // ignore input alone.
  await input.evaluate((el, v) => {
    (el as HTMLInputElement).value = v as string;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('panels: canonical grid renders, every picker option computes, hover gives the operating point', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // Five canonical gm/ID design charts are drawn after the demo device loads, no expression typing.
  await expect(page.locator('.grid canvas')).toHaveCount(5);
  const p0 = page.locator('.grid .panel').first();
  const cbox = await p0.locator('canvas').boundingBox();
  expect(cbox!.width).toBeGreaterThan(150);
  expect(cbox!.height).toBeGreaterThan(120);

  // Each panel owns its L color key (uPlot's own legend is off): demo nMOS has 4 lengths.
  await expect(p0.locator('.pfoot')).toContainText('l=180nm');
  await expect(p0.locator('.pfoot')).toContainText('l=2µm');

  // Help icons explain the selected quantities in place via a native title tooltip.
  await expect(p0.locator('.help').first()).toHaveAttribute('title', /.+/);

  // Every quantity the picker dropdown offers is computable on this device — selecting it as
  // a panel's Y must NOT raise the per-panel error (the picker reflects what the grid resolves).
  const ySel = p0.locator('.qpick').first();
  await ySel.locator('.qtrigger').click();
  const opts = await ySel
    .locator('.qopt[data-value]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-value')!).filter(Boolean));
  await page.keyboard.press('Escape');
  expect(opts.length).toBeGreaterThan(3);
  for (const v of opts) {
    await pickQuantity(ySel, v);
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

  // The custom-expression escape hatch still works: switch Y to custom, type a bad expression
  // → the panel error shows and the last good chart stays.
  await pickQuantity(ySel, '__custom__');
  const yCustom = p0.locator('.ex').first();
  await yCustom.fill('gm/(');
  await yCustom.blur();
  await expect(p0.locator('.perr')).toBeVisible();
  await expect(p0.locator('canvas')).toBeVisible();

  expect(errors).toEqual([]);
});

test('quantity picker: keyboard navigation', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);

  const picker = page.locator('.grid .panel').first().locator('.qpick').first();
  const trigger = picker.locator('.qtrigger');
  const menu = picker.locator('.qmenu');

  // Open the listbox: focus moves inside it (an option), not left on the trigger.
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(trigger).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('option');

  // Escape closes the menu AND returns focus to the trigger.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('importer: loads a mostab CSV, swaps the device, surfaces QA, seeds the sizer', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page); // app boots empty; load the demo device first

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

  // Switch back to the demo via the device strip (the import accumulated, so both are loaded).
  // QA follows the ACTIVE device: the import's gm-consistency warning is gone — the demo has its
  // own (different) QA, not the stale import's.
  await page.locator('.devices .dev').first().locator('.dname').click();
  await expect(page.locator('header .device')).toContainText('nmos_demo');
  await expect(page.locator('.qa')).not.toContainText('gm-consistency');

  expect(errors).toEqual([]);
});

test('importer: a single-axis table (no L) renders one curve per panel, no error', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/single-l.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nch_singleL');
  // No L axis → the preset family is (none); panels chart a single curve, no per-panel error.
  await expect(page.locator('.grid canvas').first()).toBeVisible();
  await expect(page.locator('.grid .perr')).toHaveCount(0);
  await expect(page.locator('.grid .panel').first().locator('select.fam')).toHaveValue('');
});

test('templates: add a canonical panel from the menu, no expression typing', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);
  await expect(page.locator('.grid .panel')).toHaveCount(5);

  // Pick "I_D vs V_GS" from the template menu → a 6th panel pre-set to X=vgs, Y=id, drawn.
  await page.locator('select.tpl').selectOption({ label: 'I_D vs V_GS' });
  await expect(page.locator('.grid .panel')).toHaveCount(6);
  const last = page.locator('.grid .panel').last();
  await expect(last.locator('.qpick').first()).toHaveAttribute('data-value', 'id'); // Y
  await expect(last.locator('.qpick').nth(1)).toHaveAttribute('data-value', 'vgs'); // X
  await expect(last.locator('canvas')).toBeVisible();
  await expect(last.locator('.perr')).toHaveCount(0);

  // The menu snaps back to its placeholder after adding (ready for the next pick).
  await expect(page.locator('select.tpl')).toHaveValue('');
});

test('templates: the menu only offers plots the active device can compute', async ({ page }) => {
  await page.goto('/');
  // Import a sparse table — VGS/ID/GM + W metadata only, no CGG and no GDS columns.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/single-l.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nch_singleL');

  const offered = () =>
    page
      .locator('select.tpl option')
      .evaluateAll((os) =>
        os
          .map((o) => (o as HTMLOptionElement).textContent?.trim() ?? '')
          .filter((t) => t && !t.startsWith('+ panel')),
      );
  const names = await offered();
  // Computable from VGS/ID/GM (+ W metadata) → stay offered.
  expect(names).toContain('I_D vs V_GS');
  expect(names).toContain('I_D/W vs gm/ID');
  // Need CGG / GDS columns this table lacks → must NOT be advertised (would open as a .perr panel).
  expect(names).not.toContain('f_T vs gm/ID');
  expect(names).not.toContain('gain (gm/g_ds) vs gm/ID');
  expect(names).not.toContain('f_T vs I_D');

  // An offered template still adds a real, non-erroring panel.
  const before = await page.locator('.grid .panel').count();
  await page.locator('select.tpl').selectOption({ label: 'I_D vs V_GS' });
  await expect(page.locator('.grid .panel')).toHaveCount(before + 1);
  await expect(page.locator('.grid .panel').last().locator('.perr')).toHaveCount(0);
});

test('size: bind any two of {gm, gm/ID, ID} → width, vgs, feasibility', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);
  await page.locator('header button.size').click();
  const sizer = page.locator('aside.sizer');
  await expect(sizer).toBeVisible();
  await expect(sizer).toContainText('enter exactly two'); // nothing entered yet

  // gm/ID = 15 (below the demo's ~30 ceiling) at ID = 100 µA.
  await sizer.getByPlaceholder('S/A').fill('15');
  await sizer.getByPlaceholder('A · e.g. 100u').fill('100u');

  await expect(sizer.locator('.sz')).toContainText('W'); // solved a width
  await expect(sizer.locator('.feas.ok')).toBeVisible(); // 15 < ceiling → feasible

  // The sizing bias is surfaced as an editable field that tracks the dashboard's shared
  // vds slider (not a hidden midpoint): move vds to 1.2 V and the field reflects it.
  await expect(sizer.locator('.bias')).toContainText('vds');
  await setSlider(page.locator('header .slider input').first(), '1.2');
  await expect(sizer.locator('.bax input').first()).toHaveValue('1.2');
  // And a typed value commits BACK to the shared bias — the slider label follows.
  await sizer.locator('.bax input').first().fill('900m');
  await sizer.locator('.bax input').first().dispatchEvent('change');
  await expect(page.locator('header .slider .val').first()).toHaveText('900mV');
  // An out-of-range value is CLAMPED to the table's swept range at commit — the
  // readout must never claim an operating point the table cannot represent.
  await sizer.locator('.bax input').first().fill('5');
  await sizer.locator('.bax input').first().dispatchEvent('change');
  await expect(sizer.locator('.bax input').first()).toHaveValue('1.2');
  await expect(page.locator('header .slider .val').first()).toHaveText('1.2V');
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

test('dense family: colorbar by default, switchable to a sampled subset, persisted', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // Fan gm/gds over vds (19 values > 8) → a colormap + colorbar, NOT a 19-swatch legend
  // that would bury the chart.
  const pg = page.locator('.grid .panel').nth(2);
  await pg.locator('select.fam').selectOption('vds');
  await expect(pg.locator('.cbar')).toBeVisible();
  await expect(pg.locator('.cbar')).toContainText('1.2'); // colorbar max label
  await expect(pg.locator('.plegend')).toContainText('colorbar');
  // The legend control lives in the panel toolbar, not its own row above the chart.
  await expect(pg.locator('.ptools .plegend')).toBeVisible();
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

  // The legend config persists across a reload: the device restores from local storage
  // and the saved layout — sampled legend, N=5 — restores against it.
  await page.reload();
  await expect(page.locator('header .device')).toContainText('nmos_demo');
  const pg2 = page.locator('.grid .panel').nth(2);
  await expect(pg2.locator('.plegend')).toContainText('sample');
  await expect(pg2.locator('.pfoot .sw')).toHaveCount(5);

  expect(errors).toEqual([]);
});

test('near-constant X (gm/ID swept over L) draws with a non-fatal warning', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);
  const p0 = page.locator('.grid .panel').first();
  await p0.locator('select.fam').selectOption('vds'); // family ≠ l so the sweep ≠ family
  await page.locator('header .axis select').selectOption('l'); // gm/ID barely varies along L
  await expect(p0.locator('.pwarn')).toContainText(/nearly constant/i);
  await expect(p0.locator('canvas')).toBeVisible(); // non-fatal — the chart still draws
});

test('a panel that does not fan L exposes an L bias slider (no silent first-L bias)', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
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

test('column toggle: charts shrink back and do not overlap (2 → 1 → 2 columns)', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await expect(page.locator('.grid canvas')).toHaveCount(5);
  const fewer = page.locator('.cols button').first(); // −
  const more = page.locator('.cols button').last(); // +

  // Widen to a single column (charts grow to full width), then back to two.
  await fewer.click();
  await expect(page.locator('.tabs .cols')).toContainText('1 col');
  await more.click();
  await expect(page.locator('.tabs .cols')).toContainText('2 col');

  // The two top-row panels sit side by side: their canvases must not overlap — i.e. the chart
  // shrank back instead of keeping its 1-column width and spilling into its neighbor.
  await expect
    .poll(async () => {
      const c0 = await page.locator('.grid .panel').nth(0).locator('canvas').boundingBox();
      const c1 = await page.locator('.grid .panel').nth(1).locator('canvas').boundingBox();
      return c0 && c1 ? c0.x + c0.width <= c1.x + 4 : false;
    })
    .toBe(true);
});

test('overlay: a second loaded device draws alongside the active one, dashed and labelled', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  // The device strip shows from the first load, with a running count.
  await expect(page.locator('.devices .dev')).toHaveCount(1);
  await expect(page.locator('.devices .dlabel')).toHaveText('devices (1)');

  // Import a real device; it ACCUMULATES (the demo stays) and the strip appears with both.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await expect(page.locator('header .device')).toContainText('nch_lvt'); // the import is active

  // QA follows the ACTIVE device (derived, not a stale stored array): nch_lvt has warnings;
  // making the clean demo active must clear them — not keep showing the last import's QA.
  await expect(page.locator('.qa')).toContainText('gm-consistency');
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo active
  await expect(page.locator('.qa')).not.toContainText('gm-consistency'); // demo's QA differs
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

  // Removing the overlaid device drops its curves; the strip stays with the one left.
  await page.locator('.devices .dev').first().locator('.drm').click();
  await expect(page.locator('.devices .dev')).toHaveCount(1);
  await expect(p0.locator('.pfoot')).not.toContainText('nmos_demo');

  expect(errors).toEqual([]);
});

test('dashboard: editing, tables, tabs, degeneracy, persistence', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // Canonical preset: five gm/ID charts, every one with X = gm_id and family = L.
  await expect(page.locator('.grid .panel')).toHaveCount(5);
  await expect(page.locator('.grid canvas')).toHaveCount(5);
  const p0 = page.locator('.grid .panel').first();
  await expect(p0.locator('.qpick').first()).toHaveAttribute('data-value', 'id_w'); // first canonical Y
  await expect(p0.locator('.qpick').nth(1)).toHaveAttribute('data-value', 'gm_id'); // the X picker reads gm_id

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

  // Persistence: the customized LAYOUT survives a reload — the device restores from
  // local storage and the saved layout restores against it: p0 = table.
  await page.reload();
  await expect(page.locator('header .device')).toContainText('nmos_demo');
  await expect(page.locator('.grid .panel').first().locator('table')).toBeVisible();

  // A corrupt saved layout falls back to the canonical preset rather than crashing.
  await page.evaluate(() => localStorage.setItem('gmid.dash.v2', '{not valid json'));
  await page.reload();
  await loadDemo(page);
  await expect(page.locator('.grid .panel')).toHaveCount(5);
  await expect(page.locator('.grid canvas')).toHaveCount(5);

  expect(errors).toEqual([]);
});

test('settings: a forced theme overrides the OS scheme, keeping text and background in sync', async ({
  page,
}) => {
  // Simulate an OS in dark mode — the regression was forced-light showing white-on-white here
  // (the page background followed the forced scheme but the text colour did not).
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await loadDemo(page);
  await page.locator('.prefs summary').click();

  // Mean luminance of the document root's resolved text + background colours.
  const root = () =>
    page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      const lum = (c: string) =>
        (c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).reduce((a, b) => a + +b, 0) / 3;
      return { fg: lum(s.color), bg: lum(s.backgroundColor) };
    });

  // Count dark vs light *drawn* pixels in the chart canvas's bottom tick-label gutter (below the
  // plot, so the coloured curves don't reach it). This catches the lag bug where the canvas ticks
  // kept the previous scheme's colour and rendered invisibly (e.g. white-on-white in light theme).
  const ticks = () =>
    page.evaluate(() => {
      const c = document.querySelector('.grid .panel canvas') as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      const band = ctx.getImageData(
        0,
        Math.floor(c.height * 0.9),
        c.width,
        Math.max(1, Math.floor(c.height * 0.1)),
      );
      let dark = 0;
      let light = 0;
      for (let i = 0; i < band.data.length; i += 4) {
        if (band.data[i + 3] < 50) continue; // skip transparent (the canvas shows the themed bg)
        const lum = (band.data[i] + band.data[i + 1] + band.data[i + 2]) / 3;
        if (lum < 110) dark++;
        else if (lum > 160) light++;
      }
      return { dark, light };
    });

  // Forced light: a genuinely light background with darker text, despite the dark OS, AND the
  // canvas tick labels drawn dark (visible on the light plot — the reported bug was white-on-white).
  await page.locator('.prefs-pop select').selectOption('light');
  await expect.poll(async () => (await root()).bg).toBeGreaterThan(170);
  expect((await root()).bg).toBeGreaterThan((await root()).fg);
  await expect.poll(async () => (await ticks()).dark).toBeGreaterThan(0);
  await page.screenshot({ path: `${SCREENS}/settings-light-on-dark-os.png`, fullPage: true });

  // Forced dark: a genuinely dark background with lighter text, AND the tick labels drawn light.
  await page.locator('.prefs-pop select').selectOption('dark');
  await expect.poll(async () => (await root()).bg).toBeLessThan(90);
  expect((await root()).bg).toBeLessThan((await root()).fg);
  await expect.poll(async () => (await ticks()).light).toBeGreaterThan(0);
});

test('settings: theme toggle and font sliders apply, rebuild the chart, and persist', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await expect(page.locator('.grid canvas').first()).toBeVisible();

  // Open the appearance popover (native <details>).
  await page.locator('.prefs summary').click();
  await expect(page.locator('.prefs-pop')).toBeVisible();

  // Dark theme forces color-scheme on the document root; the canvas chart still renders.
  await page.locator('.prefs-pop select').selectOption('dark');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe('dark');
  await expect(page.locator('.grid canvas').first()).toBeVisible();

  // UI zoom (the root size) and text size (a content-only multiplier) are independent knobs:
  // bumping each updates its own custom property. UI zoom commits on release; both stay applied.
  await setSlider(page.locator('.prow', { hasText: 'UI zoom' }).locator('input'), '20');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),
      ),
    )
    .toBe('20px');
  await setSlider(page.locator('.prow', { hasText: 'Text size' }).locator('input'), '1.4');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim(),
      ),
    )
    .toBe('1.4');

  // Bumping the tick (axis-label) font goes through the chart-rebuild path without error.
  await setSlider(page.locator('.prow', { hasText: 'axis labels' }).locator('input'), '18');
  await expect(page.locator('.grid canvas').first()).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/settings-dark.png`, fullPage: true });

  // All of it persists across a reload.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe('dark');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),
      ),
    )
    .toBe('20px');

  expect(errors).toEqual([]);
});

test('settings: the appearance panel opens on-screen even when the toolbar wraps', async ({
  page,
}) => {
  // A narrow viewport forces the header to wrap onto several lines — the case where the ⚙
  // used to slide to the left and its right-anchored popover opened off the left edge.
  await page.setViewportSize({ width: 480, height: 820 });
  await page.goto('/');
  await loadDemo(page);

  await page.locator('.prefs summary').click();
  const pop = page.locator('.prefs-pop');
  await expect(pop).toBeVisible();

  const box = await pop.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); // not clipped off the left
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 1); // nor off the right
});

test('axis scale: titles toggle linear⇄log, defaults apply, derived equation renders', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);

  // Panel 0 is I_D/W vs gm/ID: id_w defaults to a log Y (decade-spanning FOM), gm/ID to linear X.
  const p0 = page.locator('.grid .panel').first();
  await expect(p0.locator('.ylabel .logtag')).toBeVisible();
  await expect(p0.locator('.xlabel .logtag')).toHaveCount(0);

  // The picker menu renders each derived quantity's definition (id_w → I_D/W) — the whole point
  // of the custom dropdown, since a native <select> can't show subscripts or fractions.
  const yPick = p0.locator('.qpick').first();
  await yPick.locator('.qtrigger').click();
  await expect(yPick.locator('.qopt[data-value="id_w"] .qeq')).toBeVisible();
  await page.keyboard.press('Escape');

  // Clicking the Y title flips it to linear and rebuilds the chart (canvas stays up, no error).
  await p0.locator('.ylabel .axlabel').click();
  await expect(p0.locator('.ylabel .logtag')).toHaveCount(0);
  await expect(p0.locator('canvas')).toBeVisible();

  // Clicking the X title flips it to log — this is the path that used to crash on tiny magnitudes.
  await p0.locator('.xlabel .axlabel').click();
  await expect(p0.locator('.xlabel .logtag')).toBeVisible();
  await expect(p0.locator('canvas')).toBeVisible();

  expect(errors).toEqual([]);
});

test('axis scale: a log request on non-positive data renders linear and drops the log tag', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  const p0 = page.locator('.grid .panel').first();

  // Force Y to an expression that is negative across the whole sweep (no log-safe samples).
  await pickQuantity(p0.locator('.qpick').first(), '__custom__');
  const yCustom = p0.locator('.ex').first();
  await yCustom.fill('0-id');
  await yCustom.blur();
  await expect(p0.locator('canvas')).toBeVisible();

  // Request a log Y: the chart can't log non-positive data, so it must render linear AND the axis
  // must not claim "log" — the effective scale, not the request, drives the tag.
  await p0.locator('.ylabel .axlabel').click();
  await expect(p0.locator('.ylabel .logtag')).toHaveCount(0);
  await expect(p0.locator('canvas')).toBeVisible();

  expect(errors).toEqual([]);
});

test('persistence: loaded devices survive a reload and can be forgotten', async ({ page }) => {
  await page.goto('/');
  await loadDemo(page);
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);

  // Reload: both tables come back from local storage, no re-import needed.
  await page.reload();
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await expect(page.locator('header .device')).toContainText('nch_lvt'); // the active device is restored too

  // Re-importing an already-loaded table refreshes it instead of duplicating a chip.
  await loadDemo(page);
  await expect(page.locator('.devices .dev')).toHaveCount(2);

  // Losing the registry sidecar (blocked/cleared localStorage) must NOT read as an
  // intentionally empty bench: the stored tables still restore, nothing is deleted.
  await page.evaluate(() => localStorage.removeItem('gmid.devreg'));
  await page.reload();
  await expect(page.locator('.devices .dev')).toHaveCount(2);

  // A structurally corrupt registry (a list of non-uids) is equally non-authoritative:
  // it must not be trusted to delete stored tables.
  await page.evaluate(() => localStorage.setItem('gmid.devreg', '{"order":[null]}'));
  await page.reload();
  await expect(page.locator('.devices .dev')).toHaveCount(2);

  // clear all → back to the empty boot state, and a reload stays empty.
  await page.locator('.devices .dclear').click();
  await expect(page.locator('.welcome')).toBeVisible();
  await page.reload();
  await expect(page.locator('.welcome')).toBeVisible();
  await expect(page.locator('.devices')).toHaveCount(0);
});

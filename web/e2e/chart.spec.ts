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
  // Chart re-rendered for the new device (2 L lines from the fixture).
  await expect(page.locator('.chart canvas').first()).toBeVisible();
  await expect(page.locator('footer')).toContainText('l=');
  await page.screenshot({ path: `${SCREENS}/import-mostab.png` });

  // Back to the demo clears QA and restores the EKV device.
  await page.locator('button.demo').click();
  await expect(page.locator('header .device')).toContainText('nmos_demo');
  await expect(page.locator('.qa')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('importer: a table without the family (L) axis errors gracefully and recovers', async ({ page }) => {
  await page.goto('/');
  // Valid file, but no L axis → familyCurves can't build the family → visible error.
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/single-l.mostab.csv');
  await expect(page.locator('header .err')).toBeVisible();
  // Returning to the demo must rebuild the chart (Effect B creates-when-missing).
  await page.locator('button.demo').click();
  await expect(page.locator('header .err')).toHaveCount(0);
  await expect(page.locator('.chart canvas').first()).toBeVisible();
});

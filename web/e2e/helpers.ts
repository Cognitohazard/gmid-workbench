import { expect, type Page, type Locator } from '@playwright/test';

// Fixture-pairing rule: the three nch_lvt fixtures are NOT freely combinable. sample.mostab.csv
// deliberately declares no `# pdk:` (it is the "declares nothing" fixture), so loading it beside
// sample-alt or sample-fab (which declare one) makes the undeclared file JOIN the declared
// device — one device holding two tables at tt@27 is a duplicate condition that refuses every
// projection, with no warning that the JOIN happened (the duplicate itself flags as a
// device-QA error). Pair sample only with differently-NAMED fixtures; a deliberate
// name collision uses sample-fab + sample-alt, which declare distinct namespaces.

// The app boots empty (no built-in data); load the EKV demo device — global-setup regenerated it
// as a fixture from the oracle — before tests that need its rich [l × vds × vsb × vgs] grid.
// This is the table every sheet in the suite is evaluated on: it carries the body-bias sweep
// the sheets declare.
export async function loadDemo(page: Page) {
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/demo.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nmos_demo');
}

// The same device without the body-bias sweep, [l × vds × vgs]: the bench then has exactly one
// bias axis to pin. Only for a chart test whose subject is the bench's slider row — never load
// it under a sheet, which would be read body-grounded on it.
export async function loadDemoNoVsb(page: Page) {
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/demo-no-vsb.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nmos_demo');
}

// Load a sheet into a SheetPanel from its grouped picker by title. Match the title as a
// substring and select by the option's value, so a label tweak cannot break every test.
export async function pickSheet(panel: Locator, title: string) {
  const sel = panel.locator('.shead select.rm');
  const value = await sel.locator('option', { hasText: title }).first().getAttribute('value');
  await sel.selectOption(value);
}

// Drive the custom quantity dropdown (QuantityPicker): open it, then click the option whose
// data-value matches (use '__custom__' for the "ƒx custom…" escape hatch).
export async function pickQuantity(picker: Locator, value: string) {
  await picker.locator('.qtrigger').click();
  if (value === '__custom__') await picker.locator('.qcustom').click();
  else await picker.locator(`.qopt[data-value="${value}"]`).click();
}

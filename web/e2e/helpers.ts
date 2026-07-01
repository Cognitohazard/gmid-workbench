import { expect, type Page } from '@playwright/test';

// The app boots empty (no built-in data); load the EKV demo device — global-setup regenerated it
// as a fixture from the oracle — before tests that need its rich [l × vds × vgs] grid.
export async function loadDemo(page: Page) {
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/demo.mostab.csv');
  await expect(page.locator('header .device')).toContainText('nmos_demo');
}

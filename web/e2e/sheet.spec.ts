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

test('design sheet: switching the example replaces the doc; a removed sheet is gone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  // The example picker offers the vetted sheets and (re)loads one without typing.
  await sp.locator('.shead select').selectOption({ label: 'Single NMOS gm/ID sizing' });
  await expect(sp.locator('.srules tr')).not.toHaveCount(0);
  await expect(sp.locator('.shead select')).toHaveValue(''); // snaps back to the placeholder

  // Removing the sheet panel drops it.
  await sp.locator('.ptools .rm', { hasText: '×' }).click();
  await expect(page.locator('.grid .panel')).toHaveCount(5);
});

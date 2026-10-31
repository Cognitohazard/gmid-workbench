import { test, expect, type Page } from '@playwright/test';
import { loadDemo, strip } from './helpers';

// Where a loaded table lives: stored in this browser (IndexedDB) so a reload restores it, or held
// for this session only and never written to browser storage. These tests read IndexedDB itself,
// not only what the page says about it.

const chip = (page: Page, device: string) => strip(page).locator('.dev', { hasText: device });

/** Every key the table store holds, read straight from the browser. Opens the database the way
 *  the app does, so a probe on a fresh profile creates the same store the app would. */
const storedKeys = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open('gmid', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('tables'))
            req.result.createObjectStore('tables');
        };
        req.onsuccess = () => {
          const db = req.result;
          const keys = db.transaction('tables').objectStore('tables').getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve(keys.result.map(String));
          };
          keys.onerror = () => {
            db.close();
            reject(keys.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
  );

test('retention: a session-only import is never stored and is gone after a reload; a stored one comes back', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  const keep = page.locator('[data-keep-next]');
  await expect(keep).toBeChecked(); // the default: kept after a reload, as before

  // Session only: untick the box, then import.
  await keep.uncheck();
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/sample.mostab.csv');
  const session = chip(page, 'nch_lvt');
  await expect(session.locator('[data-retention]')).toHaveText('session only');
  await expect(session.locator('[data-retention]')).toHaveAttribute('title', /gone after a reload/);
  await expect(session).toHaveClass(/session/);

  // Stored: tick it again and import another device.
  await keep.check();
  await loadDemo(page);
  const stored = chip(page, 'nmos_demo');
  await expect(stored.locator('[data-retention]')).toHaveAttribute('data-retention', 'stored');
  await expect(stored).not.toHaveClass(/session/);

  // The list of what the browser holds names the stored table only, with a size and a date.
  const list = page.locator('[data-stored-list]');
  await expect(list.locator('summary')).toContainText('stored: 1 table');
  await list.locator('summary').click();
  const rows = list.locator('[data-stored-row]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('nmos_demo');
  await expect(rows.first().locator('[data-stored-size]')).toHaveText(/^[\d.]+ [kMG]?B$/);
  await expect(rows.first().locator('[data-stored-date]')).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
  );
  const date = await rows.first().locator('[data-stored-date]').textContent();
  await page.screenshot({ path: 'e2e/__screens__/retention.png' });

  // IndexedDB holds exactly that table, and the registry names nothing of the session-only one.
  await expect.poll(() => storedKeys(page), { timeout: 15_000 }).toHaveLength(1);
  expect((await storedKeys(page))[0]).toContain('nmos_demo');
  expect(await page.evaluate(() => localStorage.getItem('gmid.devreg'))).not.toContain('nch_lvt');

  await page.reload();
  await expect(page.locator('.devices .dev')).toHaveCount(1);
  await expect(chip(page, 'nmos_demo')).toBeVisible();
  await expect(chip(page, 'nch_lvt')).toHaveCount(0);
  await expect(page.locator('header .device')).toContainText('nmos_demo');
  // The import date is the one recorded with the table, not the time of the reload.
  await page.locator('[data-stored-list] summary').click();
  await expect(page.locator('[data-stored-row] [data-stored-date]')).toHaveText(date ?? '');

  expect(errors).toEqual([]);
});

test('retention: the default is a setting, and a chip switches a table either way', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.locator('details.prefs summary').click();
  await page.locator('[data-new-tables]').selectOption('session');
  // The box beside the load button follows the default at once, and on every later visit.
  await expect(page.locator('[data-keep-next]')).not.toBeChecked();
  await page.reload();
  await expect(page.locator('[data-keep-next]')).not.toBeChecked();

  await loadDemo(page);
  const ret = chip(page, 'nmos_demo').locator('[data-retention]');
  await expect(ret).toHaveAttribute('data-retention', 'session');
  await expect(page.locator('[data-stored-list] summary')).toHaveText('stored: nothing');

  // Session only → stored: the table is written, and the list shows it.
  await ret.click();
  await expect(ret).toHaveAttribute('data-retention', 'stored');
  await expect(page.locator('[data-stored-list] summary')).toContainText('stored: 1 table');
  await expect.poll(() => storedKeys(page), { timeout: 15_000 }).toHaveLength(1);

  // Stored → session only: the stored copy is deleted.
  await ret.click();
  await expect(ret).toHaveAttribute('data-retention', 'session');
  await expect.poll(() => storedKeys(page), { timeout: 15_000 }).toHaveLength(0);
  await page.reload();
  await expect(page.locator('.welcome')).toBeVisible();

  // Re-importing a stored table as session only takes the stored copy away too.
  await page.locator('[data-keep-next]').check();
  await loadDemo(page);
  await expect(ret).toHaveAttribute('data-retention', 'stored');
  await expect.poll(() => storedKeys(page), { timeout: 15_000 }).toHaveLength(1);
  await page.locator('[data-keep-next]').uncheck();
  // The browser only reports a change when the selection changes, so the same file is
  // re-selected from an empty one.
  await page.locator('.load input[type=file]').setInputFiles([]);
  await loadDemo(page);
  await expect(page.locator('.devices .dev')).toHaveCount(1);
  await expect(ret).toHaveAttribute('data-retention', 'session');
  await expect.poll(() => storedKeys(page), { timeout: 15_000 }).toHaveLength(0);

  expect(errors).toEqual([]);
});

test('retention: a table stored before import dates were recorded restores and says so', async ({
  page,
}) => {
  await page.goto('/');
  // A record as an earlier build wrote it: the bare table, no import date beside it.
  await page.evaluate(async () => {
    const vgs = Float64Array.from([0.3, 0.5, 0.7]);
    const table = {
      id: { device: 'bare_dev', corner: 'tt', temp: 27 },
      meta: {},
      grid: {
        axes: [{ name: 'vgs', values: vgs }],
        shape: [3],
        quantities: new Map([
          ['vgs', vgs],
          ['id', Float64Array.from([1e-6, 4e-6, 2e-5])],
          ['gm', Float64Array.from([1e-5, 2e-5, 3e-5])],
        ]),
      },
    };
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('gmid', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('tables')) req.result.createObjectStore('tables');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('tables', 'readwrite');
        tx.objectStore('tables').put(table, 'bare-key');
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  await page.reload();
  await expect(chip(page, 'bare_dev').locator('[data-retention]')).toHaveText('stored');
  await page.locator('[data-stored-list] summary').click();
  const row = page.locator('[data-stored-row]');
  await expect(row).toContainText('bare_dev');
  // Three axis values and three columns of three, eight bytes each.
  await expect(row.locator('[data-stored-size]')).toHaveText('96 B');
  await expect(row.locator('[data-stored-date]')).toHaveText('not recorded');
});

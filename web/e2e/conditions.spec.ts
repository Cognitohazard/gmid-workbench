import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { strip, confirmImport } from './helpers';

// The import screen: one row per table with its device and its value in each condition
// dimension, opened on a batch of new files and reopened on the stored tables. These tests drive
// it the way a designer does and read the result from the bench and from IndexedDB itself.

const SCREENS = 'e2e/__screens__';
const DEMO = readFileSync('e2e/fixtures/demo.mostab.csv', 'utf8');

/** The demo table with its header lines rewritten: `drop` removes a `# key:` line, `add` puts
 *  lines after `# device:`. */
function demoWith(edit: { drop?: string[]; add?: string[] }): string {
  let text = DEMO;
  for (const k of edit.drop ?? []) text = text.replace(new RegExp(`^# ${k}:.*\\r?\\n`, 'm'), '');
  if (edit.add?.length) text = text.replace(/^(# device:.*\r?\n)/m, `$1${edit.add.join('\n')}\n`);
  return text;
}

/** Choose files through the toolbar's file input; the import screen opens on them. */
async function choose(page: Page, files: { name: string; text: string }[]): Promise<void> {
  await page
    .locator('.load input[type=file]')
    .setInputFiles(
      files.map((f) => ({ name: f.name, mimeType: 'text/csv', buffer: Buffer.from(f.text) })),
    );
  await expect(page.locator('[data-import-screen="new"]')).toBeVisible();
}

const row = (page: Page, name: string) => page.locator(`tr[data-row="${name}"]`);

interface Stored {
  key: string;
  condition: Record<string, string | number>;
  temp?: number;
  filled: string[];
  unset: string[];
  extra: Record<string, unknown>;
}

/** Every stored table, read straight from IndexedDB. */
const stored = (page: Page): Promise<Stored[]> =>
  page.evaluate(
    () =>
      new Promise<Stored[]>((resolve, reject) => {
        const req = indexedDB.open('gmid');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('tables')) return (db.close(), resolve([]));
          const store = db.transaction('tables').objectStore('tables');
          const keys = store.getAllKeys();
          const vals = store.getAll();
          vals.onsuccess = () => {
            db.close();
            resolve(
              vals.result.map((r, i) => {
                const t = r.table;
                return {
                  key: String(keys.result[i]),
                  condition: t.id.condition ?? { corner: t.id.corner, temp: t.id.temp },
                  temp: t.meta.temp,
                  filled: t.meta.filled ?? [],
                  unset: t.meta.unset ?? [],
                  extra: t.meta.extra ?? {},
                };
              }),
            );
          };
          vals.onerror = () => (db.close(), reject(vals.error));
        };
        req.onerror = () => reject(req.error);
      }),
  );

/** Poll until the store holds `n` tables, then return them. */
async function storedN(page: Page, n: number): Promise<Stored[]> {
  await expect.poll(async () => (await stored(page)).length).toBe(n);
  return stored(page);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test('import screen: a header offered as a dimension is prefilled and declared; a file without it leaves it out', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');

  // A file that declares # vdd: 1.62. The screen offers vdd as a dimension; adding it prefills
  // the value from the header, declared, and the dimension is a number.
  await choose(page, [{ name: 'demo-vdd.csv', text: demoWith({ add: ['# vdd: 1.62'] }) }]);
  await page.locator('[data-offer="vdd"]').click();
  await expect(page.locator('th[data-dim="vdd"]')).toContainText('number');
  await expect(row(page, 'demo-vdd.csv').locator('input[data-cell="vdd"]')).toHaveValue('1.62');
  await expect(row(page, 'demo-vdd.csv').locator('[data-assumed="vdd"]')).toHaveCount(0);
  await confirmImport(page);

  let tables = await storedN(page, 1);
  expect(tables[0].condition).toEqual({ corner: 'tt', temp: 27, vdd: 1.62 });
  expect(tables[0].extra.vdd).toBeDefined();
  expect(tables[0].filled).not.toContain('vdd');

  // The same file with no vdd header, on the bench that now has vdd: nothing fills it, so the
  // condition leaves vdd out and QA says so, naming the file and the dimension.
  await choose(page, [{ name: 'demo-novdd.csv', text: DEMO }]);
  await expect(row(page, 'demo-novdd.csv').locator('input[data-cell="vdd"]')).toHaveValue('');
  await confirmImport(page);

  tables = await storedN(page, 2);
  const plain = tables.find((t) => !('vdd' in t.condition));
  expect(plain?.condition).toEqual({ corner: 'tt', temp: 27 });
  expect(plain?.unset).toEqual(['vdd']);
  const qa = page.locator('.qa');
  await expect(qa).toContainText('condition-left-out');
  await expect(qa).toContainText('demo-novdd.csv');
  await expect(qa).toContainText('declares no vdd');
  // It matches no condition that has vdd: the two are two conditions of one device, not one.
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await expect(strip(page)).not.toContainText('device-duplicate-condition');

  expect(errors).toEqual([]);
});

test('import screen: a typed temperature is declared and is the one the engine reads', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');

  await choose(page, [{ name: 'demo-notemp.csv', text: demoWith({ drop: ['temp'] }) }]);
  const cell = row(page, 'demo-notemp.csv').locator('input[data-cell="temp"]');
  await expect(cell).toHaveValue('27');
  await expect(row(page, 'demo-notemp.csv').locator('[data-assumed="temp"]')).toBeVisible();
  await cell.fill('125');
  await expect(row(page, 'demo-notemp.csv').locator('[data-assumed="temp"]')).toHaveCount(0);
  await confirmImport(page);

  const [t] = await storedN(page, 1);
  expect(t.temp).toBe(125);
  expect(t.condition).toEqual({ corner: 'tt', temp: 125 });
  expect(t.filled).not.toContain('temp');

  // The header, the noise source and QA all read 125 °C, none of it assumed.
  await expect(page.locator('header [data-temp]')).toHaveText(/125°C/);
  await expect(page.locator('header [data-temp]')).not.toContainText('assumed');
  await expect(page.locator('header [data-noise]')).not.toContainText('assumed');
  const qa = page.locator('.qa');
  await expect(qa).not.toContainText('no-temp');
  // The demo's weak-inversion gm/ID sits under the 27 °C ceiling and above the 125 °C one.
  await expect(qa).toContainText('gm-id-ceiling');
  await expect(qa).toContainText('1/U_T at 125 °C)');

  expect(errors).toEqual([]);
});

test('import screen: with temperature removed as a dimension, two temperatures of one corner are a duplicate', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');

  await choose(page, [
    { name: 'demo-27.csv', text: DEMO },
    { name: 'demo-125.csv', text: demoWith({ drop: ['temp'], add: ['# temp: 125'] }) },
  ]);
  await page.getByRole('button', { name: 'remove dimension temp' }).click();
  await expect(page.locator('th[data-dim="temp"]')).toHaveCount(0);
  await confirmImport(page);

  const tables = await storedN(page, 2);
  expect(tables.map((t) => t.condition)).toEqual([{ corner: 'tt' }, { corner: 'tt' }]);
  // Each keeps the temperature its file declared: the engine reads each at its own.
  expect(tables.map((t) => t.temp).sort()).toEqual([125, 27]);

  await expect(strip(page)).toContainText('device-duplicate-condition');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('[data-blocked="nominal"]')).toBeVisible();

  expect(errors).toEqual([]);
});

test('import screen: a dimension removed while importing leaves the loaded tables too', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');

  await choose(page, [{ name: 'demo.csv', text: DEMO }]);
  await confirmImport(page);
  await storedN(page, 1);

  await choose(page, [
    { name: 'demo-ss.csv', text: demoWith({ drop: ['corner', 'temp'], add: ['# corner: ss'] }) },
  ]);
  await page.getByRole('button', { name: 'remove dimension temp' }).click();
  await confirmImport(page);

  await expect
    .poll(async () => (await stored(page)).map((t) => t.condition))
    .toEqual(expect.arrayContaining([{ corner: 'tt' }, { corner: 'ss' }]));
  expect(await stored(page)).toHaveLength(2);

  await page.locator('[data-open-conditions]').click();
  await expect(page.locator('th[data-dim="temp"]')).toHaveCount(0);
  await expect(page.locator('[data-import-screen="stored"] tbody tr[data-row]')).toHaveCount(2);

  expect(errors).toEqual([]);
});

test('import screen: cancelling a selection still says what it could not import', async ({
  page,
}) => {
  await page.goto('/');
  await choose(page, [
    { name: 'broken.json', text: '{ not json' },
    { name: 'demo.csv', text: DEMO },
  ]);
  await page.locator('[data-import-cancel]').click();
  await expect(page.locator('[data-import-screen]')).toHaveCount(0);
  await expect(page.getByText(/broken\.json/)).toBeVisible();
});

test('import screen: without a temperature dimension or header, 27 °C is assumed and said', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');

  await choose(page, [{ name: 'demo-notemp.csv', text: demoWith({ drop: ['temp'] }) }]);
  await page.getByRole('button', { name: 'remove dimension temp' }).click();
  await confirmImport(page);

  const [t] = await storedN(page, 1);
  expect(t.condition).toEqual({ corner: 'tt' });
  expect(t.temp).toBeUndefined();
  expect(t.filled).toContain('temp');
  await expect(page.locator('.qa')).toContainText('no-temp');
  await expect(page.locator('header [data-noise]')).toContainText('at 27 °C (assumed)');

  expect(errors).toEqual([]);
});

test('import screen: changing a nominal, chosen condition moves the designation and the selection with it', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');

  // Two conditions of one device; tt designated nominal and chosen in a sheet.
  await page
    .locator('.load input[type=file]')
    .setInputFiles(['e2e/fixtures/demo.mostab.csv', 'e2e/fixtures/demo-ss.mostab.csv']);
  // The screen opened on a new batch: the files, the device, and each condition value.
  const screen = page.locator('[data-import-screen="new"]');
  await expect(screen.locator('tr[data-row]')).toHaveCount(2);
  await screen.screenshot({ path: `${SCREENS}/import-screen-new.png` });
  await confirmImport(page);

  const chip = (label: string) => page.locator(`.devices .dev[data-variant="${label}"]`);
  await chip('tt').locator('.dnom').click();
  await expect(chip('tt').locator('.dnom')).toHaveText('★ nominal');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await sp.locator('[data-corner-mode]').selectOption('chosen');
  await sp.locator('.ckey', { hasText: /^tt$/ }).locator('input').check();
  const before = await storedN(page, 2);
  const oldKey = before.find((t) => t.condition.corner === 'tt')!.key;

  // Reopen the screen on the stored tables and give tt's table the corner tt_lv.
  await page.locator('[data-open-conditions]').click();
  const reopened = page.locator('[data-import-screen="stored"]');
  const corners = reopened.locator('input[data-cell="corner"]');
  const values = await corners.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  await corners.nth(values.indexOf('tt')).fill('tt_lv');
  await reopened.locator('[data-import-confirm]').click();
  await expect(reopened).toHaveCount(0);

  // The same table under the new condition, still nominal; the selection names tt_lv; nothing
  // is unresolved; the old stored record is gone and the new one is there.
  await expect(chip('tt')).toHaveCount(0);
  await expect(chip('tt_lv').locator('.dnom')).toHaveText('★ nominal');
  await expect(sp.locator('.ckey', { hasText: 'tt_lv' }).locator('input')).toBeChecked();
  await expect(sp.locator('.ckey', { hasText: /^tt$/ })).toHaveCount(0);
  await expect(page.locator('[data-condition-notes]')).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).map((t) => t.key)).not.toContain(oldKey);
  const after = await storedN(page, 2);
  expect(after.map((t) => t.condition.corner).sort()).toEqual(['ss', 'tt_lv']);

  expect(errors).toEqual([]);
});

test('import screen: reopened on a stored table after a reload, a change is stored under the new condition', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.locator('.load input[type=file]').setInputFiles('e2e/fixtures/demo.mostab.csv');
  await confirmImport(page);
  const [first] = await storedN(page, 1);

  await page.reload();
  await expect(page.locator('.devices .dev')).toHaveCount(1);
  await page.locator('[data-open-conditions]').click();
  const screen = page.locator('[data-import-screen="stored"]');
  await expect(screen.locator('tr[data-row]')).toHaveCount(1);
  const temp = screen.locator('input[data-cell="temp"]');
  await expect(temp).toHaveValue('27');
  await expect(screen.locator('input[data-cell="corner"]')).toHaveValue('tt');
  await screen.screenshot({ path: `${SCREENS}/import-screen-stored.png` });

  await temp.fill('125');
  await screen.locator('[data-import-confirm]').click();
  await expect(screen).toHaveCount(0);
  await expect(page.locator('.devices .dev[data-variant="tt@125"]')).toBeVisible();
  await expect.poll(async () => (await stored(page)).map((t) => t.key)).not.toContain(first.key);
  const [moved] = await storedN(page, 1);
  expect(moved.condition).toEqual({ corner: 'tt', temp: 125 });
  expect(moved.temp).toBe(125);

  // The change is what is stored: a reload brings the table back under its new condition.
  await page.reload();
  await expect(page.locator('.devices .dev[data-variant="tt@125"]')).toBeVisible();
  await expect(page.locator('header [data-temp]')).toHaveText(/125°C/);

  expect(errors).toEqual([]);
});

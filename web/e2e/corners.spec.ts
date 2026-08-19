import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { loadDemo, pickSheet } from './helpers';

const SCREENS = 'e2e/__screens__';
const FIX = 'e2e/fixtures';

/** Load one or more files through the toolbar's file input — one selection, one transaction. */
const load = (page: Page, ...names: string[]) =>
  page.locator('.load input[type=file]').setInputFiles(names.map((n) => `${FIX}/${n}`));

/** Two drops dispatched in the SAME task, so the second selection provably supersedes the first
 *  while the first is still reading its files. Driving this through the file input could not
 *  say when the second one landed. */
async function dropTwice(page: Page, first: string[], second: string[]): Promise<void> {
  const read = (names: string[]): [string, string][] =>
    names.map((n) => [n, readFileSync(`${FIX}/${n}`, 'utf8')]);
  await page.evaluate(
    ([a, b]) => {
      const drop = (files: [string, string][]): void => {
        const dt = new DataTransfer();
        for (const [name, text] of files)
          dt.items.add(new File([text], name, { type: 'text/csv' }));
        document
          .querySelector('.main')
          ?.dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
          );
      };
      drop(a);
      drop(b);
    },
    [read(first), read(second)],
  );
}

const strip = (page: Page) => page.locator('nav[aria-label="loaded devices"]');
/** One condition's chip in the strip. Scoped by device where the bench holds two devices whose
 *  conditions share a name (every `tt` is a `tt`). */
const variant = (page: Page, label: string, device = '') =>
  page.locator(
    `.devices .fam${device ? `[data-family="${device}"]` : ''} .dev[data-variant="${label}"]`,
  );

test('corner family: two conditions of one device group as one entry, with a nominal and QA', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // One selection, two files: a multi-corner export is several files, and they arrive together.
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);

  // One logical device: a single family group holding both conditions.
  await expect(page.locator('.devices .fam')).toHaveCount(1);
  await expect(page.locator('.devices .fname')).toContainText('nmos_demo');
  await expect(page.locator('.devices .fname')).toContainText('2 conditions');
  await expect(variant(page, 'tt')).toBeVisible();
  await expect(variant(page, 'ss@-40')).toBeVisible();

  // tt at 27 °C designates itself without anyone choosing, and says the rule chose it.
  await expect(variant(page, 'tt').locator('.dnom')).toHaveText('★ nominal · auto');
  await expect(variant(page, 'ss@-40').locator('.dnom')).toHaveText('nominal');

  // Each condition shows where it came from, so a grouping made on the device name alone is a
  // fact the designer can check rather than one the bench made out of sight.
  await expect(variant(page, 'tt').locator('.dprov')).toContainText('demo-ekv');
  await expect(variant(page, 'ss@-40').locator('.dprov')).toContainText('demo-ekv');

  // Pinning the condition the rule had already chosen is still a bench statement, and the strip
  // must stop crediting the rule for it — the two differ only in who chose, which is the whole
  // point of saying which. Clicking it again hands the choice back to the rule.
  await variant(page, 'tt').locator('.dnom').click();
  await expect(variant(page, 'tt').locator('.dnom')).toHaveText('★ nominal');
  await variant(page, 'tt').locator('.dnom').click();
  await expect(variant(page, 'tt').locator('.dnom')).toHaveText('★ nominal · auto');

  // Redesignating is a bench statement and it sticks across a reload (the registry sidecar
  // carries it alongside the load order).
  await variant(page, 'ss@-40').locator('.dnom').click();
  await expect(variant(page, 'ss@-40').locator('.dnom')).toHaveText('★ nominal');
  await page.reload();
  await expect(variant(page, 'ss@-40').locator('.dnom')).toHaveText('★ nominal');
  await expect(variant(page, 'tt').locator('.dnom')).toHaveText('nominal');

  // Deleting the designated table does NOT quietly hand the title to the survivor: the bench
  // said which condition is nominal, and it now says that choice is unresolved.
  await variant(page, 'tt').locator('.dname').click(); // ss must not be active to be removable
  await variant(page, 'ss@-40').locator('.drm').click();
  await expect(page.locator('.devices .dev')).toHaveCount(1);
  await expect(strip(page)).toContainText('designated nominal condition is not loaded');

  await page.screenshot({ path: `${SCREENS}/corner-family-strip.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('corner family: overlaying the corners is a family control, absent on a sole condition', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  // A device loaded at one condition looks exactly as it did before families existed: no
  // corners toggle, no nominal control — there is nothing to choose between.
  await expect(page.locator('.devices .fov')).toHaveCount(0);
  await expect(page.locator('.devices .dnom')).toHaveCount(0);
  await expect(page.locator('.devices .dev').first().locator('input[type=checkbox]')).toBeVisible();

  await load(page, 'demo-ss.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await variant(page, 'tt').locator('.dname').click(); // nominal active, ss free to overlay

  const p0 = page.locator('.grid .panel').first();
  await expect(p0.locator('.pfoot')).not.toContainText('ss');
  await page.locator('.devices .fov input').check();
  await expect(p0.locator('.pfoot')).toContainText('ss'); // the corner spread is on every panel
  await page.locator('.devices .fov input').uncheck();
  await expect(p0.locator('.pfoot')).not.toContainText('ss');

  expect(errors).toEqual([]);
});

test('corner family: two tables claiming one condition are an ambiguity nothing projects from', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // Two characterizations of the SAME device at the SAME condition, with different numbers.
  await load(page, 'demo.mostab.csv', 'demo-tt-alt.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);

  // The family says so, at error severity, in the strip — no silent last-one-wins.
  await expect(strip(page)).toContainText('family-duplicate-variant');
  await expect(strip(page)).toContainText('remove one or replace it explicitly');
  await expect(strip(page)).toContainText('no nominal condition');

  // And nothing evaluates there: a sheet asks for the nominal condition and is told the bench
  // has not got one, rather than being handed whichever table loaded last.
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('[data-blocked="nominal"]')).toBeVisible();

  // Designating one of the two does not resolve it either — the CONDITION is ambiguous, not the
  // choice between two conditions.
  await sp.locator('.snomctl button').first().click();
  await expect(strip(page)).toContainText('claimed by two tables');
  await expect(sp.locator('[data-blocked="nominal"]')).toBeVisible();

  // Removing one settles it, and the design evaluates again.
  await page.locator('.devices .dev').nth(1).locator('.drm').click();
  await expect(sp.locator('[data-blocked="nominal"]')).toHaveCount(0);
  await expect(sp.locator('.feasb')).toHaveText(/feasible|infeasible/);

  expect(errors).toEqual([]);
});

test('staged import: one selection is one transaction — superseded, duplicated, or partly bad', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // A selection superseded before it committed leaves NOTHING behind — not the first file of
  // it, not a reordered bench.
  await dropTwice(page, ['sample.mostab.csv'], ['single-l.mostab.csv']);
  await expect(page.locator('.devices .dev')).toHaveCount(1);
  await expect(strip(page)).toContainText('nch_singleL');
  await expect(strip(page)).not.toContainText('nch_lvt');

  // The same file twice in one selection is one table, and the import still selects it (the
  // first surviving import, found by identity of content and not by object).
  await load(page, 'sample.mostab.csv', 'sample.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await expect(page.locator('header .device')).toContainText('nch_lvt');

  // A bad file in the middle does not cost the good ones, and it is named — the report survives
  // the selection change that follows it.
  await page.locator('.devices .dclear').click();
  await load(page, 'not-mostab.csv', 'sample.mostab.csv', 'single-l.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await expect(page.locator('.qa.error')).toContainText('not-mostab.csv');
  await expect(page.locator('.qa.error')).toContainText('missing required column');
  // Order is the selection's, not whichever read finished first.
  const names = await page.locator('.devices .dev .dname').allInnerTexts();
  expect(names[0]).toContain('nch_lvt');
  expect(names[1]).toContain('nch_singleL');
  // The first file that actually imported is the active one.
  await expect(page.locator('header .device')).toContainText('nch_lvt');

  // Kinds mix inside one selection: the sheet joins the library and the table joins the bench,
  // out of the same transaction (and a table already loaded is refreshed in place, not doubled).
  await page.locator('.load input[type=file]').setInputFiles([
    {
      name: 'mixed-block.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          title: 'Mixed block',
          polarity: 'n',
          params: [{ name: 'x', value: 2 }],
          rows: [{ name: 'y', expr: '2*x' }],
          rules: [],
          provide: ['y'],
        }),
      ),
    },
    {
      name: 'sample.mostab.csv',
      mimeType: 'text/csv',
      buffer: readFileSync(`${FIX}/sample.mostab.csv`),
    },
  ]);
  await expect(page.locator('.usheets .dev', { hasText: 'mixed-block' })).toBeVisible();
  // Scoped to the devices nav: the imported-sheets strip reuses the same chip markup.
  await expect(page.locator('nav[aria-label="loaded devices"] .dev')).toHaveCount(2);

  expect(errors).toEqual([]);
});

test('sheet panel: corner mode stamps every verdict and names what it could not evaluate', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // The demo at two conditions, plus a device characterized at tt only — the child bound to it
  // has nothing to evaluate at ss.
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv', 'sample.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(3);
  await variant(page, 'tt', 'nmos_demo').locator('.dname').click();
  await expect(page.locator('header .device')).toContainText('nmos_demo');

  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'NMOS cascode (gain-boosted output)');

  // One condition: today's verdict, now saying which condition it belongs to.
  await expect(sp.locator('.feasb')).toHaveText(/feasible|infeasible/);
  await expect(sp.locator('.scond')).toHaveText('at tt');

  // Every condition: no bare verdict — the header states the aggregate over the set, and each
  // condition keeps its own answer beside its own label.
  await sp.locator('[data-corner-mode]').selectOption('all');
  await expect(sp.locator('.scorntab tr')).toHaveCount(2);
  await expect(sp.locator('[data-corner-row="tt"]')).toContainText(/closes|does not close/);
  await expect(sp.locator('[data-corner-row="ss@-40"]')).toContainText(/closes|does not close/);
  await expect(sp.locator('.feasb').first()).toContainText(
    /closes at all 2|does not close —|closure unverified/,
  );

  // A child bound to a device that is not characterized at every condition: that condition is
  // NOT EVALUATED and says which device is missing — never counted as a design that fails.
  const child = sp.locator('.suse', { hasText: 'cs' });
  await child.locator('.dsel').selectOption({ label: 'nch_lvt' });
  await expect(sp.locator('[data-corner-row="ss@-40"]')).toContainText('not evaluated');
  await expect(sp.locator('[data-corner-row="ss@-40"]')).toContainText('nch_lvt');
  await expect(sp.locator('[data-corner-row="ss@-40"]')).not.toContainText('does not close');
  await expect(sp.locator('.feasb').first()).toContainText('not evaluated');
  await expect(sp.locator('.feasb').first()).not.toContainText('closes at all');

  // The design plane and the knob ranking are statements about one point, so they wait for one.
  await expect(sp.locator('.sensb')).toBeDisabled();

  await page.screenshot({ path: `${SCREENS}/corner-breakdown.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('sheet panel: a chosen condition that leaves is answered, not forgotten', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  await variant(page, 'tt').locator('.dname').click();
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();

  await sp.locator('[data-corner-mode]').selectOption('chosen');
  await expect(sp.locator('[data-blocked="chosen"]')).toBeVisible(); // no silent fallback
  await sp.locator('.ckey', { hasText: 'tt' }).locator('input').check();
  await sp.locator('.ckey', { hasText: 'ss@-40' }).locator('input').check();
  await expect(sp.locator('.scorntab tr')).toHaveCount(2);

  // Removing the table behind a chosen condition leaves the choice standing: it is reported as
  // a condition that could not be evaluated, and it survives a reload that way.
  await variant(page, 'ss@-40').locator('.drm').click();
  await expect(sp.locator('[data-corner-row="ss@-40"]')).toContainText('not evaluated');
  await page.reload();
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('[data-corner-row="ss@-40"]')).toContainText('not evaluated');
  await expect(sp2.locator('.ckey.absent', { hasText: 'ss@-40' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('sheet panel: nominal mode refuses to substitute a condition nobody designated', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('.scond')).toHaveText('at tt'); // the auto designation

  // Designate ss, then delete it: the designation is unresolved, so "nominal" names nothing.
  await variant(page, 'ss@-40').locator('.dnom').click();
  await variant(page, 'tt').locator('.dname').click();
  await variant(page, 'ss@-40').locator('.drm').click();

  // The panel blocks and offers the designation, rather than evaluating at the active table and
  // calling the answer nominal.
  await expect(sp.locator('[data-blocked="nominal"]')).toBeVisible();
  await expect(sp.locator('.feasb')).toHaveText('not evaluated');
  await sp.locator('.snomctl button', { hasText: 'designate tt' }).click();
  await expect(sp.locator('[data-blocked="nominal"]')).toHaveCount(0);
  await expect(sp.locator('.feasb')).toHaveText(/feasible|infeasible/);

  expect(errors).toEqual([]);
});

test('legacy binding: a device literally named "family:demo" still resolves', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await load(page, 'legacy-family-name.mostab.csv');
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await page.locator('.devices .dev').first().locator('.dname').click(); // demo sizes the parent

  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'NMOS cascode (gain-boosted output)');

  // A document saved before family bindings existed stores the raw table uid in the child's
  // `device` — and that uid begins with the same word the family form uses, which is exactly
  // the string a prefix test would swallow. Patch the persisted layout to that older shape.
  const patched = await page.evaluate(() => {
    const reg = JSON.parse(localStorage.getItem('gmid.devreg') ?? '{}') as { order?: string[] };
    const uid = (reg.order ?? []).find((u) => u.startsWith('family:demo'));
    if (!uid) return null;
    const dash = JSON.parse(localStorage.getItem('gmid.dash.v2') ?? '{}') as {
      tabs: { panels: { render: string; sheet?: { uses?: { device?: string }[] } }[] }[];
    };
    for (const tab of dash.tabs)
      for (const p of tab.panels)
        if (p.render === 'sheet' && p.sheet?.uses?.[0]) p.sheet.uses[0].device = uid;
    localStorage.setItem('gmid.dash.v2', JSON.stringify(dash));
    return uid;
  });
  expect(patched).toContain('family:demo');

  await page.reload();
  const sp2 = page.locator('.grid .panel').last();
  const child = sp2.locator('.suse', { hasText: 'cs' });
  // It resolved: the run was not refused for want of a device, the block carries a verdict of
  // its own (whatever that verdict is on this small table) rather than the neutral state of a
  // block nothing evaluated, and the menu shows the device it names instead of "not loaded".
  await expect(child.locator('.susebind')).toBeVisible(); // it sized against that table
  await expect(sp2.locator('[data-not-evaluated]')).toHaveCount(0);
  await expect(sp2.locator('.pwarn', { hasText: 'did not resolve' })).toHaveCount(0);
  await expect(child.locator('.dsel')).not.toContainText('not loaded');
  await expect(child.locator('.dsel')).toContainText('family:demo');

  expect(errors).toEqual([]);
});

test('registry: a version-1 bench with a legacy pdk key restores, re-keys, and keeps its nominal', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  // A bench as an older build left it: two conditions stored in IndexedDB under keys the
  // current uid algorithm no longer computes, their process namespace still sitting in the
  // preserved `extra` metadata, and a registry naming those old keys.
  await page.evaluate(async () => {
    const table = (corner: string, temp: number) => ({
      id: { device: 'seeded_dev', corner, temp },
      meta: { W: 1e-6, simulator: 'ngspice', extra: { pdk: 'legacyPdk' } },
      grid: {
        axes: [{ name: 'vgs', values: Float64Array.from([0.3, 0.5, 0.7]) }],
        shape: [3],
        quantities: new Map([
          ['vgs', Float64Array.from([0.3, 0.5, 0.7])],
          ['id', Float64Array.from([1e-6, 4e-6, 2e-5])],
          ['gm', Float64Array.from([1e-5, 2e-5, 3e-5])],
        ]),
      },
    });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('gmid', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('tables')) req.result.createObjectStore('tables');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('tables', 'readwrite');
        const store = tx.objectStore('tables');
        store.put(table('tt', 27), 'stale-key-tt');
        store.put(table('ss', -40), 'stale-key-ss');
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    localStorage.setItem(
      'gmid.devreg',
      JSON.stringify({
        order: ['stale-key-tt', 'stale-key-ss'],
        active: 0,
        // A designation written by a build that already had them, naming the stored key.
        nominalByFamily: { '["legacypdk","seeded_dev","unknown"]': 'stale-key-ss' },
      }),
    );
  });
  await page.reload();

  // Both conditions came back, in the stored order, as one family — the namespace is read from
  // the legacy metadata, so the restored bench is not split from a fresh import of the same file.
  await expect(page.locator('.devices .dev')).toHaveCount(2);
  await expect(page.locator('.devices .fname')).toContainText('legacyPdk');
  // The designation was rewritten to the record's new key, so it still designates ss.
  await expect(variant(page, 'ss@-40').locator('.dnom')).toHaveText('★ nominal');
  await expect(strip(page)).not.toContainText('designated nominal condition is not loaded');

  // The registry is now the versioned shape, naming the re-keyed tables.
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('gmid.devreg') ?? 'null'),
  );
  expect(saved.v).toBe(2); // the stamp a later migration reads to know what it is looking at
  expect(saved.order.some((u: string) => u.startsWith('stale-key'))).toBe(false);
  expect(Object.values(saved.nominalByFamily)).not.toContain('stale-key-ss');

  expect(errors).toEqual([]);
});

test('picker: the search names its condition and goes stale when the bench moves under it', async ({
  page,
}) => {
  // One click here evaluates library sheets on the main thread; the run is stopped early, but
  // the first sheet still has to land.
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  await variant(page, 'tt').locator('.dname').click();
  await page.locator('header .btn.pick').click();
  const pk = page.locator('aside.picker');
  // It says which condition it will answer about, rather than leaving it to be assumed.
  await expect(pk.locator('.pbtn')).toContainText('at tt');

  // A few rows are enough — this is about the snapshot the rows belong to, not the ranking, so
  // the run is stopped as soon as the table has something in it.
  await pk.locator('[data-budget="evals"]').fill('1');
  await pk.locator('[data-budget="evals"]').blur();
  await pk.locator('.pbtn').click();
  await expect(pk.locator('tr.row').first()).toBeVisible({ timeout: 60_000 });
  await pk.locator('.pbtn').click(); // stop
  await expect(pk.locator('[data-progress]')).toContainText('stopped');
  await expect(pk.locator('[data-stale]')).toHaveCount(0);

  // Redesignating the nominal changes what a search would find — while the active table has not
  // moved at all. The rows on screen are answers about the old bench, and they say so.
  await variant(page, 'ss@-40').locator('.dnom').click();
  await expect(pk.locator('[data-stale]')).toContainText('the devices have changed');

  expect(errors).toEqual([]);
});

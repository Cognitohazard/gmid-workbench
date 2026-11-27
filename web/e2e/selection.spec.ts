import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { confirmImport } from './helpers';

// The bench's corner selection and the operating-range editor: what the designer types is what is
// stored, the chips name each corner from the report, the sweep and the map ask the range only
// when switched to, and a bench stored with the old per-panel corner fields loads into the one
// selection.

const SCREENS = 'e2e/__screens__';
const FIX = 'e2e/fixtures';

async function load(page: Page, ...names: string[]): Promise<void> {
  await page.locator('.load input[type=file]').setInputFiles(names.map((n) => `${FIX}/${n}`));
  await confirmImport(page);
}

const condition = (page: Page, label: string) =>
  page.locator(`.devices .fam .dev[data-variant="${label}"]`);

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** A sheet panel at tt with two operating axes typed into the editor, each from 0.8× to 1.2× its
 *  design value, written as the designer would type them. Returns the panel and the two names. */
async function sheetWithAxes(page: Page) {
  await condition(page, 'tt').locator('.dname').click();
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  const editor = sp.locator('[data-range-editor]');
  await expect(editor.locator('[data-range-count]')).toHaveAttribute('data-range-count', '0');
  await editor.locator('summary').click();
  await editor.locator('[data-axis-add]').click();
  await editor.locator('[data-axis-add]').click();
  const rows = editor.locator('[data-range-axis]');
  await expect(rows).toHaveCount(2);
  const names: string[] = [];
  for (let i = 0; i < 2; i++) {
    const row = rows.nth(i);
    names.push((await row.getAttribute('data-range-axis'))!);
    const at = Number(await row.locator('[data-axis-lo]').inputValue());
    await row.locator('[data-axis-lo]').fill(`${+(at * 0.8).toPrecision(3)}`);
    await row.locator('[data-axis-lo]').press('Tab');
    await row.locator('[data-axis-hi]').fill(`${+(at * 1.2).toPrecision(3)}`);
    await row.locator('[data-axis-hi]').press('Tab');
  }
  return { sp, editor, names };
}

test('range editor: two typed axes give four corners, named on their chips, kept as typed across a reload', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  const { sp, editor, names } = await sheetWithAxes(page);
  const [a, b] = names;

  // The count and the order are the core's: two independent axes, valued in the order typed.
  await expect(editor.locator('[data-range-count]')).toHaveAttribute('data-range-count', '4');
  await expect(editor.locator('[data-axis-order]')).toHaveAttribute('data-axis-order', `${a},${b}`);

  // Each corner's chip says which end of which axis it is, read from the report.
  const chips = sp.locator('.sedge[data-corner]');
  await expect(chips).toHaveCount(4, { timeout: 30_000 });
  await expect(chips.first()).toHaveAttribute('data-corner', `${a}=lo,${b}=lo`);
  await expect(chips.first()).toContainText(`corner ${a} low = `);
  await expect(chips.last()).toHaveAttribute('data-corner', `${a}=hi,${b}=hi`);

  // The selection counts the axes: leaving one out halves the corners at each condition.
  const corners = sp.locator('[data-corners]');
  await expect(corners.locator('[data-corner-count]')).toHaveText('5 corners');
  await corners.locator(`[data-corner-axis="${b}"] input`).uncheck();
  await expect(corners.locator('[data-corner-count]')).toHaveText('3 corners');
  await expect(chips).toHaveCount(2, { timeout: 30_000 });
  await corners.locator('[data-corner-conditions]').selectOption('all');
  await expect(corners.locator('[data-corner-count]')).toHaveText('6 corners');
  await sp.screenshot({ path: `${SCREENS}/range-editor.png` });

  // A value is kept as the text typed, and the sheet and the selection survive a reload.
  const lo = editor.locator(`[data-range-axis="${a}"] [data-axis-lo]`);
  await lo.fill('0.8e0*1');
  await lo.press('Tab');
  await page.reload();
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  const sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator(`[data-range-axis="${a}"] [data-axis-lo]`)).toHaveValue('0.8e0*1');
  await expect(sp2.locator(`[data-corner-axis="${b}"] input`)).not.toBeChecked();
  await expect(sp2.locator('[data-corner-count]')).toHaveText('6 corners');

  // The editor opens on a sheet with axes, then stays as the designer leaves it: closed, a change
  // elsewhere on the panel does not reopen it.
  const editor2 = sp2.locator('[data-range-editor]');
  await expect(editor2).toHaveAttribute('open', '');
  await editor2.locator('summary').click();
  await sp2.locator(`[data-corner-axis="${b}"] input`).check();
  await expect(sp2.locator('[data-corner-count]')).toHaveText('10 corners');
  await expect(editor2).not.toHaveAttribute('open', '');
  await editor2.locator('summary').click();

  // Dropping both axes leaves no range: the document carries none.
  const drops = sp2.locator('[data-axis-drop]');
  await drops.first().click();
  await drops.first().click();
  await expect(sp2.locator('[data-range-count]')).toHaveAttribute('data-range-count', '0');
  await expect(sp2.locator('.sedge[data-corner]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('range editor: two axes that read each other are refused, and say so', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await load(page, 'demo.mostab.csv');
  const { editor, names } = await sheetWithAxes(page);
  const [a, b] = names;
  // Each end of one axis written in terms of the other.
  const row = (n: string) => editor.locator(`[data-range-axis="${n}"]`);
  for (const [n, other] of [
    [a, b],
    [b, a],
  ]) {
    await row(n).locator('[data-axis-lo]').fill(`${other}*0.9`);
    await row(n).locator('[data-axis-lo]').press('Tab');
  }
  await expect(editor.locator('[data-axis-order="refused"]')).toContainText('read each other');
  expect(errors).toEqual([]);
});

test('sweep and map: the range is asked only when switched on, and the map says its cost first', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await load(page, 'demo.mostab.csv');
  const { sp } = await sheetWithAxes(page);

  // The sweep: off by default, and the chart says the range is not checked.
  await sp.locator('.swsel select').first().selectOption('gm_id');
  const sw = sp.locator('[data-sweep-range]');
  await expect(sw).not.toBeChecked();
  await expect(sp.locator('[data-range-not-checked]')).toBeVisible({ timeout: 30_000 });
  await sp.locator('.pchart').scrollIntoViewIfNeeded();
  await sp.screenshot({ path: `${SCREENS}/sweep-range-off.png` });
  await sw.check();
  await expect(sp.locator('[data-range-not-checked]')).toHaveCount(0, { timeout: 30_000 });
  // The legend carries the range ends once the sweep lands.
  await expect(sp.locator('.skey')).toContainText('the corner at low GBW_target, low CL', {
    timeout: 60_000,
  });
  // The chart is drawn again for the new answer, not left on the node the old one replaced.
  await expect(sp.locator('.pchart canvas')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 1400 });
  await sp.locator('.skey').evaluate((e) => e.scrollIntoView({ block: 'end' }));
  const key = (await sp.locator('.skey').boundingBox())!;
  const top = Math.max(0, key.y - 300);
  await page.screenshot({
    path: `${SCREENS}/sweep-range-on.png`,
    clip: { x: key.x, y: top, width: key.width, height: key.y + key.height - top },
  });

  // The map: its count is on screen before its switch is turned on.
  const second = sp.locator('.swsel2 select');
  const pick = await second.locator('option').nth(1).getAttribute('value');
  await second.selectOption(pick);
  const mapSw = sp.locator('[data-map-range]');
  await expect(mapSw).not.toBeChecked();
  const count = sp.locator('[data-map-count]');
  await expect(count).toContainText('evaluations in place of');
  const n = Number(await count.getAttribute('data-map-count'));
  const base = Number((await count.textContent())!.match(/in place of (\d+)/)![1]);
  expect(n).toBe(base * (1 + 4));
  await expect(sp.locator('[data-range-not-checked]')).toBeVisible({ timeout: 30_000 });
  await sp.screenshot({ path: `${SCREENS}/map-count.png` });
  await mapSw.check();
  await expect(sp.locator('[data-range-not-checked]')).toHaveCount(0, { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('the run the app sends is the selection: its conditions, its base, and the range cut to it', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as { __runs: unknown[] }).__runs = seen;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: never[]) {
      const m = msg as { job?: { kind: string } };
      if (m?.job?.kind === 'run') seen.push(JSON.parse(JSON.stringify(m.job)));
      return post.call(this, msg, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
  type Run = {
    keys: { corner: string; temp: number }[];
    base?: { corner: string; temp: number };
    doc: { operatingAxes?: { param: string }[] };
  };
  const last = () =>
    page.evaluate(() => {
      const r = (window as unknown as { __runs: unknown[] }).__runs;
      return r[r.length - 1];
    }) as Promise<Run>;

  await page.goto('/');
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  const { sp, names } = await sheetWithAxes(page);
  const [a, b] = names;
  const corners = sp.locator('[data-corners]');
  await expect(corners.locator('[data-corner-count]')).toHaveText('5 corners');

  // The default: the nominal alone, sized there, with every axis.
  await expect.poll(async () => (await last()).doc.operatingAxes?.length).toBe(2);
  let run = await last();
  expect(run.keys.map((k) => k.corner)).toEqual(['tt']);
  expect(run.base?.corner).toBe('tt');

  // Every condition, one axis: the run asks both, sized at the nominal, with that axis only.
  await corners.locator('[data-corner-conditions]').selectOption('all');
  await corners.locator(`[data-corner-axis="${a}"] input`).uncheck();
  await expect.poll(async () => (await last()).doc.operatingAxes?.map((x) => x.param)).toEqual([b]);
  run = await last();
  expect(run.keys.map((k) => k.corner).sort()).toEqual(['ss', 'tt']);
  expect(run.base?.corner).toBe('tt');
  expect(errors).toEqual([]);
});

test('a bench stored with the old per-panel corner fields loads into the one selection', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  await condition(page, 'tt').locator('.dname').click();
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await expect(sp.locator('[data-corners]')).toBeVisible();

  // The stored bench rewritten as an older build left it: no selection on the bench, and the
  // sheet panel holding the condition it asked about and whether it held the nominal design.
  const rewrite = (fields: Record<string, unknown>) =>
    page.evaluate((f) => {
      const dash = JSON.parse(localStorage.getItem('gmid.dash.v3')!);
      delete dash.corners;
      for (const tab of dash.tabs as { panels: Record<string, unknown>[] }[])
        for (const p of tab.panels) if (p.render === 'sheet') Object.assign(p, f);
      localStorage.setItem('gmid.dash.v3', JSON.stringify(dash));
    }, fields);
  const ss = { corner: 'ss', temp: -40 };

  // One chosen condition, not held: the design was sized there.
  await rewrite({ sheetCornerMode: 'chosen', sheetCornerKeys: [ss] });
  await page.reload();
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  let sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('[data-corner-condition="ss@-40"] input')).toBeChecked();
  await expect(sp2.locator('[data-badge-stamp]')).toHaveText('sized at ss@-40');

  // The same, held: the nominal design held at ss.
  await rewrite({ sheetCornerMode: 'chosen', sheetCornerKeys: [ss], sheetCornerHold: true });
  await page.reload();
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('[data-badge-stamp]')).toHaveText('the nominal design held at ss@-40');

  // Every condition.
  await rewrite({ sheetCornerMode: 'all', sheetCornerKeys: undefined, sheetCornerHold: undefined });
  await page.reload();
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('[data-corner-conditions]')).toHaveValue('all');
  await expect(sp2.locator('.scorntab tr')).toHaveCount(2);

  // Following the clicked table, which nothing stored: the nominal alone.
  await rewrite({ sheetCornerMode: 'active' });
  await page.reload();
  await load(page, 'demo.mostab.csv', 'demo-ss.mostab.csv');
  sp2 = page.locator('.grid .panel').last();
  await expect(sp2.locator('[data-corner-conditions]')).toHaveValue('base');
  await expect(sp2.locator('.scond')).toHaveText('at tt');
  expect(errors).toEqual([]);
});

test('choosing conditions on a bench with no nominal starts from a held condition and stays chosen', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  // Two slow-corner tables and no typical one: nothing designates a nominal.
  const ss = readFileSync(`${FIX}/demo-ss.mostab.csv`, 'utf8');
  const hot = ss.replace('# temp: -40', '# temp: 125');
  await page.locator('.load input[type=file]').setInputFiles([
    { name: 'ss-cold.mostab.csv', mimeType: 'text/csv', buffer: Buffer.from(ss) },
    { name: 'ss-hot.mostab.csv', mimeType: 'text/csv', buffer: Buffer.from(hot) },
  ]);
  await confirmImport(page);
  await page.locator('.devices .fam .dev .dname').first().click();
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  const editor = sp.locator('[data-range-editor]');
  await editor.locator('summary').click();
  await editor.locator('[data-axis-add]').click();
  const corners = sp.locator('[data-corners]');
  await corners.locator('[data-corner-conditions]').selectOption('chosen');
  await expect(corners.locator('[data-corner-conditions]')).toHaveValue('chosen');
  await expect(corners.locator('[data-corner-condition] input').first()).toBeChecked();
  expect(errors).toEqual([]);
});

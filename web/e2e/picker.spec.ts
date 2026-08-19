import { readdirSync } from 'node:fs';
import { test, expect, type Locator } from '@playwright/test';
import { loadDemo } from './helpers';

const SCREENS = 'e2e/__screens__';

// The searchable set recomputed from the sheets folder, independently of the app's own
// SEARCHABLE_SHEETS (which cannot be imported here — library.ts is built on import.meta.glob,
// which only resolves inside Vite). Recomputing it rather than hard-coding a number means the
// test tracks a sheet being added or excluded, and still catches the panel silently dropping
// one from the queue.
// Excluded by full path, as the core curation writes them: a basename match would also drop a
// future sheet of the same name filed in another group, so the oracle would keep agreeing with
// the app for a reason of its own rather than because both are right.
const NOT_SEARCHABLE = [
  'multistage/stage2-current-source-load.json',
  'stages/sampling-switch.json',
];
const SEARCHABLE = ['stages', 'otas', 'multistage']
  .flatMap((d) => readdirSync(`../sheets/${d}`).map((f) => `${d}/${f}`))
  .filter((f) => f.endsWith('.json') && !NOT_SEARCHABLE.includes(f)).length;

// The whole library is searched on the main thread with the shipped per-sheet budget, so this
// test spends several seconds inside one click. That is the behaviour under test — the panel
// must stay responsive while it happens — so the budget is left at its default rather than
// shrunk for speed.
test.describe.configure({ timeout: 180_000 });

const titlesOf = (t: Locator) => t.locator('tr.row .open').allInnerTexts();

test('topology picker: search streams, sorts, partitions, and hands off to a sheet', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await loadDemo(page);
  await expect(page.locator('.grid .panel')).toHaveCount(5); // canonical preset

  // A sheet panel of the designer's own, to prove the picker never writes into one. Pinned by
  // INDEX, not `.last()`: locators re-resolve on every use, so `.last()` would silently become
  // the panel the picker adds later — and the assertion meant to protect this one would be
  // aimed at that one. Asserted on `.shead strong` (the title), never on `.shead`, whose sheet
  // <select> lists every library title and so satisfies a text match on any sheet panel.
  await page.getByRole('button', { name: '+ sheet' }).click();
  const own = page.locator('.grid .panel').nth(5);
  await expect(own.locator('.shead strong')).toHaveText('Single NMOS gm/ID sizing');

  await page.locator('header .btn.pick').click();
  const pk = page.locator('aside.picker');
  await expect(pk).toBeVisible();

  // Spec entry commits engineering notation on change and normalizes the display.
  const spec: [string, string, string][] = [
    ['VDD', '1.8', '1.8'],
    ['CL', '2p', '2p'],
    ['Av_target', '40', '40'],
    ['GBW_target', '1e7', '10meg'], // SPICE convention: mega is "meg", not "M"
  ];
  for (const [name, typed, shown] of spec) {
    const box = pk.locator(`input[data-spec="${name}"]`);
    await box.fill(typed);
    await box.blur();
    await expect(box).toHaveValue(shown);
  }

  await pk.getByRole('button', { name: /^search \d+ sheets/ }).click();

  // Progressive: rows land while the run is still going (the stop button is still up).
  const rows = pk.locator('tr.row');
  await expect(rows.first()).toBeVisible();
  await expect(pk.getByRole('button', { name: 'stop' })).toBeVisible();

  // ...and the run finishes on its own, one candidate per searchable sheet.
  await expect(pk.getByRole('button', { name: /^search \d+ sheets/ })).toBeVisible({
    timeout: 150_000,
  });
  // Idle again, and still naming the condition the next search would answer about.
  await expect(pk.locator('.go .pbtn')).toHaveText(`search ${SEARCHABLE} sheets at tt`);
  await expect(rows).toHaveCount(SEARCHABLE);
  await expect(pk.locator('[data-progress]')).toContainText(`${SEARCHABLE} of ${SEARCHABLE}`);
  // A sheet the queue could not evaluate at all is named, not silently missing from the count.
  await expect(pk.locator('.fail')).toHaveCount(0);

  // Every verdict renders as its own chip, and no cause cell comes out visually empty. That the
  // three verdicts are all REACHABLE, and that the core never composes a blank cause, is pinned
  // in vitest across the whole library; what is checked here is that the panel shows them.
  await expect(pk.locator('tr.v-closed .chip').first()).toHaveText('closed');
  await expect(pk.locator('tr.v-did-not-close .chip').first()).toHaveText('did not close');
  await expect(pk.locator('tr.v-could-not-be-searched .chip').first()).toHaveText('not searched');
  const whys = await pk.locator('tr.row td.why').allInnerTexts();
  expect(whys).toHaveLength(SEARCHABLE);
  expect(whys.filter((t) => t.trim() === '')).toEqual([]);
  await page.screenshot({ path: `${SCREENS}/picker.png`, fullPage: true });

  // The sort dropdown reorders the ranked section (same candidates, different order).
  const ranked = pk.locator('table[data-section="ranked"]');
  const byMargin = await titlesOf(ranked);
  await pk.locator('select[data-sort]').selectOption('current');
  const byCurrent = await titlesOf(ranked);
  expect(byCurrent).not.toEqual(byMargin);
  expect([...byCurrent].sort()).toEqual([...byMargin].sort());

  // Candidates that consumed under two of the four supplied fields are partitioned out of the
  // sort entirely — they answer a different question, and are never mixed into the ranking.
  // What the partition RULE is stays a core concern (rankCandidates, pinned in vitest); what
  // this suite owns is that the panel renders the two sections as disjoint tables.
  const partition = pk.locator('table[data-section="partition"]');
  const partitioned = await titlesOf(partition);
  expect(partitioned.length).toBeGreaterThan(0);
  expect(byCurrent.filter((t) => partitioned.includes(t))).toEqual([]);

  // Handing off: the row opens a NEW sheet panel carrying the knobs the search found and the
  // spec fields the sheet consumed.
  const row = pk.locator('tr.row[data-path="multistage/two-stage-miller-ota"]');
  const knob = row.locator('code[data-knob]').first();
  // Named rather than asserted-through: if the search ever stops moving a knob on this sheet the
  // failure should read as "no knob was reported", not as a locator timeout on a value read.
  await expect(knob).toBeVisible();
  const knobName = await knob.getAttribute('data-knob');
  const knobValue = (await knob.innerText()).split('=')[1];
  expect(knobValue).toBeTruthy();

  await row.locator('button.open').click();
  await expect(page.locator('.grid .panel')).toHaveCount(7);
  const opened = page.locator('.grid .panel').nth(6);
  await expect(opened.locator('.shead strong')).toHaveText('Two-stage Miller OTA');
  await expect(opened.locator(`.svar[data-param="${knobName}"] .num`)).toHaveValue(knobValue);
  await expect(opened.locator('.svar[data-param="VDD"] .num')).toHaveValue('1.8');
  await expect(opened.locator('.svar[data-param="CL"] .num')).toHaveValue('2p');

  // The designer's own sheet panel is untouched — the handoff appends, it never adopts.
  await expect(own.locator('.shead strong')).toHaveText('Single NMOS gm/ID sizing');

  // Stopping a run keeps what it found and says it stopped.
  await pk.getByRole('button', { name: /^search \d+ sheets/ }).click();
  await expect(rows.first()).toBeVisible();
  await pk.getByRole('button', { name: 'stop' }).click();
  await expect(pk.locator('[data-progress]')).toContainText('stopped');
  const stoppedAt = await rows.count();
  await page.waitForTimeout(800);
  expect(await rows.count()).toBe(stoppedAt);

  expect(errors).toEqual([]);
});

test('topology picker: with no spec typed, every sheet is screened at its own values', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.locator('header .btn.pick').click();
  const pk = page.locator('aside.picker');

  // A short per-sheet budget: this run is about what the panel SAYS with an empty spec, not
  // about how deep the search gets, and it exercises the budget control at the same time.
  const budget = pk.locator('input[data-budget="ms"]');
  await budget.fill('30');
  await budget.blur();

  await pk.getByRole('button', { name: /^search \d+ sheets/ }).click();
  await expect(pk.getByRole('button', { name: /^search \d+ sheets/ })).toBeVisible({
    timeout: 120_000,
  });
  await expect(pk.locator('tr.row')).toHaveCount(SEARCHABLE);

  // With nothing supplied there is nothing to be short of, so nothing is partitioned out...
  await expect(pk.locator('table[data-section="partition"]')).toHaveCount(0);
  // ...and the coverage cell says what happened rather than reporting "0 of your 0".
  const cov = await pk.locator('tr.row td.cov').allInnerTexts();
  expect([...new Set(cov)]).toEqual(['defaults']);

  // Typing a field after the run says so, instead of leaving the table looking like its answer.
  const vdd = pk.locator('input[data-spec="VDD"]');
  await vdd.fill('1.8');
  await vdd.blur();
  await expect(pk.locator('[data-stale]')).toContainText('search again');
});

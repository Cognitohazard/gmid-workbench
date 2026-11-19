import { readdirSync, readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { loadDemo, pickSheet } from './helpers';

// The verdict words live in one place, the core's VERDICT_WORDS. A file of the app that spells one
// as text it shows would be a second place, free to drift from the first. A literal that IS the
// word (`'feasible'`, a verdict's own value) and a key (`feasible:`) are code, not text.
test('verdict words: no file of the app writes a verdict word of its own', () => {
  const WORDS =
    /(?<![\w.$-])(feasible|infeasible|non-compliant|compliant|undetermined|no operating point|not calculated)(?![\w-])/g;
  const strip = (s: string) =>
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const found: string[] = [];
  for (const f of readdirSync('src')) {
    if (!/\.(ts|svelte)$/.test(f)) continue;
    strip(readFileSync(`src/${f}`, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(WORDS)) {
          const before = line[m.index - 1];
          const after = line[m.index + m[0].length];
          if ((before === "'" && after === "'") || after === ':') continue;
          // "has not calculated" is a verb, not the state.
          if (m[0] === 'not calculated' && /has $/.test(line.slice(0, m.index))) continue;
          found.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  expect(found).toEqual([]);
});

// Four verdicts, and a value that was not calculated: five looks a reader tells apart at a glance,
// without colour too — so each differs from every other by its glyph and by its border or fill.
// Infeasible and no operating point need a proof no run gives yet, so this renders a made-up
// result of each kind from the app's own looks.
test('verdict looks: each verdict reads apart from the others without colour', async ({ page }) => {
  await page.goto('/');
  const looks = await page.evaluate(async () => {
    const m = await import('/src/verdict.ts');
    const kinds = ['feasible', 'non-compliant', 'infeasible', 'undetermined', null] as const;
    return kinds.map((v) => {
      const look = m.lookOf(v);
      const el = document.createElement('span');
      el.className = look.cls;
      el.textContent = `${look.glyph} x`;
      document.body.append(el);
      const cs = getComputedStyle(el);
      const shape = [
        look.glyph,
        cs.borderTopStyle,
        cs.borderTopWidth,
        cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'no fill' : 'fill',
        cs.fontStyle,
      ].join(' ');
      el.remove();
      return { v, shape, glyph: look.glyph };
    });
  });
  const shapes = looks.map((l) => l.shape);
  expect(new Set(shapes).size).toBe(shapes.length);
  expect(new Set(looks.map((l) => l.glyph)).size).toBe(looks.length);
  // The not-calculated look is an em dash, never a bare minus a reader takes for a number.
  expect(looks[4].glyph).toBe('—');
  // A held verdict shares the look of the design verdict beside it.
  const held = await page.evaluate(async () => {
    const m = await import('/src/verdict.ts');
    return [
      m.LOOK.compliant.cls === m.LOOK.feasible.cls,
      m.LOOK['no-operating-point'].cls === m.LOOK.infeasible.cls,
    ];
  });
  expect(held).toEqual([true, true]);
});

// A name in a reason that names a row the panel draws is a link to that row.
test('verdict reason: a name that names a row on the panel brings that row into view', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'Single NMOS gm/ID sizing');
  // At its defaults the sheet is non-compliant: headroom fails, and the reason names it.
  await expect(sp.locator('[data-feasibility]')).toHaveAttribute('data-verdict', 'non-compliant');
  const link = sp.locator('[data-verdict-reason] [data-ref="requirement::headroom"]').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(sp.locator('[data-item="requirement::headroom"]')).toHaveClass(/sflash/);
});

// One place for each fact: an item that failed inside a block is told in full in that block's
// card. Under the sheet's badge only the verdict line names it, and the name links to the card.
test('verdict reason: a failed item of a block is told in its card, and the badge links to it', async ({
  page,
}) => {
  await page.goto('/');
  await loadDemo(page);
  await page.getByRole('button', { name: '+ sheet' }).click();
  const sp = page.locator('.grid .panel').last();
  await pickSheet(sp, 'SC settling to OTA spec');
  // A drain voltage the demo table does not hold: block in's device is outside its table.
  const vds = sp.locator('.svar[data-param="vds_in"] .num');
  await vds.fill('0.18');
  await vds.blur();
  await expect(sp.locator('[data-feasibility]')).toHaveAttribute('data-verdict', 'undetermined');
  await expect(sp.locator('[data-verdict-reason] p')).toHaveCount(1);
  const card = sp.locator('.suse[data-block="in"]');
  // The card holds the item's own lines, with what was asked and what the table holds.
  await expect(card.locator('[data-block-reason]')).toContainText('0.18 V');
  await expect(sp.locator('[data-verdict-reason]')).not.toContainText('0.18 V');
  await sp.locator('[data-verdict-reason] [data-ref="block:in"]').first().click();
  await expect(card).toHaveClass(/sflash/);
});

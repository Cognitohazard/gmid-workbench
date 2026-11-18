// A measurement, not a gate: every library sheet evaluated on the simpler demo device and on the
// full-range EKV device (src/demo/ekv.ts), with how each ends recorded side by side. It asserts
// nothing and is skipped unless asked for, so it never fails the suite and costs it nothing:
//
//   GMID_MEASURE=1 npx vitest run src/sheet/library.ekv.measure.test.ts
//
// prints a Markdown table, and GMID_MEASURE=<path> writes it to that file as well. Devices are
// bound the way the library goldens bind them: runSheet with the one n-type table, so every
// block, n and p, is sized on it and the two columns are comparable.

import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { ekvTable } from '../demo/ekv.fixtures';
import type { DeviceTable } from '../types';
import { runSheet } from './index';
import { loadLibrary, REFS, table as demoTable } from './library.fixtures';
import { outsideIn, isHardCheck, type SheetBlockReport, type SheetResult } from './types';

const MEASURE = process.env.GMID_MEASURE;

/** A message that says a device was read somewhere other than where it was asked for. */
const ELSEWHERE = /it has no \w+ sweep|is (above|below) what the table holds/;

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** How one evaluation ended, as the lines of one table cell. */
function ending(res: SheetResult | undefined, error: string | undefined): string[] {
  if (!res) return [`threw: ${error}`];
  const out: string[] = [];
  const p = res.point;
  out.push(`point: ${p ? p.state : 'none'}${p?.error ? ` — ${p.error}` : ''}`);
  const failing: string[] = [];
  const walk = (n: { checks: SheetResult['checks']; blocks?: SheetBlockReport[] }, at: string) => {
    for (const c of n.checks)
      if (isHardCheck(c.kind) && c.status === 'fail') failing.push(`${at}${c.id} (${c.text})`);
    for (const b of n.blocks ?? []) walk(b, `${at}${b.name}.`);
  };
  walk(res, '');
  if (failing.length) out.push(`hard checks failing: ${failing.join('; ')}`);
  const s = res.solve;
  out.push(
    `solve: ${s ? s.kind : 'nothing solved'}${s && s.kind !== 'settled' ? ` — ${s.message}` : ''}`,
  );
  for (const e of res.rangeEnds ?? [])
    out.push(`range end ${e.name}: ${e.state}${e.error ? ` — ${e.error}` : ''}`);
  const off = [
    ...outsideIn(res).map((c) => `defaults: ${c.device} ${c.quantity}`),
    ...(res.rangeEnds ?? []).flatMap((e) =>
      outsideIn(e).map((c) => `${e.name}: ${c.device} ${c.quantity}`),
    ),
  ];
  if (off.length) out.push(`read off the table: ${off.join('; ')}`);
  const said = new Set<string>();
  for (const w of res.warnings) if (ELSEWHERE.test(w.message)) said.add(`defaults: ${w.message}`);
  for (const e of res.rangeEnds ?? [])
    for (const w of e.warnings) if (ELSEWHERE.test(w.message)) said.add(`${e.name}: ${w.message}`);
  for (const m of said) out.push(m);
  return out;
}

function evaluate(doc: Parameters<typeof runSheet>[0], t: DeviceTable) {
  try {
    return { res: runSheet(doc, t, undefined, REFS), error: undefined };
  } catch (e) {
    return { res: undefined, error: e instanceof Error ? e.message : String(e) };
  }
}

describe.skipIf(!MEASURE)('library measured on the full-range EKV device', () => {
  it('records how every sheet ends on each device', () => {
    const ekv = ekvTable();
    const rows: string[] = [
      '| sheet | simpler demo device | full-range EKV device |',
      '| --- | --- | --- |',
    ];
    for (const { file, doc } of loadLibrary()) {
      const a = evaluate(doc, demoTable);
      const b = evaluate(doc, ekv);
      const fmt = (lines: string[]) => lines.map(cell).join('<br>');
      rows.push(`| ${file} | ${fmt(ending(a.res, a.error))} | ${fmt(ending(b.res, b.error))} |`);
    }
    const text = rows.join('\n') + '\n';
    console.log(text);
    if (MEASURE && MEASURE !== '1') writeFileSync(MEASURE, text);
  }, 1_800_000);
});

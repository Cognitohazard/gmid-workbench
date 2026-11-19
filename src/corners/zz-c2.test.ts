// Comparison harness for the corners module and the picker: records every old output, and the new
// verdict fields where they exist. Not committed.
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { aggregateConditionRuns, groupDevices, runConditions, sweepAtCondition } from './index';
import { generateEkvDevice } from '../demo/ekv';
import { ekvTable } from '../demo/ekv.fixtures';
import { pickTopology, type PickerSpec } from '../picker';
import { withParams } from '../sheet';
import { libraryEntries, loadLibrary, REFS, table } from '../sheet/library.fixtures';
import { engineSolved, sweepable } from '../sheet/types';
import type { DeviceTable } from '../types';

const PART = process.env.PART ?? 'all';
const fin = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v);
const retag = (t: DeviceTable, corner: string, temp: number): DeviceTable => ({ ...t, id: { ...t.id, corner, temp } }) as DeviceTable;
const tt = { corner: 'tt', temp: 27 };
const ss = { corner: 'ss', temp: 125 };
const ff = { corner: 'ff', temp: -40 };

function devices() {
  const demo = groupDevices([retag(table, 'tt', 27), retag(table, 'ss', 125), retag(table, 'ff', -40)])[0];
  const ekv = groupDevices([
    retag(ekvTable(), 'tt', 27),
    retag(generateEkvDevice({ corner: 'ss', vtShift: 0.05, ispecFactor: 0.8, tempC: 125 }), 'ss', 125),
    retag(generateEkvDevice({ corner: 'ff', vtShift: -0.05, ispecFactor: 1.2, tempC: -40 }), 'ff', -40),
  ])[0];
  return [['demo', demo, table], ['ekv', ekv, ekvTable()]] as const;
}

function variants(doc: Parameters<typeof withParams>[0]) {
  const out: [string, typeof doc][] = [['defaults', doc]];
  for (const p of doc.params) if (sweepable(p)) { out.push([`${p.name}=min`, withParams(doc, { [p.name]: p.min })]); out.push([`${p.name}=max`, withParams(doc, { [p.name]: p.max })]); }
  for (const p of doc.params) if (!engineSolved(p) && typeof p.value === 'number' && p.value !== 0) for (const f of [0.2, 5]) out.push([`${p.name}x${f}`, withParams(doc, { [p.name]: p.value * f })]);
  return out;
}

it('corners', () => {
  if (PART !== 'all' && PART !== 'corners') return;
  const out: Record<string, unknown> = {};
  for (const [dn, dev] of devices())
    for (const { file, doc } of loadLibrary())
      for (const [label, d] of variants(doc)) {
        const runs = runConditions(d, dev, [tt, ss, ff], () => undefined, REFS, tt);
        const agg = aggregateConditionRuns(runs);
        out[`${dn}|${file}|${label}`] = {
          runs: runs.map((r) => ({
            key: r.key.corner, state: r.state, design: r.design,
            feasible: r.state === 'evaluated' ? r.feasible : undefined,
            points: r.points.map((p) => ({ rangeEnd: p.rangeEnd, state: p.state, error: p.error, outside: p.outside?.length ?? 0, verdict: (p as any).verdict?.verdict })),
            issues: r.state === 'not-evaluated' ? r.issues.map((i) => i.kind + '|' + i.message) : undefined,
          })),
          agg: { feasibility: agg.feasibility, compliance: agg.compliance, worst: agg.worst, onLimit: agg.onLimit, verdict: (agg as any).verdict?.verdict, heldPoints: (agg as any).heldPoints },
        };
      }
  writeFileSync(process.env.OUT_CORNERS!, JSON.stringify(out, fin));
}, 7_200_000);

it('sweeps', () => {
  if (PART !== 'all' && PART !== 'sweeps') return;
  const out: Record<string, unknown> = {};
  for (const [dn, dev] of devices())
    for (const { file, doc } of loadLibrary()) {
      const p = doc.params.find((q) => sweepable(q));
      if (!p) continue;
      for (const [label, base] of [['sized', tt], ['held', tt]] as const) {
        const key = label === 'sized' ? tt : ss;
        const sw = sweepAtCondition(doc, p.name, dev, key, () => undefined, REFS, { base, windows: true });
        out[`${dn}|${file}|${p.name}|${label}`] = { x: sw.x, feasible: sw.feasible, stands: sw.stands, windows: sw.windows, verdict: (sw as any).verdict };
      }
    }
  writeFileSync(process.env.OUT_SWEEPS!, JSON.stringify(out, fin));
}, 7_200_000);

it('picker', () => {
  if (PART !== 'all' && PART !== 'picker') return;
  const SPECS: Record<string, PickerSpec> = {
    empty: {},
    relaxed: { VDD: 1.8, CL: 2e-12, Av_target: 10, GBW_target: 5e6, SR_target: 2e6, vn_target: 1e-7, vos_target: 0.04 },
    gain4: { VDD: 1.8, Av_target: 4 },
  };
  const out: Record<string, unknown> = {};
  for (const [dn, , t] of devices())
    for (const e of libraryEntries())
      for (const [sn, spec] of Object.entries(SPECS)) {
        const c = pickTopology(spec, e, t, undefined, { refs: REFS });
        out[`${dn}|${e.path}|${sn}`] = c;
      }
  writeFileSync(process.env.OUT_PICKER!, JSON.stringify(out, fin));
}, 7_200_000);

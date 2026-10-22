// What a picker candidate rests on that the spec did not state. Pinned on the example sheets and
// the synthetic demo device, so it holds whatever the library's own sheets are doing.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, withoutColumns } from '../demo';
import { EXAMPLES } from '../sheet/examples';
import { runSheet, type SheetDoc } from '../sheet';
import type { DeviceTable } from '../types';
import { pickTopology, runCaveats } from './index';

const declared = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.05 } });
/** The same device as the importer reads a file with no `gamma` or `gmb` column and no
 *  `# temp:` header: γ read back from the stored noise against gm alone, at an assumed 27 °C. */
const lessDeclared: DeviceTable = {
  ...withoutColumns(declared, ['gamma', 'gmb']),
  meta: { ...declared.meta, temp: undefined, filled: ['temp'] },
};
const entry = { path: 'stages/single-nmos', doc: EXAMPLES[0] };

describe('runCaveats', () => {
  it('owes nothing on a run whose devices read every figure by its definition', () => {
    expect(runCaveats(runSheet(EXAMPLES[0], declared), EXAMPLES[0])).toEqual({
      sentences: [],
      items: 0,
    });
  });

  it('names the devices whose noise falls back or rests on an assumed temperature', () => {
    expect(runCaveats(runSheet(EXAMPLES[0], lessDeclared), EXAMPLES[0])).toEqual({
      sentences: [
        "noise: measured · no gmb column: gamma, svth_m, vnth_m · at 27 °C (assumed) — this sheet's own device",
      ],
      items: 1,
    });
  });

  it('owes nothing for a body bias the wiring ties to zero, and names one it does not', () => {
    // The example with its body bias left to the default, on a table that sweeps it: the sizing
    // records the default. The example's wiring puts source and body on ground, so the default
    // is the wiring's own value; with the source lifted off the body it is an assumption.
    const { vsb: _vsb, ...givens } = EXAMPLES[0].givens!;
    const doc: SheetDoc = { ...EXAMPLES[0], givens };
    const table = generateDemoDevice({
      vds: { min: 0, max: 1.2, step: 0.05 },
      vsb: { min: 0, max: 0.9, step: 0.3 },
    });
    const res = runSheet(doc, table);
    expect(res.sizing?.assumed).toEqual(['vsb']);
    expect(runCaveats(res, doc)).toEqual({ sentences: [], items: 0 });
    const lifted: SheetDoc = { ...doc, nodes: { d: 'out', g: 'in', s: 'src', b: 'gnd' } };
    expect(runCaveats(res, lifted)).toEqual({
      sentences: ["vsb left at its default: this sheet's own device"],
      items: 1,
    });
  });
});

describe('pickTopology carries the run’s caveats', () => {
  it('on the candidate, beside the verdict, with how many things they name', () => {
    const plain = pickTopology({}, entry, declared, undefined, { evalBudget: 4 });
    expect(plain.caveats).toBeUndefined();
    expect(plain.caveatItems).toBeUndefined();
    const c = pickTopology({}, entry, lessDeclared, undefined, { evalBudget: 4 });
    expect(c.verdict).toBe(plain.verdict);
    const expected = runCaveats(runSheet(EXAMPLES[0], lessDeclared), EXAMPLES[0]);
    expect(c.caveats).toEqual(expected.sentences);
    expect(c.caveatItems).toBe(expected.items);
  });
});

// What a picker candidate rests on that the spec did not state. Pinned on the example sheets and
// the synthetic demo device, so it holds whatever the library's own sheets are doing.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, withoutColumns } from '../demo';
import { EXAMPLES } from '../sheet/examples';
import { runSheet } from '../sheet';
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
    expect(runCaveats(runSheet(EXAMPLES[0], declared))).toEqual([]);
  });

  it('names the devices whose noise falls back or rests on an assumed temperature', () => {
    const caveats = runCaveats(runSheet(EXAMPLES[0], lessDeclared));
    expect(caveats).toEqual([
      "noise: measured · no gmb column: gamma, svth_m, vnth_m · at 27 °C (assumed) — this sheet's own device",
    ]);
  });
});

describe('pickTopology carries the run’s caveats', () => {
  it('on the candidate, beside the verdict, and only where there are some', () => {
    const plain = pickTopology({}, entry, declared, undefined, { evalBudget: 4 });
    expect(plain.caveats).toBeUndefined();
    const c = pickTopology({}, entry, lessDeclared, undefined, { evalBudget: 4 });
    expect(c.verdict).toBe(plain.verdict);
    expect(c.caveats).toEqual(runCaveats(runSheet(EXAMPLES[0], lessDeclared)));
  });
});

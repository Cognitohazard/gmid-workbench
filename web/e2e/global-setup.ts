import { writeFileSync } from 'node:fs';
import path from 'node:path';
// The synthetic EKV oracle is an internal test fixture (not in the public barrel), so import it
// by deep path. importMostab comes from the public surface.
import {
  generateDemoDevice,
  scaleQuantities,
  signedMirrorDemo,
  toMostabCsv,
} from '../../src/demo/index';
import { importMostab, type DeviceTable } from '../../src/index';

// The app used to BOOT with `generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } })`.
// Now the app boots empty, so the e2e suite loads that device from a file instead. We
// regenerate it here (rather than commit a multi-megabyte blob) so the fixture always tracks the
// oracle.
//
// The table the suite loads carries a body-bias sweep as well, because the sheets the tests
// open use one: a design sheet declares `vsb` for every device whose source sits above its body
// (an input pair on its tail node, a cascode on the node under it), and a device is sized only
// on a table that sweeps every bias its givens state. The sweep is coarse — four slices, 0 to
// 0.9 V in 0.3 V steps — to keep the file a quarter of the size the core suite's 0.05 V step
// would make it: these tests check what the app SAYS, not the numbers to four digits. The range
// is the core suite's, which reaches past every body bias a library sheet asks for at its
// defaults or at an end of its operating range. The vsb = 0 slice is the table without the
// axis, to the last bit, and the bench seeds a body-bias slider at its first value, so every
// chart assertion written against the three-axis device (4 lengths, 19 vds values, gm/ID
// ceiling, etc.) sees the same curves.
const VDS = { min: 0.3, max: 1.2, step: 0.05 };
const VSB = { min: 0, max: 0.9, step: 0.3 };

export default function globalSetup(): void {
  const demo = generateDemoDevice({ vds: VDS, vsb: VSB });
  writeFixture(demo, 'demo.mostab.csv');
  // The same device characterized body-grounded only: three axes, so the bench shows ONE bias
  // slider. For the chart tests whose subject is that slider row, and for the sheet test about
  // a table that lacks a sweep: a sheet with every source at its body runs on it, and one that
  // lifts a source is refused.
  writeFixture(generateDemoDevice({ vds: VDS }), 'demo-no-vsb.mostab.csv');
  // A SECOND device a sheet can really be sized on, for the tests about choosing between loaded
  // devices: another name, both bias sweeps (vds in coarse 0.3 V steps — those tests check what
  // the app says, and the bias points they use fall on these nodes), and half the current per
  // unit width at every gate voltage. A block pointed at it therefore sizes to twice the width
  // it has on the demo device, so the choice shows in the block's own numbers. The body
  // transconductance and the thermal noise halve with gm, so the stored noise still gives the
  // stored γ and the table passes its own QA.
  const half = scaleQuantities(
    generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.3 }, vsb: VSB }),
    { id: 0.5, gm: 0.5, gmb: 0.5, sth: 0.5 },
  );
  writeFixture({ ...half, id: { ...half.id, device: 'nmos_half' } }, 'demo-half.mostab.csv');
  // The same oracle recast as a signed-convention PMOS table (negative vgs/vds axes),
  // for the cross-polarity overlay test.
  writeFixture(signedMirrorDemo(demo), 'pmos-demo.mostab.csv');
  // A second characterization CONDITION of the same device: same headers apart from corner and
  // temperature, so it groups into one device, with the output conductance doubled — the
  // intrinsic gain therefore halves, which is what makes a per-condition verdict differ from
  // the nominal one instead of merely being labelled differently.
  writeFixture(cornerCondition(demo, 'ss', -40, { gds: 2 }), 'demo-ss.mostab.csv');
  // A SECOND table claiming the condition demo.mostab.csv already claims, with different data:
  // one device, one condition, two characterizations of it — the ambiguity nothing may project
  // from until the bench removes one.
  writeFixture(cornerCondition(demo, 'tt', 27, { gds: 1.5 }), 'demo-tt-alt.mostab.csv');
  // A device whose NAME begins with the discriminator a `family:` binding uses. Its table uid then
  // begins with that word too, which is exactly the string a binding resolver that tested the
  // prefix first would swallow — so a document naming this table by uid must still resolve.
  writeFixture(
    { ...demo, id: { ...demo.id, device: 'family:demo' } },
    'legacy-family-name.mostab.csv',
  );
}

/** One corner of a device: the same table under another condition, with named quantity columns
 *  scaled by the fixture helper the core suite uses for the same purpose. */
function cornerCondition(
  t: DeviceTable,
  corner: string,
  temp: number,
  scale: Record<string, number>,
): DeviceTable {
  const scaled = scaleQuantities(t, scale);
  return { ...scaled, id: { ...scaled.id, corner, temp } };
}

function writeFixture(t: DeviceTable, filename: string): void {
  const csv = toMostabCsv(t);
  const size = t.grid.shape.reduce((a, b) => a * b, 1);

  // Fail loud if our serialization ever drifts from what the importer accepts.
  const res = importMostab(new TextEncoder().encode(csv), { filename });
  if (!res.ok)
    throw new Error(`${filename} fixture failed to import: ` + JSON.stringify(res.errors));

  // test:e2e runs from web/, so process.cwd() is the web package root.
  writeFileSync(path.join(process.cwd(), `e2e/fixtures/${filename}`), csv);
  console.log(`[global-setup] wrote e2e/fixtures/${filename} (${size} rows)`);
}

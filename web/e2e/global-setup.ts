import { writeFileSync } from 'node:fs';
import path from 'node:path';
// The synthetic EKV oracle is an internal test fixture (not in the public barrel), so import it
// by deep path. importMostab comes from the public surface.
import { generateDemoDevice, scaleQuantities, signedMirrorDemo } from '../../src/demo/index';
import { importMostab, type DeviceTable } from '../../src/index';

// The app used to BOOT with `generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } })`.
// Now the app boots empty, so the e2e suite loads that exact device from a file instead. We
// regenerate it here (rather than commit a ~9k-row blob) so the fixture always tracks the oracle.
// Every demo-specific assertion (4 lengths, 19 vds values, gm/ID ceiling, etc.) is preserved
// because it is byte-for-byte the same data the app shipped.
export default function globalSetup(): void {
  const demo = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } });
  writeFixture(demo, 'demo.mostab.csv');
  // The same oracle recast as a signed-convention PMOS table (negative vgs/vds axes),
  // for the cross-polarity overlay test.
  writeFixture(signedMirrorDemo(demo), 'pmos-demo.mostab.csv');
  // A second characterization CONDITION of the same device: same headers apart from corner and
  // temperature, so it groups into one family, with the output conductance doubled — the
  // intrinsic gain therefore halves, which is what makes a per-condition verdict differ from
  // the nominal one instead of merely being labelled differently.
  writeFixture(cornerVariant(demo, 'ss', -40, { gds: 2 }), 'demo-ss.mostab.csv');
  // A SECOND table claiming the condition demo.mostab.csv already claims, with different data:
  // one device, one condition, two characterizations of it — the ambiguity nothing may project
  // from until the bench removes one.
  writeFixture(cornerVariant(demo, 'tt', 27, { gds: 1.5 }), 'demo-tt-alt.mostab.csv');
  // A device whose NAME begins with the discriminator a family binding uses. Its table uid then
  // begins with that word too, which is exactly the string a binding resolver that tested the
  // prefix first would swallow — so a document naming this table by uid must still resolve.
  writeFixture(
    { ...demo, id: { ...demo.id, device: 'family:demo' } },
    'legacy-family-name.mostab.csv',
  );
}

/** One corner of a device: the same table under another condition, with named quantity columns
 *  scaled by the fixture helper the core suite uses for the same purpose. */
function cornerVariant(
  t: DeviceTable,
  corner: string,
  temp: number,
  scale: Record<string, number>,
): DeviceTable {
  const scaled = scaleQuantities(t, scale);
  return { ...scaled, id: { ...scaled.id, corner, temp } };
}

function writeFixture(t: DeviceTable, filename: string): void {
  const { grid, id, meta } = t;
  const axisNames = grid.axes.map((a) => a.name); // ['l','vds','vgs']
  const dataNames = [...grid.quantities.keys()].filter((n) => !axisNames.includes(n));
  const names = [...axisNames, ...dataNames];
  // makeGrid materializes axis columns into `quantities`, so every column is a flat array of
  // length prod(shape) — no stride math needed, just read column[i] for each row i.
  const cols = names.map((n) => grid.quantities.get(n)!);
  const size = grid.shape.reduce((a, b) => a * b, 1);

  const lines = [
    '# mostab: 0.1',
    `# device: ${id.device}`,
    `# corner: ${id.corner}`,
    `# temp: ${id.temp}`,
  ];
  if (meta.W != null) lines.push(`# W: ${meta.W}`);
  if (meta.simulator) lines.push(`# simulator: ${meta.simulator}`);
  // Declared polarity is what the importer RECORDS (it never sniffs signs), so the
  // signed-PMOS fixture must carry it to exercise the recorded-polarity paths.
  if (meta.polarity) lines.push(`# polarity: ${meta.polarity.device}`);
  lines.push(names.map((n) => n.toUpperCase()).join(','));
  for (let i = 0; i < size; i++) {
    // String(double) is the shortest round-trippable form, so importMostab reads back exact values.
    lines.push(cols.map((c) => String(c[i])).join(','));
  }
  const csv = lines.join('\n') + '\n';

  // Fail loud if our serialization ever drifts from what the importer accepts.
  const res = importMostab(new TextEncoder().encode(csv), { filename });
  if (!res.ok)
    throw new Error(`${filename} fixture failed to import: ` + JSON.stringify(res.errors));

  // test:e2e runs from web/, so process.cwd() is the web package root.
  writeFileSync(path.join(process.cwd(), `e2e/fixtures/${filename}`), csv);
  console.log(`[global-setup] wrote e2e/fixtures/${filename} (${size} rows)`);
}

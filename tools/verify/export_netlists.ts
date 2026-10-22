// Evaluate every library sheet at its defaults on the sky130 tt 27 °C tables and write its sized
// netlist (src/sheet/spice.ts) as JSON, one file per sheet, for gen_decks.py to turn into ngspice
// decks. From the repository root:
//
//     npx vite-node tools/verify/export_netlists.ts [-- filter...]
//
// The tables are the ones tools/gen_gmid.py writes to data/pdk/sky130/. Every block whose sheet
// states polarity p is bound to the pfet table and every other block to the nfet table, and every
// param declared `"convention": "axis-sign"` is set to -1, because the pfet table is exported signed
// (its vgs and vds axes run negative). A sheet whose own device is p is evaluated on the pfet table.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importMostab } from '../../src/import';
import { buildSheetRefIndex, resolveSheetRefs, runSheet } from '../../src/sheet';
import { sizedNetlist } from '../../src/sheet/spice';
import type { DeviceTable } from '../../src/types';
import type { SheetDoc } from '../../src/sheet';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHEETS = join(ROOT, 'sheets');
const SKY = join(ROOT, 'data', 'pdk', 'sky130');
const OUT = join(ROOT, 'tools', 'verify', 'generated', 'netlists');
const CORNER = { corner: 'tt', temp: 27 };
const MODELS = { n: 'sky130_fd_pr__nfet_01v8', p: 'sky130_fd_pr__pfet_01v8' } as const;

const only = process.argv.slice(2).filter((a) => a !== '--');

const entries = readdirSync(SHEETS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((g) =>
    readdirSync(join(SHEETS, g.name))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({
        path: `${g.name}/${f.replace(/\.json$/, '')}`,
        doc: JSON.parse(readFileSync(join(SHEETS, g.name, f), 'utf8')) as SheetDoc,
      })),
  );
const REFS = buildSheetRefIndex(entries);

function load(model: string): DeviceTable {
  const file = join(SKY, `${model}__${CORNER.corner}__${CORNER.temp}C.mostab.csv`);
  const r = importMostab(readFileSync(file, 'utf8'));
  if (!r.ok) throw new Error(`${file} did not import`);
  return r.dataset.tables[0];
}
const tables = { n: load(MODELS.n), p: load(MODELS.p) };

/** Every block bound to the table of its own sheet's polarity, and every axis-sign selector set to
 *  the pfet table's axis direction. The resolved tree carries every child embedded. */
function bind(doc: SheetDoc, inherited: 'n' | 'p'): SheetDoc {
  return {
    ...doc,
    params: doc.params.map((q) => (q.convention === 'axis-sign' ? { ...q, value: -1 } : q)),
    ...(doc.blocks
      ? {
          blocks: doc.blocks.map((b) => {
            if (!b.doc) return b;
            const pol = b.doc.polarity === 'p' ? 'p' : 'n';
            return {
              ...b,
              ...(pol !== inherited ? { device: pol } : {}),
              doc: bind(b.doc, pol),
            };
          }),
        }
      : {}),
  };
}

mkdirSync(OUT, { recursive: true });
let written = 0;
for (const { path, doc } of entries) {
  if (only.length && !only.some((o) => path.includes(o))) continue;
  const top = doc.polarity === 'p' ? 'p' : 'n';
  const resolved = resolveSheetRefs(doc, REFS);
  const bound = bind(resolved.doc, top);
  const res = runSheet(bound, tables[top], (id) =>
    id === 'p' || id === 'n' ? tables[id] : undefined,
  );
  const net = sizedNetlist(bound, res);
  const out = {
    sheet: path,
    condition: `sky130 ${CORNER.corner} ${CORNER.temp} C`,
    // The model each device is sized on: a device's `device` id, else the top sheet's table.
    models: { top: MODELS[top], n: MODELS.n, p: MODELS.p },
    ...net,
  };
  const file = join(OUT, `${path.replace('/', '__')}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  written++;
  console.log(
    `${path.padEnd(44)} ${net.circuit ? 'circuit' : 'not a circuit'}  feasible=${net.feasible}  ` +
      `devices=${net.devices.length}  wiring=${net.wiring?.state ?? '-'}  errors=${net.errors.length}`,
  );
}
console.log(`${written} sized netlists in ${relative(ROOT, OUT)}`);

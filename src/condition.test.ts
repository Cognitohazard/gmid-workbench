// A condition as a record of named dimensions: the identity every grouping, projection, label
// and stored selection shares, and how the importer resolves it from hints, headers and fills.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { importMostab } from './import';
import { validate } from './qa';
import { generateDemoDevice, toMostabCsv } from './demo';
import {
  conditionKeyId,
  conditionKeyOf,
  conditionLabel,
  conditionOf,
  groupDevices,
  sameCondition,
  tableAt,
  tableTempC,
} from './index';
import type { ConditionDimension, DeviceTable, ImportHints } from './types';

const ROWS = `L,VGS,ID,GM
30e-9,0.3,1.0e-6,1.0e-5
30e-9,0.5,2.0e-6,2.0e-5
60e-9,0.3,4.0e-6,4.0e-5
60e-9,0.5,5.0e-6,5.0e-5
`;

/** A small mostab file with the given `# key: value` header lines. */
const file = (headers: Record<string, string | number>): string =>
  Object.entries(headers)
    .map(([k, v]) => `# ${k}: ${v}\n`)
    .join('') + ROWS;

function importOk(text: string, hints?: ImportHints): { table: DeviceTable; warnings: string[] } {
  const r = importMostab(text, hints);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  expect(r.dataset.tables).toHaveLength(1);
  return {
    table: r.dataset.tables[0],
    warnings: r.dataset.warnings.map((w) => `${w.rule}: ${w.message}`),
  };
}

const VDD: ConditionDimension = { name: 'vdd', kind: 'number', unit: 'V' };
const CORNER_ONLY: ConditionDimension[] = [{ name: 'corner', kind: 'text', fill: 'tt' }];
const CORNER_TEMP_VDD: ConditionDimension[] = [
  { name: 'corner', kind: 'text', fill: 'tt' },
  { name: 'temp', kind: 'number', unit: '°C', fill: 27 },
  VDD,
];

describe('a table stored before conditions were records', () => {
  const demo = generateDemoDevice();
  const legacy: DeviceTable = { ...demo, id: { device: 'nch', corner: 'TT', temp: 27 } };
  const current: DeviceTable = {
    ...demo,
    id: { device: 'nch', condition: { corner: 'TT', temp: 27 } },
  };

  it('reads as the same condition, key, label and nominal as one imported now', () => {
    expect(conditionOf(legacy.id)).toEqual(conditionOf(current.id));
    expect(conditionKeyOf(legacy.id)).toEqual({ corner: 'tt', temp: 27 });
    expect(conditionKeyId(conditionKeyOf(legacy.id))).toBe(
      conditionKeyId(conditionKeyOf(current.id)),
    );
    expect(conditionLabel(legacy)).toBe(conditionLabel(current));
    const [a] = groupDevices([legacy, { ...demo, id: { device: 'nch', corner: 'ss', temp: 27 } }]);
    expect(a.nominal).toBe(legacy);
  });

  it('is still selected by a stored key', () => {
    const [d] = groupDevices([legacy]);
    expect(tableAt(d, conditionKeyOf({ corner: 'tt', temp: 27 }))).toBe(legacy);
    expect(tableAt(d, { corner: 'tt', temp: 85 })).toBeUndefined();
  });
});

describe('importing without naming dimensions', () => {
  const fixture = (path: string): string =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('gives every existing fixture the corner-and-temperature condition and the same fills', () => {
    for (const [path, condition, filled] of [
      ['../web/e2e/fixtures/sample.mostab.csv', { corner: 'tt', temp: 27 }, undefined],
      ['../web/e2e/fixtures/sample-fab.mostab.csv', { corner: 'tt', temp: 27 }, undefined],
      ['../web/e2e/fixtures/single-l.mostab.csv', { corner: 'tt', temp: 27 }, undefined],
      [
        '../tools/__fixtures__/medwatt_demo.mostab.csv',
        { corner: 'tt', temp: 27 },
        ['corner', 'temp'],
      ],
    ] as const) {
      const { table } = importOk(fixture(path), { filename: path.split('/').pop() });
      expect(table.id).toEqual({ device: table.id.device, condition });
      expect(table.meta.filled).toEqual(filled);
    }
  });

  it('keeps a round-tripped demo table at its own condition', () => {
    const { table } = importOk(toMostabCsv(generateDemoDevice()));
    expect(conditionOf(table.id)).toEqual({ corner: 'tt', temp: 27 });
    expect(table.meta.filled).toBeUndefined();
  });
});

describe('the canonical key', () => {
  it('makes TT and tt, and -0 and 0, one condition', () => {
    const a = importOk(file({ device: 'n', corner: 'TT', temp: '-0' })).table;
    const b = importOk(file({ device: 'n', corner: 'tt', temp: 0 })).table;
    expect(sameCondition(conditionKeyOf(a.id), conditionKeyOf(b.id))).toBe(true);
    expect(conditionKeyId(conditionKeyOf(a.id))).toBe(conditionKeyId(conditionKeyOf(b.id)));
    // The table keeps its file's spelling for display.
    expect(conditionOf(a.id).corner).toBe('TT');
    expect(groupDevices([a, b])[0].duplicates).toHaveLength(1);
  });

  it('makes Vdd and vdd one dimension', () => {
    expect(conditionKeyOf({ Vdd: 1.8 })).toEqual({ vdd: 1.8 });
    expect(sameCondition(conditionKeyOf({ Vdd: 1.8 }), conditionKeyOf({ vdd: 1.8 }))).toBe(true);
    const { table } = importOk(file({ device: 'n', VDD: 1.8 }), {
      dimensions: [{ name: 'Vdd', kind: 'number' }],
    });
    expect(conditionOf(table.id)).toEqual({ vdd: 1.8 });
  });

  it('keeps a text value apart from a number with the same digits', () => {
    expect(sameCondition({ vdd: '1.8' }, { vdd: 1.8 })).toBe(false);
    expect(conditionKeyId({ vdd: '1.8' })).not.toBe(conditionKeyId({ vdd: 1.8 }));
    expect(sameCondition({ corner: 'tt' }, { corner: 'tt', vdd: 1.8 })).toBe(false);
  });
});

describe('a dimension the designer adds', () => {
  it('reads its value from the header of the same name', () => {
    const { table, warnings } = importOk(file({ device: 'n', corner: 'tt', temp: 27, vdd: 1.62 }), {
      dimensions: CORNER_TEMP_VDD,
    });
    expect(conditionOf(table.id)).toEqual({ corner: 'tt', temp: 27, vdd: 1.62 });
    expect(table.meta.extra?.vdd).toBe('1.62');
    expect(table.meta.filled ?? []).not.toContain('vdd');
    expect(warnings.filter((w) => w.startsWith('no-condition-value'))).toEqual([]);
  });

  it('is left out, with a warning naming the file and the dimension, when nothing gives it', () => {
    const { table, warnings } = importOk(file({ device: 'n', corner: 'tt', temp: 27 }), {
      filename: 'n_tt.csv',
      dimensions: CORNER_TEMP_VDD,
    });
    expect(conditionOf(table.id)).toEqual({ corner: 'tt', temp: 27 });
    const missing = warnings.filter((w) => w.startsWith('condition-left-out'));
    expect(missing).toHaveLength(1);
    expect(table.meta.unset).toEqual(['vdd']);
    // A table restored from storage is validated again and still says so.
    expect(validate(table).filter((w) => w.rule === 'condition-left-out')).toHaveLength(1);
    expect(missing[0]).toContain('n_tt.csv');
    expect(missing[0]).toContain('vdd');
    const [d] = groupDevices([table]);
    expect(tableAt(d, { corner: 'tt', temp: 27, vdd: 1.8 })).toBeUndefined();
    expect(tableAt(d, { corner: 'tt', temp: 27 })).toBe(table);
  });

  it('takes its fill, recorded as filled, when the file does not declare it', () => {
    const { table, warnings } = importOk(file({ device: 'n', corner: 'tt', temp: 27 }), {
      dimensions: [...CORNER_TEMP_VDD.slice(0, 2), { ...VDD, fill: 1.8 }],
    });
    expect(conditionOf(table.id)).toEqual({ corner: 'tt', temp: 27, vdd: 1.8 });
    expect(table.meta.filled).toEqual(['vdd']);
    expect(warnings.filter((w) => w.startsWith('no-condition-value'))).toHaveLength(1);
    expect(conditionLabel(table)).toContain('vdd');
  });

  it('refuses a dimension named device, an empty name, or one named twice', () => {
    for (const dimensions of [
      [{ name: 'Device', kind: 'text' }],
      [{ name: ' ', kind: 'text' }],
      [VDD, { name: 'VDD', kind: 'number' }],
      [{ name: 'temp', kind: 'text' }],
      [{ name: 'Temp', kind: 'number', fill: 25 }],
    ] as ConditionDimension[][]) {
      const r = importMostab(file({ device: 'n' }), { dimensions });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.kind)).toEqual(['bad-dimension']);
    }
  });
});

describe('a value the import cannot read', () => {
  const refused = (text: string, hints: ImportHints): string[] => {
    const r = importMostab(text, hints);
    expect(r.ok).toBe(false);
    return r.ok ? [] : r.errors.map((e) => `${e.kind}: ${e.message}`);
  };

  it('refuses a hint for a dimension the import does not declare', () => {
    const [e] = refused(file({ device: 'n' }), { condition: { vdd: 1.8 } });
    expect(e).toMatch(/^bad-dimension: .*vdd/);
  });

  it('refuses a hint whose value the dimension cannot read', () => {
    const [e] = refused(file({ device: 'n' }), {
      dimensions: CORNER_TEMP_VDD,
      condition: { vdd: 'high' },
    });
    expect(e).toMatch(/^bad-dimension: .*vdd.*high/);
  });

  it('refuses a header whose value the dimension cannot read, naming the header', () => {
    const [e] = refused(file({ device: 'n', vdd: '1.8V' }), { dimensions: CORNER_TEMP_VDD });
    expect(e).toMatch(/^bad-dimension: .*# vdd: 1\.8V/);
  });
});

describe('the temperature the engine reads a table at', () => {
  it('is the hinted temperature when the file declares none', () => {
    const { table, warnings } = importOk(file({ device: 'n', corner: 'tt' }), {
      condition: { temp: 125 },
    });
    expect(table.meta.temp).toBe(125);
    expect(conditionOf(table.id)).toEqual({ corner: 'tt', temp: 125 });
    expect(table.meta.filled ?? []).not.toContain('temp');
    expect(tableTempC(table)).toBe(125);
    expect(warnings.some((w) => w.startsWith('no-temp'))).toBe(false);
  });

  it('is each table its own when temperature is not a dimension', () => {
    const cold = importOk(file({ device: 'n', corner: 'tt', temp: 27 }), {
      dimensions: CORNER_ONLY,
    }).table;
    const hot = importOk(file({ device: 'n', corner: 'tt', temp: 125 }), {
      dimensions: CORNER_ONLY,
    }).table;
    expect(conditionOf(cold.id)).toEqual({ corner: 'tt' });
    expect(conditionOf(hot.id)).toEqual({ corner: 'tt' });
    const [d] = groupDevices([cold, hot], { dimensions: CORNER_ONLY });
    expect(d.duplicates).toEqual([{ corner: 'tt' }]);
    expect(tableAt(d, { corner: 'tt' })).toBeUndefined();
    expect(tableTempC(cold)).toBe(27);
    expect(tableTempC(hot)).toBe(125);
  });

  it('is 27 °C, said to be assumed, when nothing declares one', () => {
    const { table } = importOk(file({ device: 'n', corner: 'tt' }), { dimensions: CORNER_ONLY });
    expect(conditionOf(table.id)).toEqual({ corner: 'tt' });
    expect(tableTempC(table)).toBe(27);
    expect(table.meta.filled).toEqual(['temp']);
    expect(validate(table).some((w) => w.rule === 'no-temp')).toBe(true);
  });
});

describe('a script importing files at named conditions', () => {
  it('groups them under the keys it declared', () => {
    const csv = toMostabCsv(generateDemoDevice());
    const dimensions = CORNER_TEMP_VDD;
    const tables = [1.62, 1.8, 1.98].map((vdd) => {
      const r = importMostab(csv, { dimensions, condition: { corner: 'ff', vdd } });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      return r.dataset.tables[0];
    });
    const [d] = groupDevices(tables, { dimensions });
    expect(d.keys).toEqual([
      { corner: 'ff', temp: 27, vdd: 1.62 },
      { corner: 'ff', temp: 27, vdd: 1.8 },
      { corner: 'ff', temp: 27, vdd: 1.98 },
    ]);
    expect(d.duplicates).toEqual([]);
    expect(tableAt(d, { corner: 'ff', temp: 27, vdd: 1.8 })).toBe(tables[1]);
  });
});

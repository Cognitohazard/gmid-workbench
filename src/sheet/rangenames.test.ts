// How a range end is put into words: the quantity and value its `set` fixes, and which end of the
// claimed range it is — never the end's bare name alone.

import { describe, expect, it } from 'vitest';
import { REFS, sheet, table } from './library.fixtures';
import { namingRangeEnds, rangeEndNames, runSheet, type SheetDoc } from './index';

const doc = (ends: SheetDoc['operatingRange']): SheetDoc => ({
  title: 't',
  polarity: 'n',
  params: [
    { name: 'CM_dc', value: 1.2, unit: 'V' },
    { name: 'CM_lo', value: 0.9, unit: 'V' },
    { name: 'CM_hi', value: 1.5, unit: 'V' },
    { name: 'V_n', value: 0.3, unit: 'V', solveFor: 'CM_dc', min: 0, max: 1 },
  ],
  equations: [],
  checks: [],
  operatingRange: ends,
});

describe('rangeEndNames', () => {
  it('names each end by the value it fixes and which end of the range it is', () => {
    const names = rangeEndNames(
      doc([
        { name: 'cm-lo', set: { CM_dc: 'CM_lo' } },
        { name: 'cm-hi', set: { CM_dc: 'CM_hi' } },
      ]),
    );
    expect([...names]).toEqual([
      ['cm-lo', 'CM_dc = 900 mV, the low end of the claimed CM_dc range'],
      ['cm-hi', 'CM_dc = 1.5 V, the high end of the claimed CM_dc range'],
    ]);
  });

  it('reads the value the run resolved ahead of the one the document states', () => {
    const d = doc([
      { name: 'cm-lo', set: { CM_dc: 'CM_lo + 0.05' } },
      { name: 'cm-hi', set: { CM_dc: 'CM_hi' } },
    ]);
    // Unresolved, an expression that is not a param or a number is quoted, and with one value
    // unknown no end can be placed.
    expect(rangeEndNames(d).get('cm-lo')).toBe('CM_dc = CM_lo + 0.05, range end cm-lo');
    expect(rangeEndNames(d).get('cm-hi')).toBe('CM_dc = 1.5 V, range end cm-hi');
    const resolved = rangeEndNames(d, [{ name: 'cm-lo', set: { CM_dc: 0.95 } }]);
    expect(resolved.get('cm-lo')).toBe('CM_dc = 950 mV, the low end of the claimed CM_dc range');
  });

  it('places no end it cannot tell apart, and never reads a solved param’s stored value', () => {
    expect(rangeEndNames(doc([{ name: 'only', set: { CM_dc: 'CM_lo' } }])).get('only')).toBe(
      'CM_dc = 900 mV, range end only',
    );
    const tied = rangeEndNames(
      doc([
        { name: 'a', set: { CM_dc: '0.9' } },
        { name: 'b', set: { CM_dc: 'CM_lo' } },
      ]),
    );
    expect(tied.get('a')).toBe('CM_dc = 900 mV, range end a');
    expect(rangeEndNames(doc([{ name: 's', set: { CM_dc: 'V_n' } }])).get('s')).toBe(
      'CM_dc = V_n, range end s',
    );
  });

  it('names every quantity an end fixes, placed by the first', () => {
    const names = rangeEndNames(
      doc([
        { name: 'lo', set: { CM_dc: 'CM_lo', CM_hi: '1.4' } },
        { name: 'hi', set: { CM_dc: 'CM_hi' } },
      ]),
    );
    expect(names.get('lo')).toBe(
      'CM_dc = 900 mV, CM_hi = 1.4 V, the low end of the claimed CM_dc range',
    );
  });

  it('names a library sheet’s ends from its run, and says where an end a message quotes is', () => {
    const five = sheet('otas/five-transistor-ota.json');
    const res = runSheet(five, table, undefined, REFS);
    const names = rangeEndNames(five, res.rangeEnds);
    expect(names.get('cm-lo')).toMatch(/^CM_dc = .+ V, the low end of the claimed CM_dc range$/);
    expect(names.get('cm-hi')).toMatch(/^CM_dc = .+ V, the high end of the claimed CM_dc range$/);
    expect(namingRangeEnds('range end "cm-hi" moves it; range end "other" too', names)).toBe(
      `range end "cm-hi" (${names.get('cm-hi')}) moves it; range end "other" too`,
    );
  });
});

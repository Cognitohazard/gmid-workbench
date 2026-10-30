// Setting a child's param by its path, for a script that sweeps it.

import { describe, it, expect } from 'vitest';
import { withOverrides } from './overrides';
import { buildSheetRefIndex } from './resolve';
import { runSheet } from './index';
import { notACircuit, table } from './library.fixtures';
import type { SheetDoc } from './types';

const leg: SheetDoc = {
  title: 'leg',
  polarity: 'n',
  params: [
    { name: 'L', value: 1e-6 },
    { name: 'I', value: 1e-6 },
    { name: 'V_s', value: 0.5, min: 0, max: 1, designConstraint: { lhs: 'V_s', rhs: '0.5' } },
  ],
  givens: { L: 'L', id: 'I', gm_id: '10', vds: '0.6' },
  equations: [],
  checks: [],
  provides: ['W'],
};

const bias: SheetDoc = {
  title: 'bias',
  polarity: 'n',
  params: [{ name: 'L_MB5', value: 2e-6 }],
  blocks: [{ name: 'MB5', doc: leg, params: { L: 'L_MB5' } }],
  equations: [],
  checks: [],
  provides: ['MB5__W'],
};

const top: SheetDoc = notACircuit({
  title: 'top',
  polarity: 'n',
  params: [{ name: 'I_b', value: 1e-6 }],
  blocks: [{ name: 'bias', ref: 'blocks/bias' }],
  equations: [],
  checks: [],
});

const refs = buildSheetRefIndex([{ path: 'blocks/bias', doc: notACircuit(bias) }]);

describe('setting a param by its path', () => {
  it('sets a child param through the block that composes it, leaving the child as it was', () => {
    const at = (L: number) =>
      runSheet(withOverrides(top, { 'bias.L_MB5': L }, refs), table, undefined, refs);
    const short = at(0.5e-6);
    const long = at(1.5e-6);
    expect(short.blocks?.[0].blocks?.[0].sizing?.L).toBe(0.5e-6);
    expect(long.blocks?.[0].blocks?.[0].sizing?.L).toBe(1.5e-6);
    // The by-reference child is untouched: its block carries the override.
    const set = withOverrides(top, { 'bias.L_MB5': 0.5e-6 }, refs);
    expect(set.blocks?.[0]).toEqual({
      name: 'bias',
      ref: 'blocks/bias',
      params: { L_MB5: '5e-7' },
    });
    expect(top.blocks?.[0].params).toBeUndefined();
  });

  it('reaches below a child by reference by embedding it, and sets this sheet’s own params', () => {
    const set = withOverrides(top, { 'bias.MB5.I': 3e-6, I_b: 2e-6 }, refs);
    expect(set.params[0].value).toBe(2e-6);
    expect(set.blocks?.[0].ref).toBe('blocks/bias');
    expect(set.blocks?.[0].doc?.blocks?.[0].params).toEqual({ L: 'L_MB5', I: '0.000003' });
    const res = runSheet(set, table, undefined, refs);
    expect(res.blocks?.[0].blocks?.[0].sizing?.id).toBeCloseTo(3e-6, 15);
  });

  it('refuses a path that names nothing, or a param the engine solves', () => {
    expect(() => withOverrides(top, { 'bias.nope': 1 }, refs)).toThrow(
      /"bias.nope": block "bias" has no param "nope"/,
    );
    expect(() => withOverrides(top, { 'amp.L': 1 }, refs)).toThrow(/no block "amp"/);
    expect(() => withOverrides(top, { 'bias.MB5.V_s': 1 }, refs)).toThrow(/solved by the engine/);
    expect(() => withOverrides(top, { 'bias.MB5.I': 1 })).toThrow(/no refs were given/);
  });
});

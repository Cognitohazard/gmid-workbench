import { describe, it, expect } from 'vitest';
import { parseEng, formatEng, formatSI } from './index';

describe('parseEng', () => {
  it('parses the spec examples', () => {
    expect(parseEng('100n')).toBeCloseTo(1e-7, 18);
    expect(parseEng('0.1u')).toBeCloseTo(1e-7, 18);
    expect(parseEng('10MEG')).toBe(1e7);
    expect(parseEng('1.8')).toBe(1.8);
    expect(parseEng('1e-7')).toBe(1e-7);
    expect(parseEng('2.5m')).toBeCloseTo(2.5e-3, 18);
  });

  it('honors the SPICE m=milli / meg=mega convention case-insensitively', () => {
    expect(parseEng('1m')).toBe(1e-3);
    expect(parseEng('1M')).toBe(1e-3); // single char, either case, is MILLI
    expect(parseEng('1meg')).toBe(1e6);
    expect(parseEng('1Meg')).toBe(1e6);
    expect(parseEng('1MEG')).toBe(1e6);
    expect(parseEng('1mEg')).toBe(1e6);
  });

  it('parses every SI/SPICE suffix', () => {
    expect(parseEng('1f')).toBe(1e-15);
    expect(parseEng('1p')).toBe(1e-12);
    expect(parseEng('1n')).toBe(1e-9);
    expect(parseEng('1u')).toBe(1e-6);
    expect(parseEng('1k')).toBe(1e3);
    expect(parseEng('1g')).toBe(1e9);
    expect(parseEng('1G')).toBe(1e9);
    expect(parseEng('1t')).toBe(1e12);
    expect(parseEng('1T')).toBe(1e12);
  });

  it('parses plain and scientific notation without suffix', () => {
    expect(parseEng('2.5E3')).toBe(2500);
    expect(parseEng('-3')).toBe(-3);
    expect(parseEng('.5')).toBe(0.5);
    expect(parseEng('+1.25e2')).toBe(125);
    expect(parseEng('  42  ')).toBe(42);
  });

  it('handles signed values with suffixes', () => {
    expect(parseEng('-100n')).toBeCloseTo(-1e-7, 18);
    expect(parseEng('-2.5meg')).toBe(-2.5e6);
  });

  it('throws TypeError on invalid input', () => {
    expect(() => parseEng('')).toThrow(TypeError);
    expect(() => parseEng('   ')).toThrow(TypeError);
    expect(() => parseEng('abc')).toThrow(TypeError);
    expect(() => parseEng('1x')).toThrow(TypeError); // unknown suffix
    expect(() => parseEng('1.2.3')).toThrow(TypeError); // trailing junk is not a suffix
    expect(() => parseEng('nn')).toThrow(TypeError);
    // @ts-expect-error non-string input
    expect(() => parseEng(5)).toThrow(TypeError);
  });
});

describe('formatEng', () => {
  it('renders 0 as "0"', () => {
    expect(formatEng(0)).toBe('0');
  });

  it('uses engineering suffixes (round-trippable, SPICE meg for mega)', () => {
    expect(formatEng(1e-7)).toBe('100n');
    expect(formatEng(1e-6)).toBe('1u');
    expect(formatEng(1e-3)).toBe('1m');
    expect(formatEng(1)).toBe('1');
    expect(formatEng(1e3)).toBe('1k');
    expect(formatEng(1e6)).toBe('1meg');
    expect(formatEng(1e9)).toBe('1g');
    expect(formatEng(2500)).toBe('2.5k');
    expect(formatEng(-1e-7)).toBe('-100n');
  });

  it('drops trailing zeros and honors sig figs', () => {
    expect(formatEng(1.23456e-6, 3)).toBe('1.23u');
    expect(formatEng(1.5e-6, 4)).toBe('1.5u');
    expect(formatEng(1000)).toBe('1k');
  });

  it('handles boundary rounding spill', () => {
    // 999.95 µ at 4 sig-figs rounds to 1000µ -> should promote to 1m
    expect(formatEng(999.95e-6, 4)).toBe('1m');
  });

  it('round-trips formatEng -> parseEng', () => {
    for (const x of [1e-7, 1e-6, 2.5e-3, 1.8, 100, 4700, 3.3e6, 1.602e-19]) {
      const back = parseEng(formatEng(x));
      const relErr = Math.abs(back - x) / Math.abs(x);
      expect(relErr).toBeLessThan(1e-6);
    }
  });

  it('round-trips the spec 1e-7 case to ~1e-7', () => {
    const s = formatEng(1e-7);
    expect(parseEng(s)).toBeCloseTo(1e-7, 18);
  });

  it('falls back to scientific notation outside the suffix ladder', () => {
    const huge = formatEng(1e40);
    // Beyond Q (1e30) there is no suffix, so a scientific tail must appear.
    expect(huge).toMatch(/e/);
    const back = Number(huge); // plain JS scientific notation parses directly
    expect(Math.abs(back - 1e40) / 1e40).toBeLessThan(1e-6);
  });
});

describe('formatSI', () => {
  it('uses standard SI prefixes (capital ≥1e3, µ for micro)', () => {
    expect(formatSI(1e9)).toBe('1G');
    expect(formatSI(1e6)).toBe('1M');
    expect(formatSI(1e3)).toBe('1k');
    expect(formatSI(200e9, 3)).toBe('200G');
    expect(formatSI(1.5e-6)).toBe('1.5µ');
    expect(formatSI(1e-3)).toBe('1m');
    expect(formatSI(0)).toBe('0');
    expect(formatSI(-2.5e9)).toBe('-2.5G');
  });
});

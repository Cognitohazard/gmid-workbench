// Engineering-notation parse/format. Pure, deterministic, zero DOM imports.
//
// SPICE/SI suffix convention (case-insensitive):
//   f=1e-15 p=1e-12 n=1e-9 u=1e-6 m=1e-3 k=1e3 meg=1e6 g=1e9 t=1e12
// Note the SPICE quirk: 'm' is MILLI and 'meg' is MEGA. Suffixes bind directly
// to the number with no intervening space.

/** Suffix -> multiplier. Keys are lower-cased; lookup is case-insensitive. */
const SUFFIX_FACTORS: Readonly<Record<string, number>> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  meg: 1e6, // checked before single-char 'm'/'g' so "meg" wins
  k: 1e3,
  g: 1e9,
  t: 1e12,
};

// Number body: optional sign, digits with optional fraction (or bare fraction),
// optional scientific exponent. Examples: 1.8, .5, 1e-7, 2.5E3, -3.
const NUMBER_BODY = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Parse engineering notation into a plain number.
 *
 * Accepts plain decimals, scientific notation, and an optional trailing SI/SPICE
 * suffix bound to the number with no space (e.g. "100n", "0.1u", "10MEG").
 *
 * @throws {TypeError} on empty, malformed, or unrecognized-suffix input.
 */
export function parseEng(s: string): number {
  if (typeof s !== 'string') {
    throw new TypeError(`parseEng: expected string, got ${typeof s}`);
  }
  const trimmed = s.trim();
  if (trimmed === '') {
    throw new TypeError('parseEng: empty input');
  }

  const m = NUMBER_BODY.exec(trimmed);
  if (m === null) {
    throw new TypeError(`parseEng: invalid number in "${s}"`);
  }

  const numStr = m[0];
  const mantissa = Number(numStr);
  if (!Number.isFinite(mantissa)) {
    throw new TypeError(`parseEng: invalid number in "${s}"`);
  }

  const rest = trimmed.slice(numStr.length).trim();
  if (rest === '') {
    return mantissa;
  }

  // "meg" is three chars and must win over the single 'm' / 'g'; the table
  // lookup keys are unique so a direct lower-cased lookup of the whole suffix
  // resolves the ambiguity correctly.
  const factor = SUFFIX_FACTORS[rest.toLowerCase()];
  if (factor === undefined) {
    throw new TypeError(`parseEng: unrecognized suffix "${rest}" in "${s}"`);
  }
  return mantissa * factor;
}

// Engineering-suffix ladder for formatting. Index 0 is the lowest group; entries
// step by 1e3, '' is the unity group. The ladder deliberately mirrors the
// `parseEng` suffix set EXACTLY (and uses SPICE 'meg' for mega rather than SI
// 'M') so that every formatEng output round-trips through parseEng. Magnitudes
// outside [1e-15, 1e12) fall back to scientific notation.
const ENG_SUFFIXES: readonly string[] = [
  'f', // 1e-15
  'p', // 1e-12
  'n', // 1e-9
  'u', // 1e-6
  'm', // 1e-3
  '', // 1e0
  'k', // 1e3
  'meg', // 1e6
  'g', // 1e9
  't', // 1e12
];
const ZERO_INDEX = 5; // position of '' (1e0) in ENG_SUFFIXES

/**
 * Format a number using engineering notation with a metric suffix.
 *
 * Picks the suffix so the mantissa lands in [1, 1000), renders `sig`
 * significant figures, strips trailing zeros, and emits "0" for zero.
 *
 * @param x   the value to format
 * @param sig significant figures (default 4)
 */
export function formatEng(x: number, sig = 4): string {
  if (!Number.isFinite(x)) {
    // NaN / ±Infinity have no engineering suffix; render the JS string.
    return String(x);
  }
  if (x === 0) {
    return '0';
  }

  const safeSig = Math.max(1, Math.floor(sig));
  const sign = x < 0 ? '-' : '';
  const abs = Math.abs(x);

  // Engineering exponent: multiple of 3 with mantissa in [1, 1000).
  let exp3 = Math.floor(Math.log10(abs) / 3) * 3;
  let mantissa = abs / 10 ** exp3;

  // Round the mantissa to `safeSig` sig-figs, then correct any boundary spill
  // (e.g. 999.95 -> 1000) by bumping to the next engineering group.
  mantissa = roundSig(mantissa, safeSig);
  if (mantissa >= 1000) {
    mantissa /= 1000;
    exp3 += 3;
    mantissa = roundSig(mantissa, safeSig);
  }

  const idx = ZERO_INDEX + exp3 / 3;
  if (idx >= 0 && idx < ENG_SUFFIXES.length) {
    return sign + trimZeros(mantissa, safeSig) + ENG_SUFFIXES[idx];
  }

  // Out of suffix range: fall back to scientific notation with the same sig-figs.
  return sign + trimZeros(abs / 10 ** exp3, safeSig) + 'e' + (exp3 >= 0 ? '+' : '') + exp3;
}

/** Round a positive value to `sig` significant figures. */
function roundSig(v: number, sig: number): number {
  if (v === 0) return 0;
  const d = Math.ceil(Math.log10(v));
  const power = sig - d;
  const factor = 10 ** power;
  return Math.round(v * factor) / factor;
}

/**
 * Render a value to at most `sig` significant figures with no trailing zeros and
 * no trailing decimal point.
 */
function trimZeros(v: number, sig: number): string {
  // toPrecision gives correct sig-figs; parseFloat + String drops trailing
  // zeros and avoids exponential for the small magnitudes we produce here.
  const p = v.toPrecision(sig);
  const n = Number(p);
  return String(n);
}

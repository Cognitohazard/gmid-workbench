import { BASE_QUANTITIES, PROVIDE_SEP } from '@gmid/mostab-core';

// Pretty quantity labels with subscripts, for DISPLAY only (axis labels, table headers)
// — rendered via Svelte's {@html}. Editor inputs keep the raw keys (you can't type a
// subscript). Any expression not in the map falls back to ESCAPED plain text, so {@html}
// is always safe even for arbitrary user-typed expressions.
const SUBSCRIPTED: Readonly<Record<string, string>> = {
  // derived design quantities
  gm_id: 'g<sub>m</sub>/I<sub>D</sub>',
  id_w: 'I<sub>D</sub>/W',
  ft: 'f<sub>T</sub>',
  gm_gds: 'g<sub>m</sub>/g<sub>ds</sub>',
  av0: 'A<sub>v0</sub>',
  ro: 'r<sub>o</sub>',
  vstar: 'V*',
  ft_eff: '(g<sub>m</sub>/I<sub>D</sub>)·f<sub>T</sub>',
  av0_ft: 'A<sub>v0</sub>·f<sub>T</sub>',
  gm_cgd: 'g<sub>m</sub>/C<sub>gd</sub>',
  cgd_cgg: 'C<sub>gd</sub>/C<sub>gg</sub>',
  gmb_gm: 'g<sub>mb</sub>/g<sub>m</sub>',
  // noise (measured + γ-model)
  vnth: 'v<sub>n,th</sub>',
  vnth_m: 'v<sub>n,th</sub>',
  vnfl: 'v<sub>n,fl</sub>',
  svth: 'S<sub>v,th</sub>',
  svth_m: 'S<sub>v,th</sub>',
  svfl: 'S<sub>v,fl</sub>',
  // base quantities
  vgs: 'V<sub>GS</sub>',
  vds: 'V<sub>DS</sub>',
  vsb: 'V<sub>SB</sub>',
  vth: 'V<sub>TH</sub>',
  vdsat: 'V<sub>dsat</sub>',
  id: 'I<sub>D</sub>',
  gm: 'g<sub>m</sub>',
  gds: 'g<sub>ds</sub>',
  gmb: 'g<sub>mb</sub>',
  cgg: 'C<sub>gg</sub>',
  cgs: 'C<sub>gs</sub>',
  cgd: 'C<sub>gd</sub>',
  cgb: 'C<sub>gb</sub>',
  cdb: 'C<sub>db</sub>',
  csb: 'C<sub>sb</sub>',
  sth: 'S<sub>th</sub>',
  sfl: 'S<sub>fl</sub>',
  l: 'L',
  w: 'W',
  gamma: 'γ',
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// Fold a qualifier into an already-rendered label's subscript — `g<sub>m</sub>` + "in" →
// `g<sub>m,in</sub>` — or add a subscript when the label has none (`V*` → `V*<sub>in</sub>`).
function withQualifier(html: string, qual: string): string {
  if (!qual) return html;
  const q = escapeHtml(qual);
  const i = html.lastIndexOf('</sub>');
  return i >= 0 ? `${html.slice(0, i)},${q}${html.slice(i)}` : `${html}<sub>${q}</sub>`;
}

/**
 * Safe HTML label for an identifier: the exact SUBSCRIPTED form when known, else a best-effort
 * typeset of an authored name — `child__key` renders the quantity with the block as a subscript
 * qualifier (`in__gm` → g_{m,in}), and a trailing `_suffix` becomes a subscript (`Av_target` →
 * Av_target, `V_x` → V_x). Splitting at the LAST underscore keeps a known compound head intact
 * (`gm_id_casc` keeps g_m/I_D). Always escaped, so {@html} stays safe for arbitrary names.
 */
export function qLabel(expr: string): string {
  const known = SUBSCRIPTED[expr];
  if (known) return known;
  const sep = expr.indexOf(PROVIDE_SEP);
  if (sep >= 0) {
    return withQualifier(qLabel(expr.slice(sep + PROVIDE_SEP.length)), expr.slice(0, sep));
  }
  const us = expr.lastIndexOf('_');
  if (us > 0 && us < expr.length - 1) {
    return withQualifier(qLabel(expr.slice(0, us)), expr.slice(us + 1));
  }
  return escapeHtml(expr);
}

/**
 * Render a formula string with subscripted identifiers and prettified operators (e.g.
 * `gm/(2*pi*cgg)` → `g_m/(2·π·C_gg)`), for showing a derived quantity's definition or an author
 * rule. Each identifier run is mapped through qLabel; every other run is escaped, with `*`→`·`
 * and `<=`/`>=`→`≤`/`≥`. Always safe for {@html} — no token reaches output unescaped.
 */
export function qFormula(expr: string): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*|[^A-Za-z_]+/g, (tok) => {
    if (/^[A-Za-z_]/.test(tok)) return tok === 'pi' ? 'π' : qLabel(tok);
    return escapeHtml(tok).replace(/\*/g, '·').replace(/&lt;=/g, '≤').replace(/&gt;=/g, '≥');
  });
}

// A small LaTeX-ish symbol table for inline math in author prose — enough for analog-design
// notation (Greek, comparisons, ·, √) without pulling in a math engine that would bloat the
// self-contained offline build. Keyed by the command name (without the backslash).
const TEX_SYMBOLS: Readonly<Record<string, string>> = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', ast: '∗',
  leq: '≤', geq: '≥', ll: '≪', gg: '≫', neq: '≠', approx: '≈', sim: '∼', propto: '∝', equiv: '≡',
  parallel: '∥', infty: '∞', partial: '∂', sqrt: '√', to: '→', rightarrow: '→', ldots: '…',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  kappa: 'κ', lambda: 'λ', mu: 'µ', nu: 'ν', xi: 'ξ', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', pi: 'π', Delta: 'Δ', Omega: 'Ω', Phi: 'Φ', Sigma: 'Σ',
}; // prettier-ignore

// The part of the LaTeX subset that is sink-independent: \frac{a}{b} → a/b, \sqrt{x} → √(x),
// \cmd → its symbol. Both renderers below wrap this; the ONE place a command is added or a
// pattern fixed. Sub/superscripts are deliberately NOT here — they are exactly what differs
// between an HTML sink (<sub> tags) and a text sink (braces dropped).
function texSubst(tex: string): string {
  return tex
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
    .replace(/\\([A-Za-z]+)/g, (_m, c: string) => TEX_SYMBOLS[c] ?? c);
}

/** Split author prose on `$…$` fences and render each run with the sink's own renderer: `math`
 *  for an inline-math run (fences already stripped), `text` for the prose between them. An
 *  unpaired `$` never matches, so it passes through as ordinary prose. */
function overMathRuns(s: string, math: (t: string) => string, text: (t: string) => string): string {
  return s
    .split(/(\$[^$]*\$)/)
    .map((seg, i) => (i % 2 === 1 ? math(seg.slice(1, -1)) : text(seg)))
    .join('');
}

/**
 * Render author prose that may carry inline math delimited by `$…$` (a deliberate LaTeX subset —
 * no math engine, to keep the offline build lean). Math runs escape FIRST, so only our own
 * <sub>/<sup> tags reach the output; prose outside the fences is escaped too. Always
 * {@html}-safe.
 */
export function mathText(s: string): string {
  return overMathRuns(
    s,
    (tex) =>
      texSubst(escapeHtml(tex))
        .replace(/_\{([^{}]*)\}/g, '<sub>$1</sub>')
        .replace(/\^\{([^{}]*)\}/g, '<sup>$1</sup>')
        .replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>')
        .replace(/\^([A-Za-z0-9*])/g, '<sup>$1</sup>')
        .replace(/\*/g, '·'),
    escapeHtml,
  );
}

/**
 * The same author prose rendered for a plain-TEXT sink — a `title` attribute, a copied
 * report — where markup cannot go. Symbols still resolve (`\gamma` → γ); the `$` fences and the
 * sub/superscript braces drop away, so a note reads as `V_GS` rather than as raw `$V_{GS}$`.
 * Never emits HTML, so callers must NOT pass it to {@html}.
 */
export function mathPlain(s: string): string {
  return overMathRuns(
    s,
    (tex) =>
      texSubst(tex)
        .replace(/([_^])\{([^{}]*)\}/g, '$1$2')
        .replace(/\*/g, '·'),
    (t) => t,
  );
}

/** Canonical base-quantity key → SI unit (e.g. 'vgs' → 'V'); for axis and bias readouts. */
export const baseUnit: ReadonlyMap<string, string> = new Map(
  BASE_QUANTITIES.map((q) => [q.key, q.unit]),
);
/** Unit string for a base-quantity key, '' if unknown. */
export const axisUnit = (name: string): string => baseUnit.get(name) ?? '';

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

/** Safe HTML label for an expression: a subscripted form when known, else escaped text. */
export function qLabel(expr: string): string {
  return SUBSCRIPTED[expr] ?? escapeHtml(expr);
}

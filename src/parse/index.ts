// mostab CSV importer: decodes a mostab-style CSV characterization export into a
// canonical Dataset (one DeviceTable on a dense rectangular grid). Pure, deterministic,
// zero DOM imports.

import type {
  Axis,
  Dataset,
  DeviceTable,
  FilledField,
  ImportError,
  ImportHints,
  ImportResult,
  TableId,
  TableMeta,
} from '../types';
import { ALIASES, passthroughKeys } from '../namespace';
import { makeGrid, strides } from '../grid';
import { DEFAULT_CORNER, DEFAULT_TEMP_C } from '../constants';

// The canonical sweep-axis keys, in their conventional grid order
// (first axis varies slowest in row-major storage).
const AXIS_KEYS = ['l', 'vds', 'vsb', 'vgs'] as const;
type AxisKey = (typeof AXIS_KEYS)[number];
const AXIS_KEY_SET: ReadonlySet<string> = new Set(AXIS_KEYS);

/** Strip a UTF-8 BOM if present. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Decode input bytes/string as UTF-8 text and split into raw lines. */
function toText(input: string | Uint8Array): string {
  if (typeof input === 'string') return input;
  return new TextDecoder('utf-8').decode(input);
}

/** Detect the delimiter from a header line: prefer the one with the most occurrences. */
function detectDelimiter(header: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = header.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Canonicalize a raw header cell -> { key, negate }: its alias, else the lower-cased header itself
 *  — a base key, or an unknown column carried under that name. (vbs -> vsb needs vsb = -vbs.) */
function canonicalizeHeader(raw: string): { key: string; negate: boolean } {
  const lower = raw.trim().toLowerCase();
  const negate = lower === 'vbs'; // body-source sign convention: vsb = -vbs
  // An own key only: a header spelled like an Object.prototype member (`constructor`,
  // `tostring`) must pass through under its own name, not resolve to an inherited function.
  const alias = Object.prototype.hasOwnProperty.call(ALIASES, lower) ? ALIASES[lower] : undefined;
  return { key: alias ?? lower, negate };
}

interface ParsedMeta {
  device?: string;
  corner?: string;
  temp?: number;
  W?: number;
  pdk?: string;
  simulator?: string;
  date?: string;
  AVT?: number;
  ABETA?: number;
  FCO?: number;
  /** Declared device type from a `# polarity:`/`# type:` line, NOT sniffed from
   *  data signs or the device NAME — only an explicit, authoritative declaration. */
  polarity?: 'n' | 'p';
  /** Unrecognized `# key: value` scalars, preserved verbatim (strict-superset rule). */
  extra?: Record<string, string>;
}

/** Map a declared polarity/type value to 'n'|'p', or undefined if unrecognized (an unknown
 *  value declares no polarity; the header is kept in `extra` and QA names it). */
function normalizePolarity(value: string): 'n' | 'p' | undefined {
  switch (value.trim().toLowerCase()) {
    case 'p':
    case 'pmos':
    case 'pch':
    case 'pfet':
    case 'pmosfet':
      return 'p';
    case 'n':
    case 'nmos':
    case 'nch':
    case 'nfet':
    case 'nmosfet':
      return 'n';
    default:
      return undefined;
  }
}

/**
 * The header names each numeric or polarity field is read from, lower-cased — the one list the
 * parser reads by and every reader of an unreadable header (unreadHeader) looks up.
 */
export const HEADER_NAMES = {
  temp: ['temp', 'temperature'],
  W: ['w', 'width'],
  AVT: ['avt'],
  ABETA: ['abeta'],
  FCO: ['fco'],
  polarity: ['polarity', 'type'],
} as const;

/** A field the importer reads from a header whose value it may be unable to read. */
export type ReadField = keyof typeof HEADER_NAMES;

/** Header name → the field it is read into. */
const FIELD_OF: ReadonlyMap<string, ReadField> = new Map(
  (Object.entries(HEADER_NAMES) as [ReadField, readonly string[]][]).flatMap(([field, names]) =>
    names.map((n) => [n, field] as const),
  ),
);

/**
 * A header of `field` the importer could not read, as written — `[its key, its value]` — or
 * undefined. The parser keeps such a header in `extra` (a recognized header is only there when
 * its value was unreadable), so this is how every reader tells "the file had no such header"
 * from "the file had one that could not be read".
 */
export function unreadHeader(meta: TableMeta, field: ReadField): [string, string] | undefined {
  const names: readonly string[] = HEADER_NAMES[field];
  for (const [k, v] of Object.entries(meta.extra ?? {}))
    if (names.includes(k.toLowerCase())) return [k, String(v)];
  return undefined;
}

/**
 * Parse a `# key: value` metadata comment line into the accumulator. A recognized header whose
 * value cannot be read — a number written with a unit or an engineering suffix (`# temp: 27C`,
 * `# W: 1u`), a polarity word off the list — is not dropped: it is kept in `extra` as written,
 * under its own key, where QA finds it and names it (see qa/validate). Dropped, it would read
 * exactly like a header the file never had.
 */
function applyMetaLine(line: string, meta: ParsedMeta): void {
  const body = line.replace(/^#+/, '').trim();
  const idx = body.indexOf(':');
  if (idx < 0) return;
  const rawKey = body.slice(0, idx).trim();
  const key = rawKey.toLowerCase();
  const value = body.slice(idx + 1).trim();
  if (value === '') return;
  const unread = (): void => {
    (meta.extra ??= {})[rawKey] = value;
  };
  /** A numeric header's value, or undefined after keeping the unreadable text. */
  const num = (): number | undefined => {
    const v = Number(value);
    if (Number.isFinite(v)) return v;
    unread();
    return undefined;
  };
  switch (FIELD_OF.get(key) ?? key) {
    case 'device':
      meta.device = value;
      break;
    case 'corner':
      meta.corner = value;
      break;
    case 'temp': {
      const t = num();
      if (t !== undefined) meta.temp = t;
      break;
    }
    case 'W': {
      const w = num();
      if (w !== undefined) meta.W = w;
      break;
    }
    case 'pdk':
      meta.pdk = value;
      break;
    case 'simulator':
      meta.simulator = value;
      break;
    case 'date':
      meta.date = value;
      break;
    case 'AVT': {
      const v = num();
      if (v !== undefined) meta.AVT = v;
      break;
    }
    case 'ABETA': {
      const v = num();
      if (v !== undefined) meta.ABETA = v;
      break;
    }
    case 'FCO': {
      const v = num();
      if (v !== undefined) meta.FCO = v;
      break;
    }
    case 'polarity': {
      // Authoritative declared device type only — never inferred from the device
      // NAME field. An unrecognized value declares no polarity, and is kept as written.
      const p = normalizePolarity(value);
      if (p !== undefined) meta.polarity = p;
      else unread();
      break;
    }
    // Any other key (e.g. mostab, license, source) is preserved verbatim under the
    // strict-superset rule, so provenance/licensing survives import instead of being dropped.
    // Stored under the original-case key so case-distinct keys don't collapse.
    default:
      (meta.extra ??= {})[rawKey] = value;
      break;
  }
}

/** Derive a default device name from a filename hint: the basename without its extension, the
 *  format's own double extension `.mostab.csv` taken off whole. */
function deviceFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const stem = /\.mostab\.csv$/i.test(base)
    ? base.slice(0, -'.mostab.csv'.length)
    : base.replace(/\.[^.]+$/, '');
  const trimmed = stem.trim();
  return trimmed === '' ? undefined : trimmed;
}

function err(kind: string, message: string, location?: string): ImportError {
  return location === undefined ? { kind, message } : { kind, message, location };
}

function fail(...errors: ImportError[]): ImportResult {
  return { ok: false, errors };
}

/**
 * Parse a mostab-style CSV export into an ImportResult.
 *
 * - `#`-prefixed lines are `key: value` metadata.
 * - The first non-comment, non-blank line is the header row; the delimiter is
 *   auto-detected among `,`, `;`, tab.
 * - Headers are lower-cased/trimmed and mapped through ALIASES; unknown headers are
 *   carried through verbatim as passthrough columns.
 * - Axis columns among {l, vgs, vds, vsb} define a complete rectangular grid; every
 *   non-axis quantity is assembled row-major into a Float64Array.
 */
/**
 * Canonical column keys of the header row alone (empty if no header is found).
 * Lets a caller report header-level defects (e.g. a missing required column)
 * even when full parsing fails earlier for an independent reason, so one defect
 * never masks another.
 */
export function mostabHeaderKeys(text: string | Uint8Array): string[] {
  // The header sits at the top of the file, after the metadata block — so decode a
  // bounded prefix of a binary input and scan it line-by-line, never materializing
  // every data row of a large export. Only when the prefix holds no complete data
  // line (a pathological metadata block) does this fall back to the full decode.
  const PREFIX_BYTES = 256 * 1024;
  if (typeof text !== 'string' && text.length > PREFIX_BYTES) {
    const head = stripBom(new TextDecoder().decode(text.subarray(0, PREFIX_BYTES)));
    // Only complete lines: the cut may tear a line (or a UTF-8 sequence) at the end.
    const complete = head.slice(0, Math.max(head.lastIndexOf('\n'), head.lastIndexOf('\r')) + 1);
    const header = firstDataLine(complete);
    if (header !== undefined) return headerKeys(header);
  }
  const header = firstDataLine(stripBom(toText(text)));
  return header === undefined ? [] : headerKeys(header);
}

/** First non-empty, non-comment line, scanned lazily (no whole-input split). */
function firstDataLine(s: string): string | undefined {
  const lines = /[^\r\n]+/g;
  for (let m = lines.exec(s); m !== null; m = lines.exec(s)) {
    const t = m[0].trim();
    if (t !== '' && !t.startsWith('#')) return m[0];
  }
  return undefined;
}

function headerKeys(header: string): string[] {
  return header.split(detectDelimiter(header)).map((c) => canonicalizeHeader(c).key);
}

export function parseMostabCsv(text: string | Uint8Array, hints?: ImportHints): ImportResult {
  const meta: ParsedMeta = {};
  const decoded = stripBom(toText(text));
  const rawLines = decoded.split(/\r\n|\r|\n/);

  let headerLine: string | undefined;
  const dataLines: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) {
      applyMetaLine(trimmed, meta);
      continue;
    }
    if (headerLine === undefined) {
      headerLine = line;
      continue;
    }
    dataLines.push(line);
  }

  if (headerLine === undefined) {
    return fail(err('empty', 'No header row found in mostab CSV.'));
  }

  const delim = detectDelimiter(headerLine);
  const rawHeaders = headerLine.split(delim);
  const headers = rawHeaders.map(canonicalizeHeader);

  // Detect duplicate canonical keys (ambiguous; cannot decide which column wins).
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h.key)) {
      return fail(err('duplicate-column', `Duplicate column key "${h.key}" in header.`));
    }
    seen.add(h.key);
  }

  // Which columns are axes, in canonical AXIS_KEYS order.
  const presentAxisKeys: AxisKey[] = AXIS_KEYS.filter((k) => seen.has(k));
  if (presentAxisKeys.length === 0) {
    return fail(err('no-axes', 'No sweep-axis columns (l, vgs, vds, vsb) found.'));
  }

  const colIndexByKey = new Map<string, number>();
  headers.forEach((h, i) => colIndexByKey.set(h.key, i));

  // Non-axis quantity columns (canonical + passthrough), preserving header order.
  const valueCols: { key: string; index: number }[] = [];
  headers.forEach((h, i) => {
    if (AXIS_KEY_SET.has(h.key)) return;
    valueCols.push({ key: h.key, index: i });
  });

  // Parse data rows into numeric tuples.
  const ncol = rawHeaders.length;
  const rows: number[][] = [];
  for (let r = 0; r < dataLines.length; r++) {
    const cells = dataLines[r].split(delim);
    if (cells.length !== ncol) {
      return fail(
        err(
          'ragged-row',
          `Row ${r + 1} has ${cells.length} cells, expected ${ncol}.`,
          `row ${r + 1}`,
        ),
      );
    }
    const nums = new Array<number>(ncol);
    for (let c = 0; c < ncol; c++) {
      const cell = cells[c].trim();
      const v = Number(cell);
      // Reject blanks (Number('') === 0) and non-numeric cells so CSV corruption
      // becomes a rejected import, not silent 0/NaN operating points.
      if (cell === '' || !Number.isFinite(v)) {
        return fail(
          err(
            'bad-cell',
            `Row ${r + 1}, column "${rawHeaders[c].trim()}": non-numeric or empty value "${cells[c]}".`,
            `row ${r + 1}`,
          ),
        );
      }
      nums[c] = headers[c].negate ? -v : v;
    }
    rows.push(nums);
  }

  if (rows.length === 0) {
    return fail(err('no-data', 'mostab CSV has a header but no data rows.'));
  }

  // Build sorted-unique axis values.
  const axisValues = new Map<AxisKey, number[]>();
  for (const k of presentAxisKeys) {
    const idx = colIndexByKey.get(k)!;
    const uniq = new Set<number>();
    for (const row of rows) uniq.add(row[idx]);
    const vals = [...uniq].sort((a, b) => a - b);
    if (vals.some((v) => !Number.isFinite(v))) {
      return fail(err('bad-axis', `Axis column "${k}" contains a non-finite value.`));
    }
    axisValues.set(k, vals);
  }

  const shape = presentAxisKeys.map((k) => axisValues.get(k)!.length);
  const total = shape.reduce((a, b) => a * b, 1);

  // The rows must form a complete rectangular grid.
  if (rows.length !== total) {
    return fail(
      err(
        'incomplete-grid',
        `Rows (${rows.length}) do not fill the rectangular grid ${shape.join('x')} (=${total}).`,
      ),
    );
  }

  // Index lookup per axis: value -> position.
  const axisPos = presentAxisKeys.map((k) => {
    const pos = new Map<number, number>();
    axisValues.get(k)!.forEach((v, i) => pos.set(v, i));
    return pos;
  });

  // Strides for row-major flat indexing (first axis slowest).
  const st = strides(shape);

  // Allocate flat columns for every value quantity.
  const quantities = new Map<string, Float64Array>();
  for (const vc of valueCols) quantities.set(vc.key, new Float64Array(total));

  const filled = new Uint8Array(total);
  const axisCol = presentAxisKeys.map((k) => colIndexByKey.get(k)!);

  for (const row of rows) {
    let flat = 0;
    for (let d = 0; d < presentAxisKeys.length; d++) {
      const p = axisPos[d].get(row[axisCol[d]]);
      if (p === undefined) {
        return fail(
          err('grid-coord', `Row has off-grid coordinate on axis "${presentAxisKeys[d]}".`),
        );
      }
      flat += p * st[d];
    }
    if (filled[flat]) {
      return fail(err('duplicate-grid-point', 'Two rows map to the same grid coordinate.'));
    }
    filled[flat] = 1;
    for (const vc of valueCols) {
      quantities.get(vc.key)![flat] = row[vc.index];
    }
  }

  const axes: Axis[] = presentAxisKeys.map((k) => ({
    name: k,
    values: Float64Array.from(axisValues.get(k)!),
  }));

  const grid = makeGrid(axes, quantities);

  // Resolve identity (hints > metadata > filename > default). A caller's hint declares a field
  // as surely as a header does; a name taken from the file name, or a default, is filled in, and
  // recorded as such (TableMeta.filled) so every reader can say it was assumed.
  const declaredDevice = hints?.device ?? meta.device;
  const device = declaredDevice ?? deviceFromFilename(hints?.filename) ?? 'dev0';
  const declaredCorner = hints?.corner ?? meta.corner;
  const corner = declaredCorner ?? DEFAULT_CORNER;
  const temp = meta.temp ?? DEFAULT_TEMP_C;
  const filledIn: FilledField[] = [];
  if (declaredDevice === undefined) filledIn.push('device');
  if (declaredCorner === undefined) filledIn.push('corner');
  if (meta.temp === undefined) filledIn.push('temp');

  const id: TableId = { device, corner, temp };

  const tableMeta: TableMeta = {};
  const mutMeta = tableMeta as { -readonly [K in keyof TableMeta]: TableMeta[K] };
  if (meta.W !== undefined) mutMeta.W = meta.W;
  if (meta.temp !== undefined) mutMeta.temp = meta.temp;
  if (meta.pdk !== undefined) mutMeta.pdk = meta.pdk;
  if (meta.simulator !== undefined) mutMeta.simulator = meta.simulator;
  if (meta.date !== undefined) mutMeta.date = meta.date;
  if (meta.AVT !== undefined) mutMeta.AVT = meta.AVT;
  if (meta.ABETA !== undefined) mutMeta.ABETA = meta.ABETA;
  if (meta.FCO !== undefined) mutMeta.FCO = meta.FCO;
  // A declared P device is in the raw signed convention, so flag it for the
  // magnitude fold; a declared N device is recorded with nothing to fold.
  if (meta.polarity !== undefined) {
    mutMeta.polarity = { device: meta.polarity, signedInput: meta.polarity === 'p' };
  }
  if (filledIn.length) mutMeta.filled = filledIn;
  if (meta.extra !== undefined) mutMeta.extra = meta.extra;

  // The pass-through set is the namespace's own reading of the grid, so the field and every reader
  // of `isPassthroughKey` agree on which columns are pass-through.
  const passthrough = passthroughKeys(grid);
  const table: DeviceTable =
    passthrough.length > 0
      ? { id, grid, meta: tableMeta, passthrough: new Set(passthrough) }
      : { id, grid, meta: tableMeta };

  const dataset: Dataset = { tables: [table], warnings: [] };
  return { ok: true, dataset };
}

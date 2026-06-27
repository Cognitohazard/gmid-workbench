// mostab CSV importer: decodes a mostab-style CSV characterization export into a
// canonical Dataset (one DeviceTable on a dense rectangular grid). Pure, deterministic,
// zero DOM imports.

import type {
  Axis,
  Dataset,
  DeviceTable,
  ImportError,
  ImportHints,
  ImportResult,
  TableId,
  TableMeta,
} from '../types';
import { ALIASES, BASE_KEYS } from '../namespace';
import { makeGrid } from '../grid';

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

/** Canonicalize a raw header cell -> { key, passthrough, negate }. (vbs -> vsb needs vsb = -vbs.) */
function canonicalizeHeader(raw: string): { key: string; passthrough: boolean; negate: boolean } {
  const lower = raw.trim().toLowerCase();
  const negate = lower === 'vbs'; // body-source sign convention: vsb = -vbs
  const alias = ALIASES[lower];
  if (alias !== undefined) return { key: alias, passthrough: false, negate };
  if (BASE_KEYS.has(lower)) return { key: lower, passthrough: false, negate: false };
  return { key: lower, passthrough: true, negate: false };
}

interface ParsedMeta {
  device?: string;
  corner?: string;
  temp?: number;
  W?: number;
  simulator?: string;
  date?: string;
  AVT?: number;
  ABETA?: number;
  FCO?: number;
  /** Declared device type from a `# polarity:`/`# type:` line, NOT sniffed from
   *  data signs or the device NAME — only an explicit, authoritative declaration. */
  polarity?: 'n' | 'p';
}

/** Map a declared polarity/type value to 'n'|'p', or undefined if unrecognized
 *  (an unknown value is ignored, exactly as a missing line is). */
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

/** Parse a `# key: value` metadata comment line into the accumulator. */
function applyMetaLine(line: string, meta: ParsedMeta): void {
  const body = line.replace(/^#+/, '').trim();
  const idx = body.indexOf(':');
  if (idx < 0) return;
  const key = body.slice(0, idx).trim().toLowerCase();
  const value = body.slice(idx + 1).trim();
  if (value === '') return;
  switch (key) {
    case 'device':
      meta.device = value;
      break;
    case 'corner':
      meta.corner = value;
      break;
    case 'temp':
    case 'temperature': {
      const t = Number(value);
      if (Number.isFinite(t)) meta.temp = t;
      break;
    }
    case 'w':
    case 'width': {
      const w = Number(value);
      if (Number.isFinite(w)) meta.W = w;
      break;
    }
    case 'simulator':
      meta.simulator = value;
      break;
    case 'date':
      meta.date = value;
      break;
    case 'avt': {
      const v = Number(value);
      if (Number.isFinite(v)) meta.AVT = v;
      break;
    }
    case 'abeta': {
      const v = Number(value);
      if (Number.isFinite(v)) meta.ABETA = v;
      break;
    }
    case 'fco': {
      const v = Number(value);
      if (Number.isFinite(v)) meta.FCO = v;
      break;
    }
    case 'polarity':
    case 'type': {
      // Authoritative declared device type only — never inferred from the device
      // NAME field. An unrecognized value is ignored (no polarity set).
      const p = normalizePolarity(value);
      if (p !== undefined) meta.polarity = p;
      break;
    }
    // "mostab version" and any other keys are intentionally ignored.
    default:
      break;
  }
}

/** Derive a default device name from a filename hint (basename without extension). */
function deviceFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const stem = base.replace(/\.[^.]+$/, '');
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
export function parseMostabCsv(
  text: string | Uint8Array,
  hints?: ImportHints,
): ImportResult {
  const meta: ParsedMeta = {};
  const decoded = stripBom(toText(text));
  const rawLines = decoded.split(/\r\n|\r|\n/);

  let headerLine: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of rawLines) {
    const line = rawLine;
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
  const valueCols: { key: string; index: number; passthrough: boolean }[] = [];
  const passthroughKeys = new Set<string>();
  headers.forEach((h, i) => {
    if (AXIS_KEY_SET.has(h.key)) return;
    valueCols.push({ key: h.key, index: i, passthrough: h.passthrough });
    if (h.passthrough) passthroughKeys.add(h.key);
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
  const strides = new Array<number>(presentAxisKeys.length);
  {
    let acc = 1;
    for (let d = presentAxisKeys.length - 1; d >= 0; d--) {
      strides[d] = acc;
      acc *= shape[d];
    }
  }

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
      flat += p * strides[d];
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

  // Resolve identity (hints > metadata > filename > default).
  const device =
    hints?.device ??
    meta.device ??
    deviceFromFilename(hints?.filename) ??
    'dev0';
  const corner = hints?.corner ?? meta.corner ?? 'tt';
  const temp = meta.temp ?? 27;

  const id: TableId = { device, corner, temp };

  const tableMeta: TableMeta = {};
  const mutMeta = tableMeta as { -readonly [K in keyof TableMeta]: TableMeta[K] };
  if (meta.W !== undefined) mutMeta.W = meta.W;
  if (meta.temp !== undefined) mutMeta.temp = meta.temp;
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

  const table: DeviceTable =
    passthroughKeys.size > 0
      ? { id, grid, meta: tableMeta, passthrough: passthroughKeys }
      : { id, grid, meta: tableMeta };

  const dataset: Dataset = { tables: [table], warnings: [] };
  return { ok: true, dataset };
}

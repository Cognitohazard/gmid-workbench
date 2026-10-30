// The sheet loader: an untrusted document — a file a user imports, a copy restored from browser
// storage, a sheet a script reads from disk — brought into the shape the engine reads, with every
// piece it could not carry over recorded rather than silently dropped. Earlier key spellings are
// brought up to the current ones at every level of a composed tree first (see legacy.ts), so a
// document written before a rename loads, and the app and a script read a document the same way.
// Pure; zero DOM.

import { inCurrentKeys } from './legacy';
import { carriedBlockWiring, carriedConvention, carriedDocWiring, sheetFormat } from './nodes';
import {
  BLOCK_KEYS,
  CHECK_KEYS,
  CHECK_KINDS,
  CHECK_OPS,
  DOC_KEYS,
  EARLIER_BLOCK_KEYS,
  EQUATION_KEYS,
  GIVENS_FLAGS,
  GIVENS_KEYS,
  GIVENS_WORDS,
  MAX_BLOCK_DEPTH,
  PARAM_CLASSES,
  RANGE_END_KEYS,
  VAR_KEYS,
  cloneDoc,
  type CheckKind,
  type CheckOp,
  type ParamClass,
  type QuantizeRound,
  type SheetBlock,
  type SheetCheck,
  type SheetDoc,
  type SheetEquation,
  type SheetGivens,
  type SheetRangeEnd,
  type SheetVar,
} from './types';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Coerce an untrusted saved leaf design-sheet (from localStorage, or a user's imported
 * sheet JSON) into a valid SheetDoc, dropping malformed entries but keeping every
 * author expression verbatim — an unresolvable one surfaces as a per-check 'na' chip at
 * evaluation, never a silent drop. The givens are kept whenever they carry a string `L` — their
 * arity is validateSheet's business, which names the problem instead of silently unsizing
 * the sheet — so only L-less givens are dropped, and the checks then go 'na'. Every piece
 * this pass does not carry over is recorded in `lost`, including a key no core key set
 * knows. Returns undefined when `v` is not an object, or writes one key in two spellings.
 *
 * `checkId` names a check written without an id, by its index in its sheet: by default
 * `check-<n>`, so the same document always loads the same way; the app passes a fresh unique id.
 */
export function sanitizeSheet(
  v: unknown,
  depth = 0,
  lost?: string[],
  checkId: (index: number) => string = (i) => `check-${i + 1}`,
): SheetDoc | undefined {
  if (!v || typeof v !== 'object') return undefined;
  // Depth backstop: the evaluator/validator error out past MAX_BLOCK_DEPTH, but they can
  // only do so if loading the doc didn't blow the stack first. One level beyond the cap
  // is kept so the validator still sees a non-empty `blocks` at the cap and raises its
  // depth error rather than the truncation reading as a shallower (silently valid) tree.
  if (depth > MAX_BLOCK_DEPTH + 1) return undefined;
  // A document in a format this app does not read is kept exactly as it was stored: rebuilding it
  // key by key would drop whatever the newer format added and keep a version number that no longer
  // describes the result. The reason is recorded, so an import refuses it; a restored copy opens
  // with the same reason and is not evaluated (validation and evaluation both stop at it).
  const format = sheetFormat(v);
  if (format.format === 'unknown') {
    lost?.push(`formatVersion: ${format.reason}`);
    return cloneDoc(v as SheetDoc);
  }
  // Earlier spellings of the keys are brought up to the current ones FIRST, before anything
  // below counts an unknown key or a lost piece — an older document must load, not be refused
  // key by key. A key written in both spellings is ambiguous, so that document is refused.
  const { doc: o, both } = inCurrentKeys(v as Record<string, unknown>);
  if (both.length) {
    lost?.push(...both.map((b) => `${b} (one key, two spellings)`));
    return undefined;
  }
  const str = (x: unknown, fallback: string) => (typeof x === 'string' && x ? x : fallback);
  // `lost` records the path of every authored piece this pass DROPS. The import path fails
  // closed on any — a sheet whose mistyped check was dropped would otherwise validate cleanly
  // and read feasible without that check. The restore paths keep what they can read, say what
  // they dropped where the sheet is shown, and keep the stored copy until the user edits it
  // (see restoredSheet, and the library's own restore).
  const drop = (path: string): [] => {
    lost?.push(path);
    return [];
  };
  // A field that is PRESENT but of the wrong shape is a drop too — a mistyped role,
  // bound, tolerance, or device binding silently vanishing is exactly the fail-open
  // hole the collector exists to close.
  const dropField = (bad: boolean, path: string): void => {
    if (bad) lost?.push(path);
  };
  // An UNKNOWN key is a drop too: every container below is rebuilt field by field, so a key
  // nothing carries over vanishes exactly like a malformed one. Each is checked against the
  // core's own key set rather than a copy of it — a whitelist maintained here is precisely the
  // mechanism that silently ate a legal fT given (and would have eaten `designConstraint` and
  // `diode`) on reload, and the same hole stayed open on the doc, params, equations, checks and
  // blocks.
  // A key no format reads any more (`kept`) is not lost: it is carried as stored (see the block
  // below), so validation names the migration it needs.
  const unknownKeys = (
    obj: Record<string, unknown>,
    keys: ReadonlySet<string>,
    at: string,
    kept: readonly string[] = [],
  ): void => {
    for (const k of Object.keys(obj))
      if (!keys.has(k) && !kept.includes(k)) lost?.push(`${at}${k}`);
  };
  for (const k of [
    'params',
    'equations',
    'checks',
    'blocks',
    'provides',
    'operatingRange',
  ] as const)
    if (o[k] !== undefined && !Array.isArray(o[k])) lost?.push(k);
  // Keep only the string-valued entries of an authored name→expression map, recording the
  // rest — shared by a block's param overrides and a range end's set.
  const strMap = (obj: Record<string, unknown>, at: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(obj)) {
      if (typeof val === 'string') out[k] = val;
      else lost?.push(`${at}.${k}`);
    }
    return out;
  };
  dropField(o.title !== undefined && !(typeof o.title === 'string' && o.title), 'title');
  dropField(o.description !== undefined && typeof o.description !== 'string', 'description');
  dropField(o.polarity !== undefined && o.polarity !== 'n' && o.polarity !== 'p', 'polarity');
  unknownKeys(o, DOC_KEYS, '');

  const params: SheetVar[] = Array.isArray(o.params)
    ? o.params.flatMap((p, i) => {
        if (!p || typeof p !== 'object') return drop(`params[${i}]`);
        const pp = p as Record<string, unknown>;
        if (typeof pp.name !== 'string' || !finite(pp.value)) return drop(`params[${i}]`);
        unknownKeys(pp, VAR_KEYS, `params[${i}].`);
        const out: SheetVar = { name: pp.name, value: pp.value };
        if (finite(pp.min)) out.min = pp.min;
        else dropField(pp.min !== undefined, `params[${i}].min`);
        if (finite(pp.max)) out.max = pp.max;
        else dropField(pp.max !== undefined, `params[${i}].max`);
        if (typeof pp.unit === 'string') out.unit = pp.unit;
        else dropField(pp.unit !== undefined, `params[${i}].unit`);
        if (pp.role === 'spec' || pp.role === 'choice') out.role = pp.role;
        else dropField(pp.role !== undefined, `params[${i}].role`);
        if (typeof pp.note === 'string') out.note = pp.note;
        else dropField(pp.note !== undefined, `params[${i}].note`);
        // Load-bearing, not cosmetic: dropping solveFor silently reverts a solved bias loop to
        // a hand-tuned estimate, which is exactly the wrong answer the field exists to prevent.
        if (typeof pp.solveFor === 'string' && pp.solveFor !== '') out.solveFor = pp.solveFor;
        else dropField(pp.solveFor !== undefined, `params[${i}].solveFor`);
        // Same stakes as solveFor: dropping a design constraint silently turns a solved node back
        // into the stale default it displays. An OBJECT field, so it needs its own shape check.
        // A written `held` (the engine's own flag) is carried as it is, so validation refuses it by
        // name instead of the loader dropping it unsaid.
        const constraint = pp.designConstraint as
          { lhs?: unknown; rhs?: unknown; held?: unknown } | undefined;
        if (constraint && typeof constraint.lhs === 'string' && typeof constraint.rhs === 'string')
          out.designConstraint = {
            lhs: constraint.lhs,
            rhs: constraint.rhs,
            ...('held' in constraint ? { held: constraint.held as boolean } : {}),
          };
        else dropField(pp.designConstraint !== undefined, `params[${i}].designConstraint`);
        // Same stakes again: a dropped hold leaves the node typed, and a range end would then
        // hold the node where the design holds the gate.
        if (typeof pp.hold === 'string' && pp.hold !== '') out.hold = pp.hold;
        else dropField(pp.hold !== undefined, `params[${i}].hold`);
        // A dropped class turns a declared DC input back into an unclassified one, which fails
        // validation — so an unknown value (including the derived-only "solved") is named here.
        if (typeof pp.class === 'string' && PARAM_CLASSES.has(pp.class))
          out.class = pp.class as ParamClass;
        else dropField(pp.class !== undefined, `params[${i}].class`);
        // Rounding of a solved value: carried as written, so validation names a bad one instead of
        // the loader turning a rounded design back into an exact one unsaid.
        const q = pp.quantize as { sigFigs?: unknown; round?: unknown } | undefined;
        if (q && typeof q === 'object' && !Array.isArray(q) && typeof q.sigFigs === 'number')
          out.quantize = {
            sigFigs: q.sigFigs,
            ...(typeof q.round === 'string' ? { round: q.round as QuantizeRound } : {}),
          };
        else dropField(pp.quantize !== undefined, `params[${i}].quantize`);
        dropField(
          !!q && typeof q === 'object' && q.round !== undefined && typeof q.round !== 'string',
          `params[${i}].quantize.round`,
        );
        // The axis-sign marker: dropping it would turn a sign the wiring check reads as the table's
        // axis direction back into an unknown product.
        Object.assign(out, carriedConvention(pp, `params[${i}].`, lost));
        return [out];
      })
    : [];

  const equations: SheetEquation[] = Array.isArray(o.equations)
    ? o.equations.flatMap((r, i) => {
        if (!r || typeof r !== 'object') return drop(`equations[${i}]`);
        const rr = r as Record<string, unknown>;
        if (typeof rr.name !== 'string' || typeof rr.expr !== 'string')
          return drop(`equations[${i}]`);
        unknownKeys(rr, EQUATION_KEYS, `equations[${i}].`);
        const out: SheetEquation = { name: rr.name, expr: rr.expr };
        if (typeof rr.unit === 'string') out.unit = rr.unit;
        else dropField(rr.unit !== undefined, `equations[${i}].unit`);
        if (typeof rr.note === 'string') out.note = rr.note;
        else dropField(rr.note !== undefined, `equations[${i}].note`);
        return [out];
      })
    : [];

  const checks: SheetCheck[] = Array.isArray(o.checks)
    ? o.checks.flatMap((r, i) => {
        if (!r || typeof r !== 'object') return drop(`checks[${i}]`);
        const rr = r as Record<string, unknown>;
        if (typeof rr.lhs !== 'string' || typeof rr.rhs !== 'string') return drop(`checks[${i}]`);
        if (!CHECK_OPS.has(rr.op as string) || !CHECK_KINDS.has(rr.kind as string))
          return drop(`checks[${i}]`);
        unknownKeys(rr, CHECK_KEYS, `checks[${i}].`);
        dropField(rr.id !== undefined && !(typeof rr.id === 'string' && rr.id), `checks[${i}].id`);
        const out: SheetCheck = {
          id: str(rr.id, checkId(i)),
          kind: rr.kind as CheckKind,
          lhs: rr.lhs,
          op: rr.op as CheckOp,
          rhs: rr.rhs,
        };
        if (finite(rr.tolPct)) out.tolPct = rr.tolPct;
        else dropField(rr.tolPct !== undefined, `checks[${i}].tolPct`);
        if (typeof rr.justification === 'string') out.justification = rr.justification;
        else dropField(rr.justification !== undefined, `checks[${i}].justification`);
        if (typeof rr.note === 'string') out.note = rr.note;
        else dropField(rr.note !== undefined, `checks[${i}].note`);
        return [out];
      })
    : [];

  // Givens with the wrong arity are kept, NOT dropped: validateSheet raises a visible
  // "exactly two" error the author can fix, whereas dropping them here would silently turn a
  // mis-authored sized sheet into an unsized one.
  let givens: SheetGivens | undefined;
  if (o.givens && typeof o.givens === 'object') {
    const b = o.givens as Record<string, unknown>;
    if (typeof b.L === 'string') {
      const cand: SheetGivens = { L: b.L };
      // Members are written through an index view: SheetGivens mixes expression strings with a
      // boolean flag, so assigning by `keyof SheetGivens` narrows the value type to never.
      const into = cand as unknown as Record<string, unknown>;
      // Walk what the document actually carries, checking each key against the core's own
      // lists rather than a copy of them: a hand-maintained whitelist here silently deleted
      // every given quantity added to BINDABLE, which round-tripped legal two-quantity givens
      // into a one-quantity "needs exactly two" error on the next reload. Anything
      // unrecognized or non-string is RECORDED as dropped, so an import fails closed on it
      // instead of quietly rewriting the design.
      for (const k of Object.keys(b)) {
        if (k === 'L') continue;
        if (GIVENS_KEYS.has(k) && typeof b[k] === 'string') into[k] = b[k];
        // A flag (the diode connection) is a boolean, and would fail the string test above —
        // which would delete the connection and leave the device unbiased on every reload.
        else if (GIVENS_FLAGS.has(k) && typeof b[k] === 'boolean') into[k] = b[k];
        // A word from a fixed list (the region a device must stay in) is a string like an
        // expression, kept as written; validation is what refuses a word off the list.
        else if (GIVENS_WORDS.has(k) && typeof b[k] === 'string') into[k] = b[k];
        else dropField(true, `givens.${k}`);
      }
      givens = cand;
    }
  }
  if (o.givens !== undefined && !givens) lost?.push('givens');

  // Composition: each child is a full SheetDoc recursively sanitized; the param-override map,
  // the provides, and the per-child `device` (a table uid the resolver matches against the
  // loaded devices) are kept verbatim so a composed sheet round-trips intact. A persisted device
  // that is not currently loaded simply reads infeasible until re-loaded. A by-reference child
  // (`ref` without an embedded doc) is kept as the reference — resolution happens at evaluation,
  // and a ref that no longer resolves reads infeasible rather than being dropped.
  const blocks: SheetBlock[] = Array.isArray(o.blocks)
    ? o.blocks.flatMap((u, i) => {
        if (!u || typeof u !== 'object') return drop(`blocks[${i}]`);
        const uu = u as Record<string, unknown>;
        if (typeof uu.name !== 'string' || !uu.name) return drop(`blocks[${i}]`);
        // The block ITSELF only; `params` maps author-chosen param names, which no key set knows.
        // The gate `wiring` written before the netlist is read by no format, and is kept as stored:
        // dropped here, a stored copy would reload with nothing to say how to migrate it, while
        // kept, validation refuses it with the migration (its wires are `nodes` in format 2).
        unknownKeys(uu, BLOCK_KEYS, `blocks[${i}].`, EARLIER_BLOCK_KEYS);
        const childLost: string[] = [];
        const childDoc = sanitizeSheet(uu.doc, depth + 1, childLost, checkId);
        // A child refused outright keeps its reason (a key in two spellings) beside its path.
        if (uu.doc !== undefined && !childDoc)
          lost?.push(`blocks[${i}].doc${childLost.length ? ` (${childLost[0]})` : ''}`);
        else if (childLost.length) lost?.push(...childLost.map((p) => `blocks[${i}].doc.${p}`));
        // Any string ref is kept VERBATIM — including an empty one. An empty ref is an
        // authoring error the validator names ("empty ref", blocking feasibility);
        // coercing it away here would silently delete the authored block and let the
        // sheet read feasible where the core reads it infeasible.
        const ref = typeof uu.ref === 'string' ? uu.ref : undefined;
        dropField(uu.ref !== undefined && ref === undefined, `blocks[${i}].ref`);
        if (!childDoc && ref === undefined) return uu.doc !== undefined ? [] : drop(`blocks[${i}]`);
        const block: SheetBlock = { name: uu.name };
        if (childDoc) block.doc = childDoc;
        if (ref !== undefined) block.ref = ref;
        // A malformed device binding must be REPORTED, not silently inherited from
        // the parent — the sheet would evaluate against the wrong table.
        if (typeof uu.device === 'string') block.device = uu.device;
        else dropField(uu.device !== undefined, `blocks[${i}].device`);
        if (uu.params && typeof uu.params === 'object' && !Array.isArray(uu.params)) {
          const ov = strMap(uu.params as Record<string, unknown>, `blocks[${i}].params`);
          if (Object.keys(ov).length) block.params = ov;
        } else if (uu.params !== undefined) lost?.push(`blocks[${i}].params`);
        // The wires the child's device sits on, the child's port map, and the keys of the earlier
        // format: carried by the core's own walk, so the keys the netlist adds are known in one
        // place.
        Object.assign(block, carriedBlockWiring(uu, `blocks[${i}].`, lost));
        return [block];
      })
    : [];

  const provide: string[] = Array.isArray(o.provides)
    ? o.provides.flatMap((x, i) => {
        if (typeof x === 'string') return [x];
        return drop(`provides[${i}]`);
      })
    : [];

  // Range ends: same stakes as `designConstraint` — dropping one silently turns a checked range
  // claim back into an unchecked number. A range end whose `set` survives EMPTY is kept, not
  // dropped: validateSheet owns that verdict ("sets nothing", blocking feasibility), and
  // eating it here would let the sheet reload MORE feasible than the core reads it — the
  // exact hole the empty-ref rule above refuses.
  const rangeEnds: SheetRangeEnd[] = Array.isArray(o.operatingRange)
    ? o.operatingRange.flatMap((e, i) => {
        if (!e || typeof e !== 'object') return drop(`operatingRange[${i}]`);
        const ee = e as Record<string, unknown>;
        if (typeof ee.name !== 'string' || !ee.name) return drop(`operatingRange[${i}]`);
        unknownKeys(ee, RANGE_END_KEYS, `operatingRange[${i}].`);
        if (!ee.set || typeof ee.set !== 'object' || Array.isArray(ee.set))
          return drop(`operatingRange[${i}]`);
        const out: SheetRangeEnd = {
          name: ee.name,
          set: strMap(ee.set as Record<string, unknown>, `operatingRange[${i}].set`),
        };
        if (typeof ee.note === 'string') out.note = ee.note;
        else dropField(ee.note !== undefined, `operatingRange[${i}].note`);
        return [out];
      })
    : [];

  return {
    title: str(o.title, 'Sheet'),
    ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
    // An absent polarity stays absent: the engine reads the device as n and says so (the
    // sheet-polarity finding), which a default written in here would hide.
    ...(o.polarity === 'n' || o.polarity === 'p' ? { polarity: o.polarity } : {}),
    params,
    equations,
    checks,
    ...(givens ? { givens } : {}),
    ...(blocks.length ? { blocks } : {}),
    ...(provide.length ? { provides: provide } : {}),
    ...(rangeEnds.length ? { operatingRange: rangeEnds } : {}),
    // The format version and the netlist (nodes, levels, elements, ports, analyses), carried by the
    // core's own walk for the reason the key sets above are the core's.
    ...carriedDocWiring(o, lost),
  };
}

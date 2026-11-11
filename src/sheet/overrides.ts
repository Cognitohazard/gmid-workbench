// Setting a param anywhere in a composed tree by its path, the way the tree itself sets one: a
// child's param is set by its parent block's override (`block.params`), which the child reads in
// place of its own value. A script can then sweep a child's param — `bias.L_MB5` — without
// rewriting the child's file. Pure; zero DOM.

import type { SheetRefIndex } from './resolve';
import { cloneDoc, engineSolved, PATH_SEP, type SheetBlock, type SheetDoc } from './types';

/**
 * `doc` with each param `values` names set to its number, each named by its path: `L_x` on this
 * sheet, `bias.L_MB5` on the child `bias`, `bias.MB5.L` one level further down. A param of this
 * sheet takes the value; a child's is set as an override on the block that composes it, replacing
 * any override that block already wrote for it. A path that passes through a child included by
 * reference needs `refs`: that child is resolved and embedded in the copy, keeping its `ref`, so the
 * override below it has somewhere to be written. The input is untouched.
 *
 * Throws, naming the path, where a block or param it names does not exist, a child by reference
 * cannot be resolved, or the param is one the engine solves — an override of a solved param is
 * ignored, so setting one would change nothing.
 */
export function withOverrides(
  doc: SheetDoc,
  values: Readonly<Record<string, number>>,
  refs?: SheetRefIndex,
): SheetDoc {
  const out = cloneDoc(doc);
  for (const [path, value] of Object.entries(values)) {
    const fail = (why: string): never => {
      throw new Error(`withOverrides: "${path}": ${why}`);
    };
    if (!Number.isFinite(value)) fail(`${value} is not a finite number`);
    const segments = path.split(PATH_SEP);
    const name = segments[segments.length - 1];
    /** The document of `block`, embedding a by-reference child's where it must be written into. */
    const docOf = (block: SheetBlock, embed: boolean): SheetDoc => {
      if (block.doc) return block.doc;
      if (block.ref === undefined) return fail(`block "${block.name}" has no document`);
      const hit = refs?.get(block.ref);
      if (!hit || !('doc' in hit))
        return fail(
          `block "${block.name}" is included by reference ("${block.ref}") and ` +
            (refs ? 'the reference does not resolve' : 'no refs were given to resolve it'),
        );
      if (!embed) return hit.doc;
      return (block.doc = cloneDoc(hit.doc));
    };
    const settable = (d: SheetDoc, where: string): void => {
      const p = d.params.find((q) => q.name === name);
      if (!p) fail(`${where} has no param "${name}"`);
      else if (engineSolved(p))
        fail(`"${name}" is solved by the engine, so a value set for it would be ignored`);
    };
    let at = out;
    for (const seg of segments.slice(0, -2)) {
      const block = at.blocks?.find((b) => b.name === seg);
      if (!block) return fail(`no block "${seg}"`);
      at = docOf(block, true);
    }
    if (segments.length === 1) {
      settable(at, 'the sheet');
      at.params = at.params.map((p) => (p.name === name ? { ...p, value } : p));
      continue;
    }
    const blockName = segments[segments.length - 2];
    const block = at.blocks?.find((b) => b.name === blockName);
    if (!block) return fail(`no block "${blockName}"`);
    settable(docOf(block, false), `block "${blockName}"`);
    block.params = { ...(block.params ?? {}), [name]: String(value) };
  }
  return out;
}

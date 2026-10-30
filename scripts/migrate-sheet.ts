// Migrate a design sheet written before the netlist, and the sheets it includes by reference, to
// format version 2:
//
//   npm run migrate -- <sheet.json> [--blocks <dir>]... [--out <dir>]
//
// Every JSON file under each --blocks folder can be named by a `ref`: by its path from that
// folder's parent without the extension (`blocks/bias` for `<dir>/bias.json` with --blocks
// <...>/blocks), or by its bare name where that is unique. The migrated copies are written under
// --out (default: a `migrated` folder beside the sheet) at the same relative paths, so the copies
// still name each other the way the originals did, beside a report of what to confirm. The
// originals are never touched. The work is the core's (migrateSheet); this file reads and writes.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { migrateSheet, type MigrationSource } from '../src/index';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('usage: npm run migrate -- <sheet.json> [--blocks <dir>]... [--out <dir>]');
  process.exit(2);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
let sheetPath: string | undefined;
const blockDirs: string[] = [];
let outDir: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--blocks') blockDirs.push(args[++i] ?? usage('--blocks needs a folder'));
  else if (a === '--out') outDir = args[++i] ?? usage('--out needs a folder');
  else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else if (sheetPath === undefined) sheetPath = a;
  else usage(`more than one sheet given: ${sheetPath}, ${a}`);
}
if (sheetPath === undefined) usage();

/** A path as a library id: forward slashes, no extension. */
const idOf = (p: string): string =>
  p
    .slice(0, p.length - extname(p).length)
    .split(sep)
    .join('/');

/** Every .json file under `dir`, recursively. */
function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return jsonFiles(p);
    return name.endsWith('.json') ? [p] : [];
  });
}

function read(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const sheetFile = resolve(sheetPath);
const sheetDir = dirname(sheetFile);
const out = resolve(outDir ?? join(sheetDir, 'migrated'));

/** Where each document was read from, by its id, so its copy lands at the same relative path. */
const fileOf = new Map<string, string>();
const top: MigrationSource = { path: idOf(basename(sheetFile)), raw: read(sheetFile) };
fileOf.set(top.path, basename(sheetFile));
const library: MigrationSource[] = blockDirs.flatMap((d) => {
  const root = dirname(resolve(d));
  return jsonFiles(resolve(d))
    .filter((f) => !f.startsWith(out + sep))
    .map((f) => {
      const rel = relative(root, f);
      fileOf.set(idOf(rel), rel);
      return { path: idOf(rel), raw: read(f) };
    });
});

const m = migrateSheet(top, library);
if (m.refused) {
  console.error(m.report);
  process.exit(1);
}
for (const d of m.documents) {
  const file = join(out, fileOf.get(d.path) ?? `${d.path}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(d.doc, null, 2)}\n`);
}
const reportFile = join(out, `${top.path}.migration.txt`);
writeFileSync(reportFile, `${m.report}\n`);
console.log(m.report);
console.log(`\nWritten under ${out} (report: ${relative(process.cwd(), reportFile)})`);

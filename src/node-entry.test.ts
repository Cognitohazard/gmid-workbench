// The README's "Scripting the core" route, run as a reader would run it: build the core, then run
// the README's own examples with plain Node — no TypeScript loader, no bundler. Node's loader does
// not resolve the extensionless imports the sources are written with, so this is the test that
// fails if the build stops emitting something plain Node can import, or if the README's examples
// stop running against it.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateDemoDevice, toMostabCsv } from './demo';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist', 'index.js');

/** The JavaScript code blocks of the README's "Scripting the core" section, in order. */
function scriptingExamples(): string[] {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## Scripting the core');
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe('the core runs under plain Node, as the README says', () => {
  let dir: string;
  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-core.mjs')], { cwd: ROOT });
    dir = mkdtempSync(join(tmpdir(), 'gmid-node-'));
    // A table with every axis the examples name.
    const table = generateDemoDevice({
      vds: { min: 0, max: 1.2, step: 0.1 },
      vsb: { min: 0, max: 0.6, step: 0.3 },
    });
    writeFileSync(join(dir, 'nch_1v8__tt__27C.mostab.csv'), toMostabCsv(table));
    return () => rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('the build writes one module that imports every public name', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const c = await import(${JSON.stringify(pathToFileURL(DIST).href)}); console.log(typeof c.lookup, typeof c.runSheet, typeof c.importMostab);`,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(out.trim()).toBe('function function function');
  });

  it('the first example and the lookup example run as written', () => {
    const blocks = scriptingExamples();
    // The opening example (import a table, run a sheet) and the lookup example, which reads the
    // `table` the first one imported.
    const first = blocks[0];
    const lookupBlock = blocks.find((b) => b.includes('lookupByGmId('));
    expect(first).toContain("from './dist/index.js'");
    expect(lookupBlock).toBeDefined();
    const script = [first, lookupBlock, "console.log('example finished');"]
      .join('\n')
      .replaceAll("'./dist/index.js'", JSON.stringify(pathToFileURL(DIST).href));
    writeFileSync(join(dir, 'example.mjs'), script);
    const out = execFileSync(process.execPath, ['example.mjs'], { cwd: dir, encoding: 'utf8' });
    expect(out).toContain('example finished');
    // The lookup example's clamp report: nothing off the table, so two empty lists.
    expect(out).toContain('[] []');
  });
});

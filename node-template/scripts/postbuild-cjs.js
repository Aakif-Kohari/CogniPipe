/**
 * Writes a package.json into dist/cjs marking that subtree as CommonJS.
 *
 * The package root's package.json declares "type": "module", which Node
 * would otherwise apply to every .js file under this package — including
 * the CommonJS output in dist/cjs, causing it to be parsed as ESM and throw
 * a syntax error on `require`/`module.exports`. A nested package.json wins
 * over the parent's "type" field for anything under dist/cjs, so this runs
 * as a build step right after `tsc -p tsconfig.cjs.json` emits that output.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'dist', 'cjs');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

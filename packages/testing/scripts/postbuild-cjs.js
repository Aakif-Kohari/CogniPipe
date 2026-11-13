import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'dist', 'cjs');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

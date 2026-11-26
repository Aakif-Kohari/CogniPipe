/**
 * @module @cognipipe/node-transform
 *
 * Data transformation node for CogniPipe workflows — JSON pick, CSV parse and
 * text template. Exports the `TransformNode` class, its config and output
 * types, and the pure RFC 4180 CSV tokenizer for standalone use.
 */

export { TransformNode } from './TransformNode.js';
export type { TransformConfig, TransformOutput } from './TransformNode.js';
export { parseCsv } from './csv.js';

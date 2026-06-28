/**
 * @module @cognipipe/core
 *
 * Public entry point for the `@cognipipe/core` package — the CogniPipe workflow
 * execution engine. All stable public APIs are re-exported from this module.
 *
 * Consumers should import directly from this package:
 * ```typescript
 * import { CogniPipeError, COGNIPIPE_ERROR_CODES, isCogniPipeError } from '@cognipipe/core';
 * ```
 *
 * Modules re-exported here:
 * - `errors/CogniPipeError` — {@link CogniPipeError}, {@link CogniPipeErrorOptions}, {@link isCogniPipeError}
 * - `errors/errorCodes`    — {@link COGNIPIPE_ERROR_CODES}, {@link CogniPipeErrorCode}
 */
export { CogniPipeError, isCogniPipeError } from './errors/CogniPipeError';
export type { CogniPipeErrorOptions } from './errors/CogniPipeError';
export { COGNIPIPE_ERROR_CODES } from './errors/errorCodes';
export type { CogniPipeErrorCode } from './errors/errorCodes';

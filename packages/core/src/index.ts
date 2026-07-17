/**
 * @module @cognipipe/core
 *
 * Public entry point for the `@cognipipe/core` package — the CogniPipe workflow
 * execution engine. All stable public APIs are re-exported from this module.
 *
 * Consumers should import directly from this package:
 * ```typescript
 * import { CogniPipeError, COGNIPIPE_ERROR_CODES, isCogniPipeError } from '@cognipipe/core';
 * import { WorkflowValidator, WorkflowConfigSchema } from '@cognipipe/core';
 * import { ExecutionContext, resolveTemplate, resolveDotPath } from '@cognipipe/core';
 * import { WorkflowParser, SUPPORTED_EXTENSIONS } from '@cognipipe/core';
 * import { NodeRegistry } from '@cognipipe/core';
 * ```
 *
 * Modules re-exported here:
 * - `errors/CogniPipeError`  — {@link CogniPipeError}, {@link CogniPipeErrorOptions}, {@link isCogniPipeError}
 * - `errors/errorCodes`      — {@link COGNIPIPE_ERROR_CODES}, {@link CogniPipeErrorCode}
 * - `engine/WorkflowValidator` — {@link WorkflowValidator}
 * - `engine/schemas`         — {@link WorkflowConfigSchema}, {@link StepConfigSchema}, {@link RetryConfigSchema}
 * - `engine/WorkflowParser`  — {@link WorkflowParser}, {@link SUPPORTED_EXTENSIONS}, {@link SupportedExtension}
 * - `engine/ExecutionContext` — {@link ExecutionContext}
 * - `engine/interpolation`    — {@link resolveTemplate}, {@link resolveDotPath}
 * - `engine/NodeRegistry`     — {@link NodeRegistry}, {@link NodeConstructor}
 */
export { CogniPipeError, isCogniPipeError } from './errors/CogniPipeError';
export type { CogniPipeErrorOptions } from './errors/CogniPipeError';
export { COGNIPIPE_ERROR_CODES } from './errors/errorCodes';
export type { CogniPipeErrorCode } from './errors/errorCodes';
export { WorkflowValidator } from './engine/WorkflowValidator';
export { WorkflowConfigSchema, StepConfigSchema, RetryConfigSchema } from './engine/schemas';
export { ExecutionContext } from './engine/ExecutionContext';
export { resolveTemplate, resolveDotPath } from './engine/interpolation';
export { WorkflowParser, SUPPORTED_EXTENSIONS } from './engine/WorkflowParser';
export type { SupportedExtension } from './engine/WorkflowParser';
export { NodeRegistry } from './engine/NodeRegistry';
export type { NodeConstructor } from './engine/NodeRegistry';

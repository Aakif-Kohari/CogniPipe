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
 * import { WorkflowExecutor } from '@cognipipe/core';
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
 * - `engine/WorkflowExecutor` — {@link WorkflowExecutor}, {@link ExecutionResult}, {@link StepError}
 */
export { CogniPipeError, isCogniPipeError } from './errors/CogniPipeError.js';
export type { CogniPipeErrorOptions } from './errors/CogniPipeError.js';
export { COGNIPIPE_ERROR_CODES } from './errors/errorCodes.js';
export type { CogniPipeErrorCode } from './errors/errorCodes.js';
export { WorkflowValidator } from './engine/WorkflowValidator.js';
export { WorkflowConfigSchema, StepConfigSchema, RetryConfigSchema } from './engine/schemas.js';
export { ExecutionContext } from './engine/ExecutionContext.js';
export { resolveTemplate, resolveDotPath } from './engine/interpolation.js';
export { WorkflowParser, SUPPORTED_EXTENSIONS } from './engine/WorkflowParser.js';
export type { SupportedExtension } from './engine/WorkflowParser.js';
export { NodeRegistry } from './engine/NodeRegistry.js';
export type { NodeConstructor } from './engine/NodeRegistry.js';
export { WorkflowExecutor } from './engine/WorkflowExecutor.js';
export type { ExecutionResult, StepError } from './engine/WorkflowExecutor.js';

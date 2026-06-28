/**
 * @module errorCodes
 *
 * Machine-readable error codes for all domain errors thrown by the CogniPipe engine.
 * Always import from `@cognipipe/core` and reference these constants — never use raw
 * string literals — so typos are caught at compile time and codes stay consistent.
 */

/**
 * Exhaustive set of machine-readable error codes used by {@link CogniPipeError}.
 * Always reference these constants — never use raw strings — so typos are
 * caught at compile time and error codes remain consistent across the codebase.
 */
export const COGNIPIPE_ERROR_CODES = {
  // Workflow config / parsing
  WORKFLOW_VALIDATION_ERROR: 'WORKFLOW_VALIDATION_ERROR',
  WORKFLOW_PARSE_ERROR: 'WORKFLOW_PARSE_ERROR',
  // Execution
  STEP_NOT_FOUND: 'STEP_NOT_FOUND',
  NODE_NOT_REGISTERED: 'NODE_NOT_REGISTERED',
  STEP_EXECUTION_FAILED: 'STEP_EXECUTION_FAILED',
  CIRCULAR_DEPENDENCY: 'CIRCULAR_DEPENDENCY',
  // Context / interpolation
  INTERPOLATION_ERROR: 'INTERPOLATION_ERROR',
  CONTEXT_KEY_NOT_FOUND: 'CONTEXT_KEY_NOT_FOUND',
  // Node / plugin lifecycle
  NODE_INSTANTIATION_FAILED: 'NODE_INSTANTIATION_FAILED',
  NODE_CONFIG_INVALID: 'NODE_CONFIG_INVALID',
} as const;

/** Union of all valid CogniPipe error code strings. */
export type CogniPipeErrorCode = (typeof COGNIPIPE_ERROR_CODES)[keyof typeof COGNIPIPE_ERROR_CODES];

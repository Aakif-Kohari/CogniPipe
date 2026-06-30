/**
 * @module workflow.types
 *
 * Defines the top-level structural types for CogniPipe workflow configuration.
 * These types represent the parsed and validated shape of a `workflow.yaml` file
 * and are consumed primarily by `@cognipipe/core` during parsing and execution.
 */

/**
 * Top-level configuration object for a CogniPipe workflow.
 * This is the parsed and validated representation of a `workflow.yaml` file.
 * All fields have been type-checked before this type is used in the engine.
 *
 * @example
 * ```typescript
 * const config: WorkflowConfig = {
 *   name: 'daily-report',
 *   version: '1.0.0',
 *   description: 'Fetches data and posts a daily summary to Slack.',
 *   steps: [
 *     {
 *       name: 'fetch-data',
 *       uses: '@cognipipe/node-http',
 *       config: { url: 'https://api.example.com/data' },
 *     },
 *     {
 *       name: 'post-to-slack',
 *       uses: '@cognipipe/node-slack',
 *       config: { channel: '#reports' },
 *       dependsOn: ['fetch-data'],
 *     },
 *   ],
 * };
 * ```
 */
export interface WorkflowConfig {
  /** Human-readable name of the workflow. Used in logs and error messages. */
  name: string;
  /**
   * Semantic version of the workflow schema (e.g. `"1.0.0"`).
   * The engine rejects workflows whose major version is incompatible
   * with the installed engine version.
   */
  version: string;
  /** Optional description shown in `cognipipe list`. */
  description?: string;
  /**
   * Ordered list of execution steps. Steps may declare `dependsOn` to
   * express dependencies and enable parallel execution.
   */
  steps: StepConfig[];
}

/**
 * Configuration for a single step within a {@link WorkflowConfig}.
 * Each step maps to exactly one registered CogniPipe node and carries
 * all the information the engine needs to execute and wire it up.
 *
 * @example
 * ```typescript
 * const step: StepConfig = {
 *   name: 'fetch-user',
 *   uses: '@cognipipe/node-http',
 *   config: {
 *     url: 'https://api.example.com/users/1',
 *     method: 'GET',
 *   },
 *   dependsOn: ['auth-step'],
 *   continueOnError: false,
 *   retry: {  attempts: 3,  delayMs: 500, backoff: 'exponential' },
 * };
 * ```
 */
export interface StepConfig {
  /**
   * Unique identifier for this step within the workflow.
   * Used as the key under the reserved `steps` namespace, where each entry is a {@link StepResult}, within an {@link IExecutionContext}.
   */
  name: string;
  /**
   * The fully-qualified node type to execute, e.g. `'@cognipipe/node-http'`.
   * Must match a type registered in the NodeRegistry before workflow execution begins.
   */
  uses: string;
  /** Node-specific configuration object passed directly to the node's `execute()` method. */
  config: Record<string, unknown>;
  /**
   * Optional list of step names that must complete successfully before this step runs.
   * Steps without `dependsOn` (or with no blocking predecessors) may run in parallel.
   */
  dependsOn?: string[];
  /**
   * When `true`, the workflow continues even if this step throws or returns an error.
   * The failed step's result is still recorded in the {@link IExecutionContext}.
   * When omitted, the engine applies its own default (expected: `false`).
   */
  continueOnError?: boolean;
  /**
   * Optional retry policy for this step.
   * When omitted, the step is attempted exactly once with no retries.
   */
  retry?: RetryConfig;
}

/**
 * Retry policy applied to a single {@link StepConfig} on failure.
 * The validator ensures retry values fall within the supported range.
 */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts after the initial failure.
   * Minimum 1, maximum 10.
   */
  attempts: number;

  /**
   * Delay in milliseconds before each retry.
   * Minimum 0.
   */
  delayMs: number;

  /**
   * Retry back-off strategy.
   * Defaults to a constant delay when omitted.
   */
  backoff?: 'linear' | 'exponential';
}

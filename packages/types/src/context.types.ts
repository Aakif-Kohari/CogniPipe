/**
 * @module context.types
 *
 * Defines the read/write contract for CogniPipe's execution context — the
 * data carrier threaded through every step of a workflow run. The concrete,
 * immutable implementation lives in `@cognipipe/core` as `ExecutionContext`.
 */

/**
 * The read/write contract for CogniPipe's execution context.
 * All mutating methods return new instances — implementations must be immutable.
 *
 * The canonical usage pattern is `{{ steps.<step-name>.<dot.path> }}` where
 * `steps` is the reserved namespace key the executor writes all step outputs into,
 * and `<step-name>` is the `name` field from a step's WorkflowConfig entry.
 */
export interface IExecutionContext {
  /** Retrieves a stored value by key, or `undefined` if the key is absent. */
  get(key: string): unknown;

  /**
   * Returns a NEW IExecutionContext with the given key set to `value`.
   * The original instance is NOT mutated.
   */
  set(key: string, value: unknown): IExecutionContext;

  /** Returns `true` if the given key exists in the context store. */
  has(key: string): boolean;

  /**
   * Resolves all `{{ expression }}` tokens in `template` against the stored data.
   * Expressions follow the format `{{ steps.<step-name>.<dot.path> }}`.
   *
   * @throws {CogniPipeError} INTERPOLATION_ERROR if any expression cannot be resolved.
   *
   * @example
   * ```typescript
   * // After step "fetch-issues" runs and its output is stored:
   * ctx.interpolate('Found {{ steps.fetch-issues.output.count }} open issues');
   * // → 'Found 42 open issues'
   * ```
   */
  interpolate(template: string): string;

  /** Returns a plain-object snapshot of the entire store, suitable for logging. */
  toJSON(): Record<string, unknown>;
}

/**
 * The result produced by a workflow step and stored in the execution context.
 *
 * Workflow executors should store these objects under the reserved
 * `steps` namespace using the step name as the key.
 */
export interface StepResult {
  /** Output (Record<string, unknown>) returned by the node's `execute()` method. */
  output: Record<string, unknown>;
  /** ISO 8601 timestamp of when the step finished (success or handled failure). */
  completedAt: string;
  /** Wall-clock duration of the step execution in milliseconds. */
  durationMs: number;
  /** Returns a plain-object snapshot of the entire store, suitable for logging. */
  toJSON(): Record<string, unknown>;
}

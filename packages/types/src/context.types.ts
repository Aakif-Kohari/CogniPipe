/**
 * @module context.types
 *
 * Defines the execution context and step result types that act as the data
 * carrier between nodes during a workflow run. The {@link ExecutionContext} is
 * created once per workflow execution and threaded through every step so that
 * each node can read the outputs of its predecessors.
 */

/**
 * The execution context passed between nodes during a workflow run.
 * Created by `WorkflowExecutor` at the start of each run and updated
 * after every step completes. Nodes receive this as their second argument
 * and may read (but must not mutate) the `steps` map.
 */
export interface ExecutionContext {
  /**
   * Workflow-level metadata injected at the start of the run.
   * Useful for logging and tracing within nodes.
   */
  workflow: {
    /** The `name` field from the originating {@link WorkflowConfig}. */
    name: string;
    /** ISO 8601 timestamp of when the workflow execution began. */
    startedAt: string;
  };
  /**
   * Outputs from all completed steps, keyed by step name.
   * A step can read the output of a predecessor via `context.steps['step-name'].output`.
   * Steps are added to this map as they complete; only finished steps are present.
   */
  steps: Record<string, StepResult>;
}

/**
 * The result recorded in {@link ExecutionContext.steps} after a step finishes.
 * Captured by `WorkflowExecutor` immediately after a node's `execute()` call
 * returns and stored for downstream steps and audit logging.
 */
export interface StepResult {
  /** The {@link NodeOutput} returned by the node's `execute()` method. */
  output: Record<string, unknown>;
  /** ISO 8601 timestamp of when the step finished (success or handled failure). */
  completedAt: string;
  /** Wall-clock duration of the step execution in milliseconds. */
  durationMs: number;
}

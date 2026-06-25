/** The execution context passed between nodes */
export interface ExecutionContext {
  /** Workflow-level metadata */
  workflow: {
    name: string;
    startedAt: string;
  };
  /** Outputs from completed steps, keyed by step name */
  steps: Record<string, StepResult>;
}

/** The result stored in context after a step completes */
export interface StepResult {
  output: Record<string, unknown>;
  completedAt: string;
  durationMs: number;
}

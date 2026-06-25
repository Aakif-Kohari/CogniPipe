/** A complete workflow configuration parsed from workflow.yaml */
export interface WorkflowConfig {
  /** Display name of the workflow */
  name: string;
  /** Optional description */
  description?: string;
  /** Ordered list of steps to execute */
  steps: StepConfig[];
}

/** A single step in a workflow */
export interface StepConfig {
  /** Unique identifier for this step within the workflow */
  name: string;
  /** The node type to use, e.g. '@cognipipe/node-http' */
  uses: string;
  /** Node-specific configuration object */
  config: Record<string, unknown>;
  /** Step names this step depends on (for parallel execution) */
  dependsOn?: string[];
  /** Continue workflow even if this step fails */
  continueOnError?: boolean;
  /** Retry configuration */
  retry?: RetryConfig;
}

/** Retry configuration for a step */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
}

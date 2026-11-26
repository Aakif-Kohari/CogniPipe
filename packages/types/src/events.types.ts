/**
 * @module events.types
 *
 * Typed contracts for CogniPipe's live workflow execution events. Emitted by
 * `WorkflowExecutor` in `@cognipipe/core` (see its `on()` / `off()` methods)
 * so observers — loggers, progress UIs, metrics — can follow a run step by
 * step without waiting for `run()` to finish.
 *
 * Every started step emits exactly one terminal event: `step:complete` on
 * success, `step:error` on failure (including `continueOnError` failures).
 * Listeners are strictly observational and a listener can never fail or alter
 * a run.
 */

/**
 * Emitted once per step, right after its node is instantiated and before
 * config interpolation / `beforeExecute()`. Never re-emitted on retries.
 * A step that never starts (upfront validation failure, fatal failure
 * elsewhere, or a fatally-failed dependency) emits no events at all.
 */
export interface StepStartEvent {
  /** The running workflow's `name` (from its WorkflowConfig). */
  workflowName: string;
  /** The step's `name` — unique within the workflow. */
  stepName: string;
  /** The step's `uses` value: the registered node type string. */
  uses: string;
  /** ISO 8601 timestamp of when the step started. */
  startedAt: string;
}

/**
 * Emitted after the step's `afterExecute()` succeeds — i.e. after its result
 * has been written to the execution context. A step whose `afterExecute()`
 * throws emits `step:error` instead, never `step:complete`.
 */
export interface StepCompleteEvent {
  /** The running workflow's `name` (from its WorkflowConfig). */
  workflowName: string;
  /** The step's `name` — unique within the workflow. */
  stepName: string;
  /** The step's `uses` value: the registered node type string. */
  uses: string;
  /**
   * The node's output — the same object stored in the context under
   * `steps.<stepName>.output`. Typed read-only: listeners must not mutate it.
   */
  output: Readonly<Record<string, unknown>>;
  /** Identical to the stored {@link StepResult.durationMs} (execute loop, including retry delays). */
  durationMs: number;
  /** Identical to the stored {@link StepResult.retryCount}. */
  retryCount: number;
  /** ISO 8601 timestamp of completion — identical to the stored {@link StepResult.completedAt}. */
  completedAt: string;
}

/**
 * Emitted for any failure inside the step's execution: config interpolation,
 * `beforeExecute()`, `execute()` after retries are exhausted, or
 * `afterExecute()`. For fatal failures it arrives before `run()` rejects;
 * for `continueOnError` failures the workflow carries on.
 */
export interface StepErrorEvent {
  /** The running workflow's `name` (from its WorkflowConfig). */
  workflowName: string;
  /** The step's `name` — unique within the workflow. */
  stepName: string;
  /** The step's `uses` value: the registered node type string. */
  uses: string;
  /**
   * The ORIGINAL error thrown inside the step — never the
   * STEP_EXECUTION_FAILED wrapper that `run()` rejects with.
   */
  error: Error;
  /** True when the step has `continueOnError: true` (the workflow carries on). */
  continued: boolean;
  /** Milliseconds elapsed since this step's `step:start`. */
  durationMs: number;
  /** ISO 8601 timestamp of when the step failed. */
  failedAt: string;
}

/** Maps each execution event name to its payload type. */
export interface ExecutionEventMap {
  'step:start': StepStartEvent;
  'step:complete': StepCompleteEvent;
  'step:error': StepErrorEvent;
}

/** Union of all execution event names: `'step:start' | 'step:complete' | 'step:error'`. */
export type ExecutionEventName = keyof ExecutionEventMap;

/**
 * A listener for a single execution event. May be synchronous or async.
 * Async listeners are never awaited by the executor; a synchronous throw or
 * an async rejection is reported via
 * `process.emitWarning(message, 'CogniPipeListenerWarning')` and can never
 * fail or alter the workflow run. A synchronous listener runs inline, so keep
 * it fast.
 */
export type ExecutionEventListener<K extends ExecutionEventName> = (
  event: ExecutionEventMap[K],
) => void | Promise<void>;

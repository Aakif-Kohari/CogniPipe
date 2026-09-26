/**
 * @module WorkflowExecutor
 *
 * Runs a validated WorkflowConfig using a DAG-based scheduler. For each step it
 * instantiates the node via NodeRegistry, resolves `{{ }}` expressions in the
 * step's config against ExecutionContext, calls the node's lifecycle hooks and
 * execute() method, and accumulates the step's output in the context under the
 * reserved `steps` namespace.
 *
 * Steps with no unmet `dependsOn` entries run concurrently. A step becomes
 * eligible to run once every entry in its `dependsOn` array has completed —
 * successfully, or, if that dependency had `continueOnError: true`,
 * unsuccessfully. Cycle detection (`dag.ts`) runs as an upfront pass before
 * any step executes or any node is instantiated.
 */

import type {
  WorkflowConfig,
  StepConfig,
  NodeConfig,
  NodeOutput,
  RetryConfig,
  StepResult,
} from '@cognipipe/types';
import { ExecutionContext } from './ExecutionContext.js';
import { NodeRegistry } from './NodeRegistry.js';
import { detectCycles } from './dag.js';
import { CogniPipeError } from '../errors/CogniPipeError.js';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes.js';

/**
 * Details of a step that failed but was allowed to continue because
 * the step had `continueOnError: true`.
 */
export interface StepError {
  /** The `name` of the step that failed. */
  stepName: string;
  /** The error thrown while running the step (config interpolation, beforeExecute(), or execute()). */
  error: CogniPipeError | Error;
}

/**
 * The structured output of a completed workflow run.
 */
export interface ExecutionResult {
  /** The final ExecutionContext after all steps have run. */
  context: ExecutionContext;
  /**
   * Errors from steps that failed but had `continueOnError: true`.
   * Empty array when all steps succeeded.
   */
  stepErrors: StepError[];
}

/**
 * A step's completion signal in the DAG scheduler. Every step gets one of
 * these, created up front (see `run()`), independent of when its own
 * dependencies resolve. `resolve()` is called once the step finishes
 * (successfully, or unsuccessfully with `continueOnError: true`); `reject()`
 * is called if the step — or one of its own transitive dependencies — fails
 * fatally, so nothing downstream of it ever starts.
 */
interface StepCompletion {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Recursively walks a config object and calls `ctx.interpolate()` on every
 * string value. Numbers, booleans, arrays, and nested objects are traversed
 * but non-string leaf values are passed through unchanged. Arrays are walked
 * element by element.
 *
 * Implemented as a module-level function (not a class method) because it has
 * no dependency on WorkflowExecutor instance state.
 *
 * @param config - The step's raw config object (may contain `{{ }}` tokens).
 * @param ctx - The ExecutionContext to resolve expressions against.
 * @returns A new config object with every string leaf interpolated.
 * @throws {CogniPipeError} INTERPOLATION_ERROR if any `{{ }}` expression
 *   cannot be resolved (propagates from `ctx.interpolate()`).
 */
function interpolateConfig(config: NodeConfig, ctx: ExecutionContext): NodeConfig {
  return interpolateValue(config, ctx) as NodeConfig;
}

/**
 * Recursive helper for {@link interpolateConfig}. Operates on `unknown`
 * because array elements and nested object values are not known to be
 * `NodeConfig` themselves — only the top-level call is.
 */
function interpolateValue(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === 'string') {
    return ctx.interpolate(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => interpolateValue(item, ctx));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = interpolateValue(nestedValue, ctx);
    }
    return result;
  }

  // Numbers, booleans, null, undefined — pass through unchanged.
  return value;
}

/**
 * Resolves after `ms` milliseconds. Placed at module level (not a class
 * method) so tests can spy on it or use `jest.useFakeTimers()` to advance
 * time without waiting on real delays.
 *
 * @param ms - Milliseconds to wait before resolving.
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Computes the delay in milliseconds before the next retry attempt.
 *
 * Implemented as a module-level function (not a class method) because it
 * has no dependency on WorkflowExecutor instance state.
 *
 * @param retry - The step's retry config. Callers pass `step.retry!` since
 *   this is only invoked once a retry has already been determined to apply.
 * @param attemptIndex - Zero-based index of the attempt that just FAILED
 *   (0 = first attempt failed, 1 = second attempt failed, ...).
 * @returns The delay in milliseconds before the next attempt.
 *   For `'linear'` (or omitted) backoff: a constant `retry.delayMs` every time.
 *   For `'exponential'` backoff: `retry.delayMs * 2 ** attemptIndex`.
 */
function computeBackoffDelay(retry: RetryConfig, attemptIndex: number): number {
  const base = retry.delayMs;
  if (retry.backoff === 'exponential') {
    return base * Math.pow(2, attemptIndex);
  }
  return base; // 'linear' or undefined — constant delay.
}

/**
 * Runs a validated WorkflowConfig using a DAG-based scheduler.
 * For each step: instantiates the node, interpolates config, calls lifecycle hooks,
 * stores the output in context, and moves on once its dependents become ready.
 *
 * @example
 * ```typescript
 * const registry = new NodeRegistry();
 * registry.register('@cognipipe/node-http', HttpNode);
 *
 * const parser = new WorkflowParser();
 * const validator = new WorkflowValidator();
 * const executor = new WorkflowExecutor(registry);
 *
 * const raw = await parser.parseFile('./workflow.yaml');
 * const config = validator.validate(raw);
 * const result = await executor.run(config);
 *
 * console.log(result.context.toJSON());
 * ```
 */
export class WorkflowExecutor {
  readonly #registry: NodeRegistry;

  /**
   * @param registry - The NodeRegistry containing all node constructors needed
   *   by the workflow being executed.
   */
  constructor(registry: NodeRegistry) {
    this.#registry = registry;
  }

  /**
   * Executes a validated workflow config using DAG-based parallel scheduling.
   * Steps with no unmet `dependsOn` entries run concurrently; a step waits for
   * every entry in its own `dependsOn` to complete before it starts.
   *
   * @param config - A fully validated WorkflowConfig (output of WorkflowValidator.validate()).
   * @param initial - Optional seed data to pre-populate the ExecutionContext before
   *   the first step runs. Useful for injecting runtime values (e.g. trigger payload).
   * @returns An ExecutionResult containing the final context and any step errors.
   * @throws {CogniPipeError} NODE_NOT_REGISTERED if any step's `uses` is not in the registry.
   *   Thrown before any step executes, during the upfront node validation pass.
   * @throws {CogniPipeError} CIRCULAR_DEPENDENCY if the workflow contains a cyclic dependsOn graph.
   *   Thrown before any step executes or any node is instantiated.
   * @throws {CogniPipeError} STEP_EXECUTION_FAILED if a step throws and `continueOnError` is
   *   not true. Any step elsewhere in the graph still in flight is allowed to settle before
   *   this rejects, so a fatal failure in one branch never leaves an unrelated branch's
   *   context write half-applied.
   */
  async run(config: WorkflowConfig, initial?: Record<string, unknown>): Promise<ExecutionResult> {
    // 1. Upfront validation: every step's `uses` must be registered BEFORE any
    // step runs. This is the most important correctness property of the
    // executor — a typo in a later step must not leave earlier steps' side
    // effects (e.g. an HTTP call, a Slack message) partially applied.
    for (const step of config.steps) {
      if (!this.#registry.has(step.uses)) {
        throw new CogniPipeError(
          `Step "${step.name}" uses "${step.uses}", which is not registered in the NodeRegistry. ` +
            `Register it with registry.register('${step.uses}', YourNodeClass) before running the workflow.`,
          {
            code: COGNIPIPE_ERROR_CODES.NODE_NOT_REGISTERED,
            context: { stepName: step.name, uses: step.uses },
          },
        );
      }
    }

    // cycle detection, also upfront, before any node instantiation or scheduling
    const cycles = detectCycles(config.steps);
    if (cycles.length > 0) {
      throw new CogniPipeError(
        `Workflow "${config.name}" has a circular dependency: ${cycles[0]}`,
        { code: COGNIPIPE_ERROR_CODES.CIRCULAR_DEPENDENCY, context: { cycles } },
      );
    }

    // 2. Seed the context and prepare the accumulator for continueOnError failures.
    let ctx = new ExecutionContext(initial ?? {});
    const stepErrors: StepError[] = [];

    // Serializes ExecutionContext writes. `ExecutionContext.set()` returns a
    // brand-new instance rather than mutating in place, so two steps
    // finishing at (effectively) the same time could otherwise each read the
    // same prior `ctx`, compute their own next value from it, and overwrite
    // one another — a lost update, not a merge. Chaining every write onto
    // `writeQueue` forces them to apply one at a time, each reading whatever
    // the previous write in the queue left behind.
    let writeQueue: Promise<void> = Promise.resolve();
    const scheduleContextWrite = (
      stepName: string,
      result: StepResult,
    ): Promise<ExecutionContext> => {
      const nextQueue = writeQueue.then(() => {
        const rawPriorSteps = ctx.get('steps');
        const priorSteps =
          rawPriorSteps !== null &&
          typeof rawPriorSteps === 'object' &&
          !Array.isArray(rawPriorSteps)
            ? (rawPriorSteps as Record<string, unknown>)
            : {};
        ctx = ctx.set('steps', { ...priorSteps, [stepName]: result });
      });
      writeQueue = nextQueue;
      return nextQueue.then(() => ctx);
    };

    // 3. Create one completion signal per step, up front, for EVERY step
    // before any dependency logic is wired up below. This is what lets a
    // step's `dependsOn` name a step declared LATER in `config.steps` —
    // `dependsOn` refers to a step by name, not by array position, and
    // neither WorkflowValidator nor detectCycles requires declaration order
    // to match dependency order. Building this map lazily (inside the loop
    // that wires up dependencies) would make `completions.get(dep)` return
    // `undefined` for any dependency declared after its dependent.
    const completions = new Map<string, StepCompletion>();
    for (const step of config.steps) {
      let resolve!: () => void;
      let reject!: (err: unknown) => void;
      // The Promise executor callback runs synchronously, so `resolve` and
      // `reject` are always assigned before the constructor returns.
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A step's completion is only ever *read* by a dependent that names it
      // in `dependsOn`. A fatally-failing step with no dependents (the last
      // step in the array, or any independent branch) still calls reject()
      // on this promise, and with nothing subscribed to it that would
      // otherwise surface as an unhandled promise rejection — a Node-level
      // warning unrelated to this step's own, already-propagated failure.
      // This no-op handler only marks the promise "handled" for Node's
      // bookkeeping; it does not consume it — every other `.then()` /
      // `.catch()` attached to it below and in the dependents' `Promise.all`
      // still observes the same rejection independently.
      promise.catch(() => {});
      completions.set(step.name, { promise, resolve, reject });
    }

    // 4. Launch every step's execution chain concurrently. Each chain waits
    // for its own `dependsOn` completions, runs the step via `#runStep()`,
    // and settles its own completion signal so dependents can proceed.
    let fatalError: unknown;

    const chains = config.steps.map(step => {
      const deps = step.dependsOn ?? [];
      // A `dependsOn` entry naming a step that doesn't exist in `config.steps`
      // is a dangling reference. Neither WorkflowValidator nor detectCycles
      // treats that as an error (see dag.ts) — it's out of scope for this
      // scheduler too, so it's treated as already-satisfied rather than
      // leaving the step waiting on a completion signal that would never
      // arrive.
      const readyPromise = Promise.all(
        deps.map(dep => completions.get(dep)?.promise ?? Promise.resolve()),
      );

      return readyPromise.then(
        async () => {
          // Guaranteed to exist: every step's completion signal was created
          // in the loop above, over this same `config.steps` array.
          const completion = completions.get(step.name)!;
          if (fatalError !== undefined) {
            // A fatal failure elsewhere already occurred; do not start new work.
            // This ensures steps waiting on slow dependencies never start their
            // side effects (e.g. HTTP calls) once the workflow is already doomed.
            completion.reject(fatalError);
            throw fatalError;
          }
          try {
            const stepError = await this.#runStep(step, ctx, scheduleContextWrite);
            if (stepError !== undefined) {
              stepErrors.push(stepError);
            }
            completion.resolve();
          } catch (err) {
            if (fatalError === undefined) {
              fatalError = err;
            }
            completion.reject(err);
            throw err;
          }
        },
        (depErr: unknown) => {
          // A dependency (or one of ITS dependencies) failed fatally, so this
          // step is never attempted. Reject this step's own completion too,
          // propagating the failure through the rest of its dependent subtree
          // instead of leaving them waiting forever.
          completions.get(step.name)!.reject(depErr);
          throw depErr;
        },
      );
    });

    // allSettled (not all) so a fatal failure in one branch doesn't stop us
    // from waiting for every OTHER, unrelated branch to finish running and
    // flush its own context write.
    await Promise.allSettled(chains);
    await writeQueue;

    if (fatalError !== undefined) {
      throw fatalError;
    }

    // 5. Return the final context and any accumulated step errors.
    return { context: ctx, stepErrors };
  }

  /**
   * Executes a single step: instantiate → interpolate → beforeExecute →
   * execute (with retry) → store result → afterExecute.
   *
   * @param step - The step to execute.
   * @param ctx - The ExecutionContext as of the moment every entry in this
   *   step's `dependsOn` has completed. Read once at the start and used for
   *   interpolation, `beforeExecute`, and every retry attempt of `execute` —
   *   matching the sequential executor, a step's own view of the context
   *   never shifts mid-execution just because a sibling branch wrote to it.
   * @param scheduleContextWrite - Serialized context-write queue (see `run()`).
   *   Returns the ExecutionContext as of immediately after this step's own
   *   write is applied, so `afterExecute` sees this step's own result.
   * @returns `undefined` on success. A {@link StepError} if the step failed
   *   and `continueOnError` is `true` — the caller is responsible for pushing
   *   it into the shared `stepErrors` accumulator. Throws directly for a
   *   fatal (non-`continueOnError`) failure.
   */
  async #runStep(
    step: StepConfig,
    ctx: ExecutionContext,
    scheduleContextWrite: (stepName: string, result: StepResult) => Promise<ExecutionContext>,
  ): Promise<StepError | undefined> {
    // Node instantiation is deliberately kept OUTSIDE the try/catch below.
    // The upfront `registry.has()` pass in run() already guarantees `step.uses`
    // is registered, so instantiate() only fails on a broken node constructor
    // (NODE_INSTANTIATION_FAILED) — a setup/wiring bug distinct from a step
    // *execution* failure, so it is not eligible for continueOnError and is
    // not re-wrapped as STEP_EXECUTION_FAILED.
    const node = this.#registry.instantiate(step.uses);

    try {
      // Config interpolation and beforeExecute() are inside this try block
      // because interpolation failures must propagate as STEP_EXECUTION_FAILED,
      // and a failing precondition check in beforeExecute() should respect
      // `continueOnError` the same way execute() failures do.
      const resolvedConfig = interpolateConfig(step.config, ctx);

      if (node.beforeExecute !== undefined) {
        await node.beforeExecute(resolvedConfig, ctx);
      }

      // Retry loop. `maxAttempts` is 1 when `step.retry` is absent, so an
      // unconfigured step always takes exactly this same single pass —
      // retry is entirely opt-in. `startTime` is captured before the loop
      // so `durationMs` below reflects total wall-clock time across every
      // attempt plus every inter-attempt delay, not just the final attempt.
      const startTime = Date.now();
      const maxAttempts = step.retry?.attempts ?? 1;
      let attemptIndex = 0;
      let output: NodeOutput;
      while (true) {
        try {
          output = await node.execute(resolvedConfig, ctx);
          break;
        } catch (attemptErr) {
          if (attemptIndex + 1 >= maxAttempts) {
            // Retries exhausted (or none configured) — rethrow so the
            // outer catch below handles continueOnError / STEP_EXECUTION_FAILED.
            throw attemptErr;
          }
          // step.retry is guaranteed defined here: this branch only runs
          // when attemptIndex + 1 < maxAttempts, which is only possible
          // when maxAttempts > 1 — and maxAttempts defaults to 1 exactly
          // when step.retry is undefined. So reaching this line implies
          // step.retry was set.
          const delay = computeBackoffDelay(step.retry!, attemptIndex);
          await sleep(delay);
          attemptIndex++;
        }
      }
      const durationMs = Date.now() - startTime;

      const stepResult: StepResult = {
        output,
        completedAt: new Date().toISOString(),
        durationMs,
        retryCount: attemptIndex,
      };

      // Serialized through run()'s write queue so a concurrently-completing
      // sibling step's own read-modify-write of `steps` can never race with
      // this one. Resolves to the context AS OF right after this write, which
      // is what afterExecute() below is given.
      const nextCtx = await scheduleContextWrite(step.name, stepResult);

      if (node.afterExecute !== undefined) {
        await node.afterExecute(output, nextCtx);
      }

      return undefined;
    } catch (err) {
      if (step.continueOnError === true) {
        // Do NOT store a StepResult for a failed step — downstream steps that
        // try to interpolate this step's output will throw INTERPOLATION_ERROR,
        // which is intentional and informative.
        return {
          stepName: step.name,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }

      throw new CogniPipeError(
        `Step "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { stepName: step.name, uses: step.uses },
          cause: err instanceof Error ? err : undefined,
        },
      );
    }
  }
}

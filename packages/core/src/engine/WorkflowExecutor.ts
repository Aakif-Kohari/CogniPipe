/**
 * @module WorkflowExecutor
 *
 * Runs a validated WorkflowConfig sequentially, step by step. For each step it
 * instantiates the node via NodeRegistry, resolves `{{ }}` expressions in the
 * step's config against ExecutionContext, calls the node's lifecycle hooks and
 * execute() method, and accumulates the step's output in the context under the
 * reserved `steps` namespace.
 *
 * This module scopes sequential execution only — parallel execution via DAG
 * (using `StepConfig.dependsOn`) is a separate future issue.
 */

import type { WorkflowConfig, StepConfig, NodeConfig } from '@cognipipe/types';
import { ExecutionContext } from './ExecutionContext';
import { NodeRegistry } from './NodeRegistry';
import { CogniPipeError } from '../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes';

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
 * Runs a validated WorkflowConfig sequentially, step by step.
 * For each step: instantiates the node, interpolates config, calls lifecycle hooks,
 * stores the output in context, and moves to the next step.
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
   * Executes a validated workflow config sequentially.
   * Steps run in array order. Steps with `dependsOn` declared are still run
   * in array order in this implementation — parallel DAG execution is a
   * separate future issue.
   *
   * @param config - A fully validated WorkflowConfig (output of WorkflowValidator.validate()).
   * @param initial - Optional seed data to pre-populate the ExecutionContext before
   *   the first step runs. Useful for injecting runtime values (e.g. trigger payload).
   * @returns An ExecutionResult containing the final context and any step errors.
   * @throws {CogniPipeError} NODE_NOT_REGISTERED if any step's `uses` is not in the registry.
   *   Thrown before any step executes, during the upfront node validation pass.
   * @throws {CogniPipeError} STEP_EXECUTION_FAILED if a step throws and `continueOnError` is
   *   not true.
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

    // 2. Seed the context and prepare the accumulator for continueOnError failures.
    let ctx = new ExecutionContext(initial ?? {});
    const stepErrors: StepError[] = [];

    // 3. Run each step in sequential array order.
    for (const step of config.steps) {
      ctx = await this.#runStep(step, ctx, stepErrors);
    }

    // 4. Return the final context and any accumulated step errors.
    return { context: ctx, stepErrors };
  }

  /**
   * Executes a single step: instantiate → interpolate → beforeExecute →
   * execute → store result → afterExecute. On failure, either records a
   * StepError (continueOnError) or throws STEP_EXECUTION_FAILED.
   *
   * @param step - The step to execute.
   * @param ctx - The context as of immediately before this step runs.
   * @param stepErrors - The shared accumulator array for continueOnError failures.
   * @returns The context after this step completes (unchanged if the step failed).
   */
  async #runStep(
    step: StepConfig,
    ctx: ExecutionContext,
    stepErrors: StepError[],
  ): Promise<ExecutionContext> {
    // Node instantiation is deliberately kept OUTSIDE the try/catch below.
    // The upfront `registry.has()` pass in run() already guarantees `step.uses`
    // is registered, so instantiate() only fails on a broken node constructor
    // (NODE_INSTANTIATION_FAILED) — a setup/wiring bug distinct from a step
    // *execution* failure, so it is not eligible for continueOnError and is
    // not re-wrapped as STEP_EXECUTION_FAILED.
    const node = this.#registry.instantiate(step.uses);

    try {
      // Config interpolation and beforeExecute() are inside this try block
      // (not strictly outside it as a literal reading of the issue's
      // pseudocode step ordering might suggest) because the issue's own
      // required test case says otherwise: "interpolateConfig throws
      // INTERPOLATION_ERROR ... this propagates as STEP_EXECUTION_FAILED."
      // That is only possible if interpolation happens inside this try/catch.
      // Keeping beforeExecute here too means a failing precondition check
      // correctly respects `continueOnError`, same as execute() failures.
      const resolvedConfig = interpolateConfig(step.config, ctx);

      if (node.beforeExecute !== undefined) {
        await node.beforeExecute(resolvedConfig, ctx);
      }

      const startTime = Date.now();
      const output = await node.execute(resolvedConfig, ctx);
      const durationMs = Date.now() - startTime;

      // `ctx.get('steps')` is typed `unknown` because ExecutionContext's store
      // is a generic key-value map. The cast is safe here because the
      // executor is the only writer of the `steps` key, and it always writes
      // a `Record<string, StepResult>` (see the `ctx.set('steps', ...)` call
      // below) — so any prior value under this key is guaranteed to already
      // have that shape.
      const rawPriorSteps = ctx.get('steps');
      const priorSteps =
        rawPriorSteps !== null && typeof rawPriorSteps === 'object' && !Array.isArray(rawPriorSteps)
          ? (rawPriorSteps as Record<string, unknown>)
          : {};

      const nextCtx = ctx.set('steps', {
        ...priorSteps,
        [step.name]: { output, completedAt: new Date().toISOString(), durationMs },
      });

      if (node.afterExecute !== undefined) {
        await node.afterExecute(output, nextCtx);
      }

      return nextCtx;
    } catch (err) {
      if (step.continueOnError === true) {
        stepErrors.push({
          stepName: step.name,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        // Do NOT store a StepResult for a failed step — downstream steps that
        // try to interpolate this step's output will throw INTERPOLATION_ERROR,
        // which is intentional and informative.
        return ctx;
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

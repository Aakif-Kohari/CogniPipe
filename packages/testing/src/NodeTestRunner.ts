/**
 * @module NodeTestRunner
 *
 * Runs a single CogniPipe node through the same lifecycle `WorkflowExecutor`
 * uses — interpolate config, `beforeExecute()`, `execute()`, `afterExecute()` —
 * without the engine. Replaces the scaffolding every node test used to hand-roll:
 * an inline `IExecutionContext` mock, manual `process.env` juggling, a
 * `global.fetch = jest.fn()` assignment and manual hook calls.
 *
 * @cognipipe/testing must not depend on @cognipipe/core, so config walking and
 * error handling are implemented locally. Interpolation failures therefore come
 * from {@link MockContext} and are plain `Error`s, never `CogniPipeError`s;
 * consumers who need a `CogniPipeError` assert on it themselves via
 * `@cognipipe/core`.
 */

import type { IBaseNode, NodeConfig, NodeOutput } from '@cognipipe/types';
import { MockContext } from './MockContext.js';

/** Names of the lifecycle methods a node run can invoke, in executor order. */
export type NodeLifecycleCall = 'beforeExecute' | 'execute' | 'afterExecute';

/** Per-run isolation options for {@link NodeTestRunner.run}. */
export interface NodeTestRunnerOptions {
  /** Seed data for the MockContext, e.g. `{ steps: { auth: { output: { token: 'abc' } } } }`. */
  context?: Record<string, unknown>;
  /** Env vars set for the duration of the run, then restored. A value of `undefined` ensures the var is unset. */
  env?: Record<string, string | undefined>;
  /** Replaces `globalThis.fetch` for the duration of the run, then restores the original. */
  fetch?: typeof globalThis.fetch;
  /** Resolve `{{ }}` in every string leaf of `config` via the MockContext, like WorkflowExecutor. Default true. */
  interpolate?: boolean;
}

interface NodeTestRunBase {
  /** Lifecycle methods that were INVOKED, in order (a hook that threw is still listed). */
  calls: NodeLifecycleCall[];
  durationMs: number;
  /** The seeded MockContext used for the run. */
  context: MockContext;
}

/**
 * The outcome of one {@link NodeTestRunner.run}. Narrow on `ok`:
 * success carries the node's `output`; failure carries the exact value
 * that was thrown as `error`. `resolvedConfig` is `undefined` on failure only
 * when the node could not be constructed or config interpolation failed.
 */
export type NodeTestRunResult =
  | (NodeTestRunBase & { ok: true; output: NodeOutput; resolvedConfig: NodeConfig })
  | (NodeTestRunBase & { ok: false; error: unknown; resolvedConfig: NodeConfig | undefined });

const OVERLAP_ERROR_MESSAGE =
  'NodeTestRunner: runs that use the "env" or "fetch" option cannot overlap, because they mutate ' +
  'process-wide state. Await the previous run() before starting another one, or drop the ' +
  'overrides from one of them.';

/**
 * Mirrors the executor's config walk: strings go through `ctx.interpolate()`,
 * arrays and plain objects are recursed into, every other leaf passes through.
 */
function interpolateValue(value: unknown, ctx: MockContext): unknown {
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
 * Runs one node class in isolation and reports what happened.
 *
 * Each {@link NodeTestRunner.run} builds a fresh node instance and a fresh
 * seeded {@link MockContext}, and never rejects because of a node failure —
 * failures come back as `{ ok: false, error }` so tests can assert on them.
 *
 * @example
 * ```typescript
 * const runner = new NodeTestRunner(MyNode);
 * const result = await runner.run(
 *   { token: '{{ steps.auth.output.token }}' },
 *   { context: { steps: { auth: { output: { token: 'abc' } } } } },
 * );
 * expect(result.ok).toBe(true);
 * ```
 */
export class NodeTestRunner {
  // process.env and globalThis.fetch are process-wide, so the overlap guard is
  // too: it is shared by every runner instance, not kept per instance.
  static #overridesActive = false;

  readonly #NodeClass: new () => IBaseNode;

  /**
   * @param NodeClass - The node to test. A new instance is constructed on every `run()`.
   */
  constructor(NodeClass: new () => IBaseNode) {
    this.#NodeClass = NodeClass;
  }

  /**
   * Executes one isolated run: interpolate config, `beforeExecute()` (if
   * defined), `execute()`, then `afterExecute()` (if defined, and only after a
   * successful `execute()`). The node is constructed inside the same
   * override window, so constructors that read `process.env` see `options.env`.
   *
   * Anything the node throws — including from its constructor — is returned as
   * `{ ok: false, error }` with the exact thrown value, never wrapped.
   *
   * `options.env` and `options.fetch` are restored afterwards, even when the
   * node throws. A variable that did not exist before is deleted, not set to
   * the string `"undefined"`.
   *
   * @param config - Raw node config; `{{ }}` tokens are resolved unless `options.interpolate` is `false`.
   * @param options - Context seed, env and fetch overrides, interpolation switch.
   * @returns The run result. Never rejects because of a node failure.
   * @throws {Error} Only when this call uses `env` or `fetch` while another
   *   `run()` with such overrides is still in flight (overrides mutate
   *   process-wide state, so they cannot overlap). Jest runs the tests of one
   *   file sequentially, so normal use never hits this.
   */
  async run(config: NodeConfig, options: NodeTestRunnerOptions = {}): Promise<NodeTestRunResult> {
    const { env, fetch: fetchOverride, interpolate = true } = options;
    const usesOverrides = env !== undefined || fetchOverride !== undefined;

    // Built before the guard is taken so an invalid seed can never leave it held.
    const context = new MockContext(options.context ?? {});

    // No `await` may sit between this check and the flag assignment: the guard
    // has to be taken synchronously for a second, overlapping run() to see it.
    if (usesOverrides) {
      if (NodeTestRunner.#overridesActive) {
        throw new Error(OVERLAP_ERROR_MESSAGE);
      }
      NodeTestRunner.#overridesActive = true;
    }

    const calls: NodeLifecycleCall[] = [];
    const startTime = Date.now();
    const envBackup = new Map<string, string | undefined>();
    let fetchOverridden = false;
    let originalFetch: PropertyDescriptor | undefined;
    let resolvedConfig: NodeConfig | undefined;

    try {
      if (env !== undefined) {
        for (const [key, value] of Object.entries(env)) {
          // Recorded before mutating so the restore below also covers a partial apply.
          envBackup.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }

      if (fetchOverride !== undefined) {
        originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
        fetchOverridden = true;
        Object.defineProperty(globalThis, 'fetch', {
          value: fetchOverride,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }

      const node = new this.#NodeClass();

      resolvedConfig = interpolate ? (interpolateValue(config, context) as NodeConfig) : config;

      if (node.beforeExecute !== undefined) {
        calls.push('beforeExecute');
        await node.beforeExecute(resolvedConfig, context);
      }

      calls.push('execute');
      const output = await node.execute(resolvedConfig, context);

      if (node.afterExecute !== undefined) {
        calls.push('afterExecute');
        await node.afterExecute(output, context);
      }

      return {
        ok: true,
        output,
        resolvedConfig,
        calls,
        durationMs: Date.now() - startTime,
        context,
      };
    } catch (error) {
      return {
        ok: false,
        error,
        resolvedConfig,
        calls,
        durationMs: Date.now() - startTime,
        context,
      };
    } finally {
      for (const [key, original] of envBackup) {
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }

      if (fetchOverridden) {
        if (originalFetch === undefined) {
          // fetch did not exist before the run — remove it rather than leave `undefined` behind.
          Reflect.deleteProperty(globalThis, 'fetch');
        } else {
          Object.defineProperty(globalThis, 'fetch', originalFetch);
        }
      }

      if (usesOverrides) {
        NodeTestRunner.#overridesActive = false;
      }
    }
  }
}

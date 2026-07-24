/**
 * @module ExecutionContext
 *
 * Immutable key-value store that carries data between workflow steps.
 *
 * The executor stores each step's output under the reserved `steps` namespace
 * key after the step completes, making outputs accessible to downstream steps
 * via `{{ steps.<step-name>.<path> }}` template expressions in config values.
 */

import type { IExecutionContext } from '@cognipipe/types';
import { resolveTemplate } from './interpolation.js';

/**
 * Immutable key-value store that carries data between workflow steps.
 *
 * Immutability guarantee: every call to `set()` returns a new ExecutionContext.
 * The original instance's internal state is never modified.
 *
 * @example
 * ```typescript
 * let ctx = new ExecutionContext();
 * ctx = ctx.set('steps', { 'fetch-issues': { output: { count: 42 } } });
 * ctx.interpolate('Found {{ steps.fetch-issues.output.count }} issues');
 * // → 'Found 42 issues'
 * ```
 */
export class ExecutionContext implements IExecutionContext {
  readonly #store: ReadonlyMap<string, unknown>;

  /**
   * @param initial - Optional seed data. Keys become accessible immediately.
   *   Defaults to an empty store.
   */
  constructor(initial: Record<string, unknown> | ReadonlyMap<string, unknown> = {}) {
    if (initial instanceof Map) {
      this.#store = new Map(initial);
    } else {
      this.#store = new Map(Object.entries(initial));
    }
  }

  /** Retrieves a stored value by key, or `undefined` if the key is absent. */
  get(key: string): unknown {
    return this.#store.get(key);
  }

  /**
   * Returns a NEW ExecutionContext with the given key set to `value`.
   * The current instance is not modified.
   */
  set(key: string, value: unknown): ExecutionContext {
    const next = new Map(this.#store);
    next.set(key, value);
    return new ExecutionContext(next);
  }

  /** Returns `true` if the given key exists in the context store. */
  has(key: string): boolean {
    return this.#store.has(key);
  }

  /**
   * @throws {CogniPipeError} INTERPOLATION_ERROR — if any `{{ expr }}` token
   *   cannot be resolved against the current store.
   */
  interpolate(template: string): string {
    return resolveTemplate(template, this);
  }

  /** Returns a plain-object snapshot of the entire store, suitable for logging. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#store);
  }
}

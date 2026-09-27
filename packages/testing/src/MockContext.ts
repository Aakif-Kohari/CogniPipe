/**
 * @module MockContext
 *
 * A lightweight, dependency-free IExecutionContext implementation for use
 * in node test suites. Not a re-export of @cognipipe/core's ExecutionContext —
 * @cognipipe/testing must not depend on @cognipipe/core.
 */

import type { IExecutionContext } from '@cognipipe/types';

/**
 * Pre-built IExecutionContext for node authors' test suites.
 * Backed by an in-memory Map, matching production ExecutionContext's
 * immutable get/set contract — code typed against IExecutionContext
 * behaves identically whether given a MockContext or the real thing.
 *
 * @example
 * ```typescript
 * const ctx = new MockContext({ steps: { auth: { output: { token: 'abc' } } } });
 * ctx.interpolate('{{ steps.auth.output.token }}'); // → 'abc'
 * ```
 */
export class MockContext implements IExecutionContext {
  readonly #store: Map<string, unknown>;

  constructor(seed: Record<string, unknown> = {}) {
    this.#store = new Map(Object.entries(seed));
  }

  get(key: string): unknown {
    return this.#store.get(key);
  }

  /**
   * Returns a NEW MockContext with the given key set — matches the
   * immutable contract IExecutionContext.set() documents, same as
   * production ExecutionContext. The original instance is untouched.
   * `new MockContext().set('a', 1).set('b', 2)` still chains naturally,
   * since each call in the chain works off the instance just returned.
   */
  set(key: string, value: unknown): MockContext {
    return new MockContext({ ...this.toJSON(), [key]: value });
  }

  has(key: string): boolean {
    return this.#store.has(key);
  }

  /**
   * Supports `{{ key.path.to.value }}` dot-notation resolution only.
   * Does NOT support array bracket notation (`[0]`) — production
   * ExecutionContext does; MockContext intentionally covers the common
   * case only.
   *
   * Walks a plain-object snapshot of the store (via {@link toJSON}) rather
   * than special-casing the first path segment against the Map — this keeps
   * root-level and nested lookups on one code path instead of two. Only
   * resolves a segment when it is an own property of the current value, so
   * inherited `Object.prototype` members (`toString`, `constructor`, etc.)
   * never resolve.
   *
   * @throws {Error} Plain `Error` (never `CogniPipeError`) when a token
   *   can't be resolved — MockContext has no dependency on
   *   `@cognipipe/core`'s error types.
   */
  interpolate(template: string): string {
    const data = this.toJSON();

    return template.replace(/\{\{([^{}]+)\}\}/g, (_match, rawExpression: string) => {
      const expression = rawExpression.trim();
      const segments = expression.split('.');

      let current: unknown = data;
      for (const segment of segments) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
          throw new Error(
            `Cannot interpolate "{{ ${expression} }}": no value found at "${segment}".`,
          );
        }
        current = (current as Record<string, unknown>)[segment];
      }

      if (current === undefined) {
        throw new Error(`Cannot interpolate "{{ ${expression} }}": no value found for this path.`);
      }

      return String(current);
    });
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#store);
  }
}

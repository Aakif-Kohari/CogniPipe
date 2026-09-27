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
 * Backed by a mutable in-memory Map — simpler than production ExecutionContext
 * since tests do not need the immutability guarantee (each test constructs
 * its own instance and discards it).
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
   * NOTE: unlike production ExecutionContext, MockContext.set() mutates
   * in place and returns `this` for convenience in test setup chains
   * (`new MockContext().set('a', 1).set('b', 2)`). This is a deliberate,
   * documented deviation from the immutable contract described on
   * IExecutionContext — acceptable because MockContext instances are
   * always test-scoped and never shared across assertions.
   */
  set(key: string, value: unknown): MockContext {
    this.#store.set(key, value);
    return this;
  }

  has(key: string): boolean {
    return this.#store.has(key);
  }

  /**
   * Supports `{{ key.path.to.value }}` dot-notation resolution only.
   * Does NOT support array bracket notation (`[0]`) or the ReDoS-hardened
   * regex used by production `interpolation.ts` — test fixtures are
   * developer-controlled, not attacker-controlled, so that hardening
   * doesn't apply here.
   *
   * Walks a plain-object snapshot of the store (via {@link toJSON}) rather
   * than special-casing the first path segment against the Map — this keeps
   * root-level and nested lookups on one code path instead of two.
   *
   * @throws {Error} Plain `Error` (never `CogniPipeError`) when a token
   *   can't be resolved — MockContext has no dependency on
   *   `@cognipipe/core`'s error types.
   */
  interpolate(template: string): string {
    const data = this.toJSON();

    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expression: string) => {
      const segments = expression.split('.');

      let current: unknown = data;
      for (const segment of segments) {
        if (current === null || typeof current !== 'object') {
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

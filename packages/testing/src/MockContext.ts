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
   * Supports `{{ key.path.to.value }}` dot-notation and array index notation
   * (`{{ a.list[0] }}`, `{{ items[1].name }}`). Like core's `resolveTemplate`,
   * the root key is split off at the first `.`, `[` or `]` before the remainder
   * is normalised: `items[0].name` becomes root `items` plus remainder
   * `[0].name`, which normalises to `.0.name`. An expression that does not
   * start with a context key (`{{ }}`, `{{ . }}`, `{{ .items[0] }}`) throws,
   * as in production.
   *
   * Walks a plain-object snapshot of the store (via {@link toJSON}) rather
   * than special-casing the first path segment against the Map — this keeps
   * root-level and nested lookups on one code path instead of two. Only
   * resolves a segment when it is an own property of the current value, so
   * inherited `Object.prototype` members (`toString`, `constructor`, etc.)
   * never resolve. This guard is an intentional divergence from core's
   * `resolveDotPath`, which has no own-property check.
   *
   * Objects and arrays are serialized as JSON strings to match production
   * interpolation behavior. `null` values are treated as missing paths.
   *
   * @throws {Error} Plain `Error` (never `CogniPipeError`) when a token
   *   can't be resolved — MockContext has no dependency on
   *   `@cognipipe/core`'s error types.
   */
  interpolate(template: string): string {
    const data = this.toJSON();

    return template.replace(/\{\{([^{}]+)\}\}/g, (_match, rawExpression: string) => {
      const expression = rawExpression.trim();

      // Split the root key off at the first '.', '[' or ']' BEFORE normalising the rest, exactly
      // like core's resolveTemplate. An empty root key (`{{ }}`, `{{ . }}`, `{{ .items[0] }}`)
      // is rejected in production, so reject it here too instead of promoting the next segment.
      const separatorIndex = expression.search(/[.[\]]/);
      if (expression === '' || separatorIndex === 0) {
        throw new Error(
          `Cannot interpolate "{{ ${expression} }}": expression must start with a context key.`,
        );
      }
      const rootKey = separatorIndex === -1 ? expression : expression.slice(0, separatorIndex);
      const remainder = separatorIndex === -1 ? '' : expression.slice(separatorIndex);

      // Normalise array indices in the remainder like core's resolveDotPath:
      // "[0].name" -> ".0.name". Empty segments are dropped, as in core.
      const segments = [
        rootKey,
        ...remainder
          .replace(/\[(\d+)\]/g, '.$1')
          .split('.')
          .filter(segment => segment.length > 0),
      ];

      let current: unknown = data;
      for (const segment of segments) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
          throw new Error(
            `Cannot interpolate "{{ ${expression} }}": no value found at "${segment}".`,
          );
        }
        current = (current as Record<string, unknown>)[segment];
      }

      if (current === undefined || current === null) {
        throw new Error(`Cannot interpolate "{{ ${expression} }}": no value found for this path.`);
      }

      if (typeof current !== 'object') {
        return String(current);
      }

      let json: string | undefined;
      try {
        json = JSON.stringify(current);
      } catch {
        json = undefined;
      }
      if (json === undefined) {
        throw new Error(
          `Cannot interpolate "{{ ${expression} }}": the value could not be serialized to JSON.`,
        );
      }
      return json;
    });
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#store);
  }
}

/**
 * @module interpolation
 *
 * Pure functions for resolving dot-notation paths and `{{ expression }}`
 * template tokens against an ExecutionContext store. Neither function holds
 * state — both are safe to call concurrently across step executions.
 */

import type { IExecutionContext } from '@cognipipe/types';
import { CogniPipeError } from '../errors/CogniPipeError.js';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes.js';

/**
 * Matches `{{ expression }}` tokens, capturing the raw inner content.
 *
 * Deliberately does NOT use `\s*` around the capture group. `\s` is a subset
 * of `[^}]`, so pairing `\s*` with `([^}]+?)` lets the engine split a run of
 * whitespace between the two in exponentially many ways — a classic
 * polynomial/exponential ReDoS shape (CWE-1333) triggered by unterminated
 * input like `"{{" + " ".repeat(n)`. A single unambiguous `[^}]+` is linear
 * regardless of input shape. Leading/trailing whitespace inside the token is
 * still trimmed below via `.trim()`, so behaviour for well-formed input is
 * unchanged.
 */
const TOKEN_PATTERN = /{{([^{}]+)}}/g;

/**
 * Resolves a dot-notation path string against a nested object.
 * Supports array index notation (`"users[0].name"`) and hyphenated
 * segment names (`"fetch-issues.output"`).
 *
 * Array notation is normalised before splitting: `"items[0].name"` becomes
 * `"items.0.name"`, then split on `.`. Empty segments after normalisation
 * are filtered out.
 *
 * Returns `undefined` at any point a segment does not exist — callers decide
 * whether to throw. Never throws on missing paths.
 *
 * @param obj  - The root object to traverse.
 * @param path - Dot-notation path (e.g. `"fetch-issues.output.users[0].email"`).
 *               An empty string returns `obj` itself.
 * @returns The resolved value, or `undefined` if any segment is missing.
 *
 * @example
 * ```typescript
 * resolveDotPath(
 *   { 'fetch-issues': { output: { users: [{ name: 'Alice' }] } } },
 *   'fetch-issues.output.users[0].name',
 * );
 * // → 'Alice'
 * ```
 */
export function resolveDotPath(obj: unknown, path: string): unknown {
  if (path === '') {
    return obj;
  }

  // Normalise array index notation: "items[0].name" -> "items.0.name"
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(segment => segment.length > 0);

  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    // Bracket notation supports hyphenated keys like "fetch-issues".
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Replaces all `{{ expression }}` tokens in `template` by resolving each
 * expression against the provided `context`.
 *
 * Expression format: `{{ rootKey.optional.dot.path }}` where `rootKey` is a
 * top-level key in the context store. Whitespace inside `{{ }}` is trimmed.
 *
 * The canonical format for step outputs is `{{ steps.<step-name>.<path> }}`
 * because the executor stores all step results under the `steps` key:
 * `{ steps: { 'fetch-issues': { output: { ... } } } }`.
 *
 * Resolved values are coerced to strings via `String()`.
 * A string containing no `{{ }}` tokens is returned unchanged.
 *
 * @param template - A string potentially containing `{{ expr }}` tokens.
 * @param context  - The ExecutionContext to resolve expressions against.
 * @returns The fully resolved string.
 * @throws {CogniPipeError} INTERPOLATION_ERROR — if any expression resolves
 *   to `undefined`, `null`, or the expression is empty.
 *
 * @example
 * ```typescript
 * // ctx store: { steps: { 'fetch-issues': { output: { count: 42 } } } }
 * resolveTemplate('Found {{ steps.fetch-issues.output.count }} issues', ctx);
 * // → 'Found 42 issues'
 * ```
 */
export function resolveTemplate(template: string, context: IExecutionContext): string {
  return template.replace(TOKEN_PATTERN, (_fullMatch, rawExpression: string) => {
    const expression = rawExpression.trim();

    if (expression === '') {
      throw new CogniPipeError('Context interpolation failed: expression cannot be empty', {
        code: COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR,
      });
    }

    // Split on the first "." only to isolate the root context key.
    const separatorMatch = expression.match(/[.[\]]/);
    const separatorIndex = separatorMatch?.index ?? -1;
    const rootKey = separatorIndex === -1 ? expression : expression.slice(0, separatorIndex);
    const remainderPath =
      separatorIndex === -1 ? '' : expression.slice(separatorIndex).replace(/^\./, '');

    const storedValue = context.get(rootKey);

    if (storedValue === undefined || storedValue === null) {
      throw new CogniPipeError(
        `Context interpolation failed: "{{ ${expression} }}" — key "${rootKey}" is not in the context or resolved to null. Ensure the referenced step ran before this one.`,
        {
          code: COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR,
          context: { expression, rootKey },
        },
      );
    }

    const resolvedValue = resolveDotPath(storedValue, remainderPath);

    if (resolvedValue === undefined || resolvedValue === null) {
      throw new CogniPipeError(
        `Context interpolation failed: "{{ ${expression} }}" — path "${remainderPath}" could not be resolved on the stored value or resolved to null.`,
        {
          code: COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR,
          context: { expression, rootKey, remainderPath },
        },
      );
    }

    return String(resolvedValue);
  });
}

/**
 * @module defineConfig
 *
 * Factory that wraps a Zod schema into a CogniPipe-compliant config parser.
 * Node authors use this at class scope to define their config shape once and
 * reference it from execute(), describe(), or any other method that needs typed config.
 *
 * Never call schema.parse() or schema.safeParse() directly in node code —
 * use this factory to ensure validation failures produce CogniPipeError(NODE_CONFIG_INVALID)
 * rather than raw ZodError instances.
 */

import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import type { ZodType } from 'zod';

/**
 * A reusable, typed config parser returned by {@link defineConfig}.
 * Call `.parse()` inside `execute()` to validate and type the raw config.
 */
export interface ConfigDefinition<T> {
  /**
   * Validates `raw` against the schema and returns typed output.
   * Applies Zod defaults (e.g. `z.number().default(5000)`) automatically.
   *
   * @param raw - The raw config object from the workflow step (NodeConfig = Record<string, unknown>).
   * @returns The validated, fully-typed result.
   * @throws {CogniPipeError} NODE_CONFIG_INVALID if validation fails.
   *   Error message identifies the first failing field and received value,
   *   using the same path format as WorkflowValidator.
   */
  parse(raw: unknown): T;
  /**
   * The underlying Zod schema. Expose for advanced use cases (e.g. generating
   * JSON Schema documentation or composing with other schemas). Read-only.
   */
  readonly schema: ZodType<T>;
}

/**
 * Creates a CogniPipe-compliant config parser from a Zod schema.
 * Declare the result as a constant at class scope so it is reusable
 * across all methods that need typed config.
 *
 * @param schema - A Zod schema describing the node's config shape.
 * @returns A {@link ConfigDefinition} with a `.parse()` method and `.schema` accessor.
 *
 * @example
 * ```typescript
 * import { defineConfig } from '@cognipipe/sdk';
 * import { z } from 'zod';
 *
 * // Declare at class scope — defined once, reused everywhere
 * const HttpConfig = defineConfig(
 *   z.object({
 *     url: z.string().url('URL must be a valid http/https address'),
 *     method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
 *     timeout: z.number().int().min(0).max(30_000).default(5_000),
 *   }),
 * );
 *
 * @CogniNode({ type: '@cognipipe/node-http', version: '1.0.0' })
 * export class HttpNode extends BaseNode {
 *   async execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
 *     const { url, method, timeout } = HttpConfig.parse(config);
 *     // url, method, timeout are fully typed with defaults applied
 *     return { result: 'done' };
 *   }
 * }
 * ```
 */
export function defineConfig<T>(schema: ZodType<T>): ConfigDefinition<T> {
  return {
    schema,
    parse(raw: unknown): T {
      const result = schema.safeParse(raw);

      if (!result.success) {
        const issue = result.error.issues[0];

        if (!issue) {
          throw new CogniPipeError('Node config validation failed.', {
            code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
          });
        }

        const path = issue.path
          .map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${String(seg)}`))
          .join('')
          .replace(/^\./, '');

        // Zod's issue.received is only populated for invalid_type issues. Traverse
        // raw using the issue path to reliably recover the actual received value
        // for every issue kind — mirrors BaseNode.validateConfig()/WorkflowValidator.
        const receivedValue = issue.path.reduce<unknown>(
          (acc, seg) =>
            acc != null && typeof acc === 'object'
              ? (acc as Record<string | number, unknown>)[seg as string | number]
              : undefined,
          raw,
        );

        const pathLabel = path.length > 0 ? `"${path}"` : '"(root)"';

        throw new CogniPipeError(
          `Node config validation failed at ${pathLabel}: ${issue.message}`,
          {
            code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
            context: { path, received: receivedValue },
          },
        );
      }

      return result.data;
    },
  };
}

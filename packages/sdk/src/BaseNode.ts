/**
 * @module BaseNode
 *
 * Abstract base class every CogniPipe node extends. Defines the execution
 * contract, optional lifecycle hooks, and a Zod-backed config validator that
 * raises a consistent CogniPipeError instead of a raw ZodError.
 */

import type {
  CogniNodeMeta,
  IBaseNode,
  IExecutionContext,
  NodeConfig,
  NodeOutput,
} from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import type { ZodType } from 'zod';

/**
 * Abstract base class for all CogniPipe nodes.
 * Extend this class and implement execute() to build a node.
 * Decorate with @CogniNode() to register the node's type and version metadata.
 *
 * @example
 * ```typescript
 * import { BaseNode } from '@cognipipe/sdk';
 * import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
 * import { z } from 'zod';
 *
 * const ConfigSchema = z.object({ url: z.string().url() });
 *
 * export class MyServiceNode extends BaseNode {
 *   async execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
 *     const { url } = this.validateConfig(ConfigSchema, config);
 *     // url is now a typed, validated string
 *     return { result: 'done' };
 *   }
 * }
 * ```
 */
export abstract class BaseNode implements IBaseNode {
  /**
   * Metadata attached by @CogniNode() decorator.
   * Do not set this manually — the decorator manages it.
   * Undefined if the class was not decorated with @CogniNode().
   */
  static cogniNodeMeta?: CogniNodeMeta;

  /**
   * Executes the node's primary action.
   * Called by WorkflowExecutor for each step whose `uses` matches this node's type.
   *
   * @param config - The step's config block after WorkflowValidator has run.
   *   Always an object — never undefined.
   * @param ctx - Current execution context. Read upstream outputs via ctx.get().
   *   Use ctx.interpolate() on string values that may contain {{ }} expressions.
   * @returns NodeOutput stored in context under this step's name for downstream steps.
   */
  abstract execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput>;

  /**
   * Optional lifecycle hook called by WorkflowExecutor before execute().
   * Use to validate required environment variables or perform async setup.
   * If this throws, execute() will NOT be called for this step.
   *
   * @param config - Same config that will be passed to execute().
   * @param ctx - Current execution context.
   */
  beforeExecute?(config: NodeConfig, ctx: IExecutionContext): Promise<void>;

  /**
   * Optional lifecycle hook called by WorkflowExecutor after execute() succeeds.
   * Use to emit metrics, write audit logs, or perform cleanup.
   * Not called if execute() throws.
   *
   * @param output - The NodeOutput returned by execute().
   * @param ctx - The execution context at the time execute() returned.
   */
  afterExecute?(output: NodeOutput, ctx: IExecutionContext): Promise<void>;

  /**
   * Validates a raw config object against a Zod schema.
   * Always use this instead of calling schema.safeParse() directly —
   * failures produce a CogniPipeError(NODE_CONFIG_INVALID), not a raw ZodError.
   *
   * Uses the same path-formatting convention as WorkflowValidator so that all
   * validation errors across the engine look identical.
   *
   * @param schema - Zod schema describing the node's config shape.
   * @param raw - The raw config from the workflow step.
   * @returns The validated, typed result.
   * @throws {CogniPipeError} NODE_CONFIG_INVALID if validation fails.
   *
   * @example
   * ```typescript
   * const Schema = z.object({ url: z.string().url(), timeout: z.number().default(5000) });
   *
   * async execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
   *   const { url, timeout } = this.validateConfig(Schema, config);
   *   // Both fields are now typed and timeout has its default applied
   * }
   * ```
   */
  protected validateConfig<T>(schema: ZodType<T>, raw: unknown): T {
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
      // for every issue kind — mirrors WorkflowValidator's approach.
      const receivedValue = issue.path.reduce<unknown>(
        (acc, seg) =>
          acc != null && typeof acc === 'object'
            ? (acc as Record<string | number, unknown>)[seg as string | number]
            : undefined,
        raw,
      );

      const pathLabel = path.length > 0 ? `"${path}"` : '"(root)"';

      throw new CogniPipeError(`Node config validation failed at ${pathLabel}: ${issue.message}`, {
        code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
        context: { path, received: receivedValue },
      });
    }

    return result.data;
  }
}

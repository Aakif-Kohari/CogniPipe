/**
 * @module CogniNode
 *
 * @CogniNode() class decorator that attaches type and version metadata to a
 * BaseNode subclass. Validates both fields at decoration time (module load),
 * so a misconfigured node fails immediately at process start instead of
 * silently at first workflow execution.
 */

import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import type { BaseNode } from '../BaseNode';
// import type { CogniNodeMeta } from '@cognipipe/types';

/** Strict semver — three numeric segments only. No 'v' prefix, no pre-release tag. */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Options for the @CogniNode() class decorator.
 * Both fields are validated at decoration time — errors throw immediately
 * on module import, not at first execution.
 */
export interface CogniNodeOptions {
  /**
   * The node's unique type identifier.
   * Must be a non-empty string matching the node's npm package name.
   * E.g. '@cognipipe/node-http', '@myorg/node-sendgrid'.
   * NodeRegistry matches steps to nodes by comparing this value to `step.uses`.
   */
  type: string;

  /**
   * Semantic version of the node package.
   * Must satisfy /^\d+\.\d+\.\d+$/ — no 'v' prefix, no pre-release tags.
   * Must match the `version` field in the node's package.json.
   * E.g. '1.0.0', '2.3.1'.
   */
  version: string;
}

/**
 * Class decorator that attaches type and version metadata to a BaseNode subclass.
 * Required on every node class — NodeRegistry uses this to identify and instantiate nodes.
 *
 * Validates both options at decoration time (module load), so misconfigured nodes
 * fail immediately rather than silently at workflow execution.
 *
 * @throws {CogniPipeError} NODE_INSTANTIATION_FAILED if `type` is empty or
 *   `version` does not match strict semver format.
 *
 * @example
 * ```typescript
 * @CogniNode({ type: '@cognipipe/node-http', version: '1.0.0' })
 * export class HttpNode extends BaseNode {
 *   async execute(config, ctx) { ... }
 * }
 *
 * HttpNode.cogniNodeMeta; // → { type: '@cognipipe/node-http', version: '1.0.0' }
 * ```
 */
export function CogniNode(options: CogniNodeOptions) {
  return function <T extends typeof BaseNode>(target: T, context: ClassDecoratorContext<T>): void {
    if (!options.type || options.type.trim() === '') {
      throw new CogniPipeError(
        `@CogniNode() on class "${String(context.name)}" has an empty "type" field. ` +
          `Provide a non-empty package name such as '@cognipipe/node-http'.`,
        {
          code: COGNIPIPE_ERROR_CODES.NODE_INSTANTIATION_FAILED,
          context: { className: context.name, receivedType: options.type },
        },
      );
    }

    if (!SEMVER_RE.test(options.version)) {
      throw new CogniPipeError(
        `@CogniNode() on class "${String(context.name)}" has an invalid "version" field. ` +
          `Expected strict semver (e.g. '1.0.0'). Got: "${options.version}".`,
        {
          code: COGNIPIPE_ERROR_CODES.NODE_INSTANTIATION_FAILED,
          context: { className: context.name, receivedVersion: options.version },
        },
      );
    }

    target.cogniNodeMeta = { type: options.type, version: options.version };
  };
}

/**
 * @module BaseNode
 *
 * Interfaces and shared types for the BaseNode contract.
 * Lives in @cognipipe/types so that @cognipipe/core's NodeRegistry can type-check
 * node instances without importing from @cognipipe/sdk (which would create a
 * circular dependency: types ← core ← sdk ← core).
 */

import type { IExecutionContext } from './context.types.js';
import type { NodeConfig, NodeOutput } from './node.types.js';

/**
 * Metadata attached to a BaseNode subclass by the @CogniNode() decorator.
 * NodeRegistry reads this to identify and instantiate nodes by type string.
 *
 * Distinct from {@link NodeDefinition} (registry metadata with a required
 * `displayName` field) — CogniNodeMeta only carries what the decorator itself
 * sets on the class.
 */
export interface CogniNodeMeta {
  /**
   * The node's unique type identifier. Must match the node's npm package name.
   * E.g. '@cognipipe/node-http'.
   */
  type: string;

  /**
   * The node package's semantic version string (e.g. '1.0.0').
   * Must satisfy /^\d+\.\d+\.\d+$/ — no v prefix, no pre-release tags.
   */
  version: string;
}

/**
 * The interface NodeRegistry uses to interact with node instances.
 * BaseNode in @cognipipe/sdk implements this. NodeRegistry in @cognipipe/core
 * types against IBaseNode to avoid a circular sdk ↔ core dependency.
 */
export interface IBaseNode {
  execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput>;
  beforeExecute?(config: NodeConfig, ctx: IExecutionContext): Promise<void>;
  afterExecute?(output: NodeOutput, ctx: IExecutionContext): Promise<void>;
}

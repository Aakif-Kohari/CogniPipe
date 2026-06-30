/**
 * @module node.types
 *
 * Defines the structural types for CogniPipe node metadata, input configuration,
 * and execution output. These types form the contract between `@cognipipe/core`'s
 * NodeRegistry and every community node package under `nodes/`.
 */

/**
 * Metadata about a registered CogniPipe node as stored in the NodeRegistry.
 * Every node package must expose a `NodeDefinition` so the engine can
 * validate `uses` fields in workflow steps and display human-readable information
 * in the `cognipipe list` command.
 */
export interface NodeDefinition {
  /**
   * Unique node type identifier that matches the `uses` field in {@link StepConfig}.
   * Conventionally scoped to the npm package name, e.g. `'@cognipipe/node-http'`.
   */
  type: string;
  /**
   * Semantic version string of this node implementation (e.g. `'1.2.0'`).
   * The engine may warn or reject nodes whose major version is incompatible
   * with the installed SDK version.
   */
  version: string;
  /** Human-readable name shown in `cognipipe list` and error messages. */
  displayName: string;
  /** Optional short description of what the node does, shown in `cognipipe list`. */
  description?: string;
}

/**
 * The arbitrary key-value output returned by a node after its `execute()` method
 * completes successfully. Downstream steps access this data through the reserved
 * `steps` namespace stored within an {@link IExecutionContext}.
 *
 * Keys and value shapes are node-specific and documented in each node's `README.md`.
 */
export interface NodeOutput {
  [key: string]: unknown;
}

/**
 * The validated, node-specific configuration object passed to a node's `execute()` method.
 * Values originate from the `config` block of the corresponding {@link StepConfig}
 * and are validated against the node's Zod schema before execution begins.
 */
export type NodeConfig = Record<string, unknown>;

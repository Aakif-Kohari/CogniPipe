/** Metadata about a registered CogniPipe node */
export interface NodeDefinition {
  /** Unique node type identifier, e.g. '@cognipipe/node-http' */
  type: string;
  /** Semver version string */
  version: string;
  /** Human-readable display name */
  displayName: string;
  /** Short description of what the node does */
  description?: string;
}

/** The output returned by a node after execution */
export interface NodeOutput {
  [key: string]: unknown;
}

/** The input config passed to a node's execute() method */
export type NodeConfig = Record<string, unknown>;

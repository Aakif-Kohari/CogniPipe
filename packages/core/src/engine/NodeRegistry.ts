/**
 * @module NodeRegistry
 *
 * Stores and resolves CogniPipe node constructors by their type string.
 * WorkflowExecutor uses NodeRegistry to instantiate nodes for each workflow step.
 * Community nodes register themselves here at application startup.
 */

import type { IBaseNode } from '@cognipipe/types';
import { CogniPipeError } from '../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes';

/**
 * A class constructor that produces an IBaseNode instance.
 * Matches the shape of any class that extends BaseNode and is decorated with @CogniNode().
 */
export type NodeConstructor = new () => IBaseNode;

/**
 * Registry mapping node type strings to their constructor functions.
 * Each type string must match the `uses` field in StepConfig exactly —
 * it is the npm package name of the node (e.g. '@cognipipe/node-http').
 *
 * @example
 * ```typescript
 * const registry = new NodeRegistry();
 * registry.register('@cognipipe/node-http', HttpNode);
 * registry.register('@cognipipe/node-slack', SlackNode);
 *
 * const executor = new WorkflowExecutor(registry);
 * await executor.run(config);
 * ```
 */
export class NodeRegistry {
  readonly #registry: Map<string, NodeConstructor> = new Map();

  /**
   * Registers a node constructor under the given type string.
   * If the same type is registered twice, the second registration
   * overwrites the first — no error is thrown. This allows node updates
   * without restarting the registry.
   *
   * @param type - The node's unique type identifier. Must be non-empty.
   *   Conventionally the node's npm package name, e.g. '@cognipipe/node-http'.
   *   Must exactly match the `uses` field in WorkflowConfig steps.
   * @param ctor - The node class constructor. Must be a class (not an instance).
   * @throws {CogniPipeError} NODE_INSTANTIATION_FAILED if `type` is empty or whitespace-only.
   */
  register(type: string, ctor: NodeConstructor): void {
    if (type.trim() === '') {
      throw new CogniPipeError(
        `Cannot register a node with an empty type string. Provide the node's package name, e.g. "@cognipipe/node-http".`,
        { code: COGNIPIPE_ERROR_CODES.NODE_INSTANTIATION_FAILED },
      );
    }

    this.#registry.set(type, ctor);
  }

  /**
   * Returns the registered constructor for the given type string.
   *
   * @param type - The node type string to look up.
   * @returns The registered NodeConstructor.
   * @throws {CogniPipeError} NODE_NOT_REGISTERED if no constructor is registered
   *   for the given type. Error message names the type and lists all registered
   *   types so the workflow author can verify the spelling.
   */
  get(type: string): NodeConstructor {
    const ctor = this.#registry.get(type);

    if (ctor === undefined) {
      const registeredTypes = JSON.stringify(this.listTypes());
      throw new CogniPipeError(
        `Node "${type}" is not registered. Registered types: ${registeredTypes}. ` +
          `Ensure the node package is imported and its constructor is passed to NodeRegistry.register() before running the workflow.`,
        { code: COGNIPIPE_ERROR_CODES.NODE_NOT_REGISTERED },
      );
    }

    return ctor;
  }

  /**
   * Returns true if a constructor is registered for the given type string.
   * Use to check existence without triggering a throw.
   */
  has(type: string): boolean {
    return this.#registry.has(type);
  }

  /**
   * Instantiates the node registered for `type` and returns the instance.
   * This is the primary method WorkflowExecutor calls — it abstracts the
   * constructor lookup and instantiation into a single safe operation.
   *
   * @param type - The node type string to instantiate.
   * @returns A fresh IBaseNode instance.
   * @throws {CogniPipeError} NODE_NOT_REGISTERED if no constructor is registered.
   * @throws {CogniPipeError} NODE_INSTANTIATION_FAILED if the constructor throws
   *   during instantiation. The original error is attached as `.cause`.
   */
  instantiate(type: string): IBaseNode {
    const ctor = this.get(type);

    try {
      return new ctor();
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new CogniPipeError(
        `Failed to instantiate node "${type}": ${cause?.message ?? String(err)}.`,
        { code: COGNIPIPE_ERROR_CODES.NODE_INSTANTIATION_FAILED, cause },
      );
    }
  }

  /**
   * Returns an immutable list of all registered type strings.
   * Used by the CLI's `cognipipe list` command and for debugging.
   */
  listTypes(): readonly string[] {
    return Object.freeze([...this.#registry.keys()]);
  }
}

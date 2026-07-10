/**
 * @module @cognipipe/sdk
 *
 * Public API for the CogniPipe SDK.
 * Provides the BaseNode abstract class that every community-contributed node
 * must extend, the @CogniNode() decorator used to register a node's type and
 * version metadata, plus the NodeConfig type used in execute()'s signature.
 *
 * @example
 * ```typescript
 * import { BaseNode, CogniNode } from '@cognipipe/sdk';
 * import type { NodeConfig, CogniNodeOptions } from '@cognipipe/sdk';
 * ```
 */
export { BaseNode } from './BaseNode';
export { CogniNode } from './decorators/CogniNode';
export type { CogniNodeOptions } from './decorators/CogniNode';
export type { NodeConfig } from '@cognipipe/types';

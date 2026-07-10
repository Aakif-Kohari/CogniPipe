/**
 * @module @cognipipe/sdk
 *
 * Public API for the CogniPipe SDK.
 * Provides the BaseNode abstract class that every community-contributed node
 * must extend, plus the NodeConfig type used in its execute() signature.
 *
 * @example
 * ```typescript
 * import { BaseNode } from '@cognipipe/sdk';
 * import type { NodeConfig } from '@cognipipe/sdk';
 * ```
 */
export { BaseNode } from './BaseNode';
export type { NodeConfig } from '@cognipipe/types';

// @CogniNode() decorator export will be added here in issue #30.

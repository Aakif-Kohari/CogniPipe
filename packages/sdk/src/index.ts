/**
 * @module @cognipipe/sdk
 *
 * Public API for the CogniPipe SDK.
 * Provides the BaseNode abstract class that every community-contributed node
 * must extend, the @CogniNode() decorator used to register a node's type and
 * version metadata, the NodeConfig type used in execute()'s signature, and
 * defineConfig() for declaring a reusable, Zod-backed config parser once at
 * node class scope instead of inlining a schema inside execute().
 *
 * @example
 * ```typescript
 * import { BaseNode, CogniNode, defineConfig } from '@cognipipe/sdk';
 * import type { NodeConfig, CogniNodeOptions, ConfigDefinition } from '@cognipipe/sdk';
 * ```
 */
export { BaseNode } from './BaseNode.js';
export { CogniNode } from './decorators/CogniNode.js';
export type { CogniNodeOptions } from './decorators/CogniNode.js';
export type { NodeConfig } from '@cognipipe/types';
export { defineConfig } from './defineConfig.js';
export type { ConfigDefinition } from './defineConfig.js';

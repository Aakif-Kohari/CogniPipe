/**
 * @module @cognipipe/types
 *
 * Public entry point for the `@cognipipe/types` package — the single source of
 * truth for every shared TypeScript interface used across the CogniPipe monorepo.
 *
 * Consumers should import directly from this package:
 * ```typescript
 * import type { WorkflowConfig, StepConfig, IExecutionContext } from '@cognipipe/types';
 * ```
 *
 * Modules re-exported here:
 * - `workflow.types` — {@link WorkflowConfig}, {@link StepConfig}, {@link RetryConfig}
 * - `node.types`     — {@link NodeDefinition}, {@link NodeOutput}, {@link NodeConfig}
 * - `context.types`  — {@link IExecutionContext}, {@link StepResult}
 * - `BaseNode`        — {@link IBaseNode}, {@link CogniNodeMeta}
 * - `ai-provider.types` — {@link AiProviderConfig}, {@link AiRateLimitPolicy}, {@link AiProviderCapability}
 */
export * from './workflow.types';
export * from './node.types';
export * from './context.types';
export * from './BaseNode';
export * from './ai-provider.types';

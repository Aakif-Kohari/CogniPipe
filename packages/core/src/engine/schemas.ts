/**
 * @module schemas
 *
 * Zod schemas that mirror the workflow types in `@cognipipe/types`.
 * Used by {@link WorkflowValidator} to validate raw unknown input before execution.
 * Exported so downstream contributors can compose them in their own validators.
 */

import { z } from 'zod';

/**
 * Zod schema for RetryConfig.
 * Mirrors the RetryConfig interface in @cognipipe/types.
 */
export const RetryConfigSchema = z.object({
  attempts: z.number().int().min(1).max(10),
  delayMs: z.number().int().min(0),
  backoff: z.enum(['linear', 'exponential']).optional(),
});

/**
 * Zod schema for StepConfig.
 * Mirrors the StepConfig interface in @cognipipe/types.
 * Field names match the workflow YAML format: `name` and `uses`.
 */
export const StepConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9-_]*$/,
      'Step name must be lowercase, start with a letter, and contain only letters, numbers, hyphens, or underscores',
    ),
  uses: z
    .string()
    .min(1, 'Step "uses" field must be a non-empty package name, e.g. "@cognipipe/node-http"'),
  config: z.record(z.unknown()).default({}),
  dependsOn: z.array(z.string()).optional(),
  retry: RetryConfigSchema.optional(),
});

/**
 * Zod schema for WorkflowConfig.
 * The top-level schema used by WorkflowValidator to validate raw parsed YAML.
 */
export const WorkflowConfigSchema = z.object({
  name: z.string().min(1, 'Workflow "name" must be a non-empty string'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Workflow "version" must follow semver (e.g. "1.0.0")'),
  description: z.string().optional(),
  steps: z.array(StepConfigSchema).min(1, 'Workflow must have at least one step'),
});

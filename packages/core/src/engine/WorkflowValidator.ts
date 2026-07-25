/**
 * @module WorkflowValidator
 *
 * Validates raw unknown values against the WorkflowConfig Zod schema before
 * handing them to WorkflowExecutor. This is the single gatekeeping point that
 * turns untrusted YAML output into a fully type-safe WorkflowConfig, or fails
 * with a human-readable CogniPipeError.
 */

import type { WorkflowConfig } from '@cognipipe/types';
import { CogniPipeError } from '../errors/CogniPipeError.js';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes.js';
import { WorkflowConfigSchema } from './schemas.js';

/**
 * Validates raw parsed YAML/JSON against the WorkflowConfig schema.
 * Must be called before WorkflowExecutor receives any workflow input.
 *
 * @example
 * ```typescript
 * const validator = new WorkflowValidator();
 * const config = validator.validate(rawYaml); // throws if invalid
 * executor.run(config);                        // safe to use
 * ```
 */
export class WorkflowValidator {
  /**
   * Validates a raw unknown value against the WorkflowConfig Zod schema.
   * Typically called with the output of a YAML parser before execution begins.
   *
   * @param raw - The raw parsed value (unknown type).
   * @returns A fully typed, validated WorkflowConfig.
   * @throws {CogniPipeError} with code `WORKFLOW_VALIDATION_ERROR` if validation
   *   fails. The error message identifies the first failing field path and value.
   */
  validate(raw: unknown): WorkflowConfig {
    const result = WorkflowConfigSchema.safeParse(raw);

    if (!result.success) {
      const issue = result.error.issues[0];

      if (!issue) {
        throw new CogniPipeError('Workflow validation failed.', {
          code: COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR,
        });
      }

      const path = issue.path
        .map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${String(seg)}`))
        .join('')
        .replace(/^\./, '');

      // Traverse raw using the issue path to get the actual received value.
      // Zod's issue.received is only available for invalid_type issues and holds
      // the parsed type name, not the value itself. Traversal works for all cases.
      const receivedValue = issue.path.reduce<unknown>(
        (acc, seg) =>
          acc != null && typeof acc === 'object'
            ? (acc as Record<string | number, unknown>)[seg as string | number]
            : undefined,
        raw,
      );
      const serialized = JSON.stringify(receivedValue);
      const receivedStr = serialized !== undefined ? ` Received: ${serialized}` : '';

      const pathLabel = path.length > 0 ? `"${path}"` : '"(root)"';

      throw new CogniPipeError(
        `Workflow validation failed at ${pathLabel}: ${issue.message}.${receivedStr}`,
        {
          code: COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR,
          context: { path, received: receivedValue },
        },
      );
    }

    return result.data;
  }
}

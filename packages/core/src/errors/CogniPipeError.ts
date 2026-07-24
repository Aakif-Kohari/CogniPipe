/**
 * @module CogniPipeError
 *
 * Provides the base error class for all domain errors thrown by the CogniPipe engine,
 * along with a type guard for safe programmatic error handling.
 */

import type { CogniPipeErrorCode } from './errorCodes.js';

/**
 * Options passed to the {@link CogniPipeError} constructor.
 */
export interface CogniPipeErrorOptions {
  /** Machine-readable error code. Must be a value from {@link COGNIPIPE_ERROR_CODES}. */
  code: CogniPipeErrorCode;
  /**
   * Optional structured metadata providing debugging context.
   * E.g. the invalid step name, the raw config value that failed validation.
   */
  context?: Record<string, unknown>;
  /** The original lower-level error that caused this one, if wrapping. */
  cause?: Error;
}

/**
 * The base error class for all domain errors thrown by the CogniPipe engine.
 * Extends native Error with a machine-readable `code` and an optional
 * `context` bag for structured debug metadata.
 *
 * @example
 * ```typescript
 * throw new CogniPipeError(
 *   'Step "fetch-issues" not found in context. Ensure it is defined before referencing it in dependsOn.',
 *   { code: COGNIPIPE_ERROR_CODES.STEP_NOT_FOUND, context: { stepName: 'fetch-issues' } },
 * );
 * ```
 */
export class CogniPipeError extends Error {
  /** @inheritdoc */
  public override readonly name = 'CogniPipeError';

  /** Machine-readable code — use for programmatic error handling. */
  public readonly code: CogniPipeErrorCode;

  /** Structured metadata for debugging. Undefined if none was provided. */
  public readonly context: Record<string, unknown> | undefined;

  constructor(message: string, options: CogniPipeErrorOptions) {
    // Pass `cause` to the native Error constructor (Node.js >=16.9 supports this)
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.code = options.code;
    this.context = options.context;
  }

  /**
   * Returns a plain, JSON-serialisable object representation of this error.
   * Suitable for structured logging or API error responses.
   * The `context` key is omitted entirely when undefined — never included as `undefined`.
   */
  toJSON(): {
    name: string;
    code: CogniPipeErrorCode;
    message: string;
    context?: Record<string, unknown>;
  } {
    const base = {
      name: this.name,
      code: this.code,
      message: this.message,
    };

    if (this.context !== undefined) {
      return { ...base, context: this.context };
    }

    return base;
  }
}

/**
 * Type guard that narrows an unknown value to {@link CogniPipeError}.
 *
 * @example
 * ```typescript
 * try {
 *   await executor.run(config);
 * } catch (err) {
 *   if (isCogniPipeError(err)) {
 *     console.error(`[${err.code}] ${err.message}`, err.context);
 *   } else {
 *     throw err; // re-throw unexpected runtime errors
 *   }
 * }
 * ```
 */
export function isCogniPipeError(value: unknown): value is CogniPipeError {
  return value instanceof CogniPipeError;
}

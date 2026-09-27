/**
 * @module RetryManager
 *
 * Reusable retry logic for AI provider nodes handling HTTP 429 rate limiting.
 * Distinct from WorkflowExecutor's step-level RetryConfig — this is scoped
 * specifically to AiRateLimitPolicy and 429 responses, with Retry-After
 * header support.
 */

import type { AiRateLimitPolicy } from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';

/**
 * A function that may throw a RateLimitError-shaped object on 429.
 * Node authors wrap their fetch call in a function matching this signature.
 */
export interface RateLimitAwareError extends Error {
  /** Present when the failure was an HTTP 429 response. */
  status?: number;
  /** The raw Retry-After header value, if the provider sent one. */
  retryAfterHeader?: string;
}

// delay-seconds per RFC 9110 §10.2.3: one or more digits, no sign, no fraction.
const DELAY_SECONDS_PATTERN = /^\d+$/;

// IMF-fixdate per RFC 9110 §5.6.7 — the exact shape Date.prototype.toUTCString()
// produces, e.g. "Wed, 21 Oct 2026 07:28:00 GMT". We deliberately require this
// exact shape rather than handing arbitrary strings to `new Date()`: the Date
// constructor's non-ISO fallback parser is permissive enough to turn clearly
// malformed input (e.g. "-5") into a spurious valid date instead of NaN.
const IMF_FIXDATE_PATTERN = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parses a Retry-After header value into a delay in milliseconds.
 * Supports both formats per RFC 9110 §10.2.3:
 * - delay-seconds: "120" → 120_000ms
 * - HTTP-date (IMF-fixdate): "Wed, 21 Oct 2026 07:28:00 GMT" → computed from now
 *
 * Note: HTTP-date has no sub-second precision, so a delay derived from it is
 * only accurate to the nearest second.
 *
 * @returns The delay in milliseconds, or null if the header is malformed
 *   (caller should fall back to the policy's own backoff schedule).
 */
export function parseRetryAfter(headerValue: string): number | null {
  if (!headerValue) return null;

  if (DELAY_SECONDS_PATTERN.test(headerValue)) {
    return Number(headerValue) * 1000;
  }

  if (IMF_FIXDATE_PATTERN.test(headerValue)) {
    const date = new Date(headerValue);
    // Reject dates that don't round-trip: new Date() silently normalizes
    // out-of-range components (e.g. "30 Feb" -> "2 Mar"), which would
    // otherwise turn a malformed header into a spurious valid delay.
    if (!Number.isNaN(date.getTime()) && date.toUTCString() === headerValue) {
      const delayMs = date.getTime() - Date.now();
      return delayMs > 0 ? delayMs : 0;
    }
  }

  return null;
}

// setTimeout's 32-bit signed-int ceiling — delays beyond this fire immediately
// instead of after the requested duration, which would silently violate this
// module's contract to honor the provider's exact Retry-After duration.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const sleep = async (ms: number): Promise<void> => {
  let remaining = ms;
  while (remaining > MAX_TIMER_DELAY_MS) {
    await new Promise<void>(resolve => setTimeout(resolve, MAX_TIMER_DELAY_MS));
    remaining -= MAX_TIMER_DELAY_MS;
  }
  await new Promise<void>(resolve => setTimeout(resolve, remaining));
};

/**
 * Namespace object exposing {@link RetryManager.execute} — the sole entry
 * point for AiRateLimitPolicy-driven HTTP 429 retry handling.
 */
export const RetryManager = {
  /**
   * Executes `fn`, retrying on HTTP 429 per `policy`.
   * Non-429 errors are NOT retried — they propagate immediately.
   *
   * `policy.respectRetryAfter` defaults to `true` when omitted, matching
   * {@link AiRateLimitPolicy}'s documented default — only an explicit
   * `false` disables honouring the provider's Retry-After header.
   *
   * @param fn - The operation to execute (e.g. a fetch call wrapped to throw
   *   a RateLimitAwareError with `status: 429` on rate limit responses).
   * @param policy - The AiRateLimitPolicy governing retry behaviour.
   * @throws {CogniPipeError} STEP_EXECUTION_FAILED after policy.maxRetries
   *   exhausted, or the original non-429 error if fn throws something else.
   *
   * @example
   * ```typescript
   * const result = await RetryManager.execute(
   *   () => callProviderApi(),
   *   { maxRetries: 3, initialDelayMs: 1000, respectRetryAfter: true },
   * );
   * ```
   */
  async execute<T>(fn: () => Promise<T>, policy: AiRateLimitPolicy): Promise<T> {
    let attemptIndex = 0;

    while (true) {
      try {
        return await fn();
      } catch (err) {
        const error = err as RateLimitAwareError;

        // Non-429 errors are never retried — propagate immediately.
        if (error?.status !== 429) {
          throw err;
        }

        if (attemptIndex >= policy.maxRetries) {
          throw new CogniPipeError(
            `RetryManager: rate limit retries exhausted after ${policy.maxRetries} retries (${attemptIndex + 1} attempts made). ` +
              `The provider kept returning HTTP 429 — consider raising maxRetries or checking the API quota.`,
            {
              code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
              context: { maxRetries: policy.maxRetries, attemptsMade: attemptIndex + 1 },
              cause: err instanceof Error ? err : undefined,
            },
          );
        }

        // respectRetryAfter defaults to true — only an explicit `false` opts out.
        const shouldRespectRetryAfter = policy.respectRetryAfter !== false;
        let delayMs: number | null = null;

        if (shouldRespectRetryAfter && error.retryAfterHeader) {
          delayMs = parseRetryAfter(error.retryAfterHeader);
        }

        // Malformed/absent header, or respectRetryAfter disabled — exponential fallback.
        if (delayMs === null) {
          delayMs = policy.initialDelayMs * Math.pow(2, attemptIndex);
        }

        await sleep(delayMs);
        attemptIndex++;
      }
    }
  },
};

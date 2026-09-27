import { RetryManager, parseRetryAfter } from '../RetryManager';
import type { RateLimitAwareError } from '../RetryManager';
import { CogniPipeError, COGNIPIPE_ERROR_CODES, isCogniPipeError } from '@cognipipe/core';
import type { AiRateLimitPolicy } from '@cognipipe/types';

function make429Error(retryAfterHeader?: string): RateLimitAwareError {
  const err = new Error('Rate limited') as RateLimitAwareError;
  err.status = 429;
  if (retryAfterHeader !== undefined) {
    err.retryAfterHeader = retryAfterHeader;
  }
  return err;
}

function make500Error(): RateLimitAwareError {
  const err = new Error('Server error') as RateLimitAwareError;
  err.status = 500;
  return err;
}

describe('RetryManager', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('execute()', () => {
    it('returns result immediately if fn() succeeds on first call', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const policy: AiRateLimitPolicy = { maxRetries: 3, initialDelayMs: 1000 };

      const result = await RetryManager.execute(fn, policy);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on 429 (no Retry-After header) and returns eventual success', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockResolvedValue('success');

      const policy: AiRateLimitPolicy = { maxRetries: 3, initialDelayMs: 1000 };

      const promise = RetryManager.execute(fn, policy);
      await jest.advanceTimersByTimeAsync(1000); // after attempt 0: 1000 * 2^0
      await jest.advanceTimersByTimeAsync(2000); // after attempt 1: 1000 * 2^1

      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('propagates non-429 Error instances immediately without retrying', async () => {
      const err = make500Error();
      const fn = jest.fn().mockRejectedValue(err);
      const policy: AiRateLimitPolicy = { maxRetries: 3, initialDelayMs: 1000 };

      await expect(RetryManager.execute(fn, policy)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('propagates a non-object thrown value as-is (exercises the optional-chaining path)', async () => {
      const fn = jest.fn().mockRejectedValue(undefined);
      const policy: AiRateLimitPolicy = { maxRetries: 3, initialDelayMs: 1000 };

      await expect(RetryManager.execute(fn, policy)).rejects.toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('waits exactly Retry-After seconds when respectRetryAfter is true', async () => {
      const fn = jest.fn().mockRejectedValueOnce(make429Error('5')).mockResolvedValue('success');
      const policy: AiRateLimitPolicy = {
        maxRetries: 3,
        initialDelayMs: 1000,
        respectRetryAfter: true,
      };

      const promise = RetryManager.execute(fn, policy);

      await jest.advanceTimersByTimeAsync(4999);
      expect(fn).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('waits for HTTP-date Retry-After when respectRetryAfter is true', async () => {
      // Pin to a whole-second boundary: HTTP-date (via toUTCString()) has no
      // sub-second precision, so any leftover ms on `now` would make the
      // round-tripped header represent a time slightly earlier than intended.
      const now = Math.floor(Date.now() / 1000) * 1000;
      jest.setSystemTime(now);
      const futureDate = new Date(now + 3000).toUTCString();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(make429Error(futureDate))
        .mockResolvedValue('success');
      const policy: AiRateLimitPolicy = {
        maxRetries: 3,
        initialDelayMs: 1000,
        respectRetryAfter: true,
      };

      const promise = RetryManager.execute(fn, policy);

      await jest.advanceTimersByTimeAsync(2999);
      expect(fn).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('honors Retry-After by default when respectRetryAfter is omitted', async () => {
      // AiRateLimitPolicy.respectRetryAfter is documented to default to true.
      const fn = jest.fn().mockRejectedValueOnce(make429Error('2')).mockResolvedValue('success');
      const policy: AiRateLimitPolicy = { maxRetries: 3, initialDelayMs: 1000 };

      const promise = RetryManager.execute(fn, policy);

      await jest.advanceTimersByTimeAsync(1999);
      expect(fn).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('ignores Retry-After and uses exponential backoff when respectRetryAfter is false', async () => {
      const fn = jest.fn().mockRejectedValueOnce(make429Error('60')).mockResolvedValue('success');
      const policy: AiRateLimitPolicy = {
        maxRetries: 3,
        initialDelayMs: 1000,
        respectRetryAfter: false,
      };

      const promise = RetryManager.execute(fn, policy);

      await jest.advanceTimersByTimeAsync(1000); // exponential, not 60000ms
      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('falls back to exponential backoff when Retry-After header is malformed', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(make429Error('not-a-valid-value'))
        .mockResolvedValue('success');
      const policy: AiRateLimitPolicy = {
        maxRetries: 3,
        initialDelayMs: 1000,
        respectRetryAfter: true,
      };

      const promise = RetryManager.execute(fn, policy);

      await jest.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('doubles delay correctly across 3 attempts using exponential backoff', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockResolvedValue('success');

      const policy: AiRateLimitPolicy = { maxRetries: 5, initialDelayMs: 1000 };

      const promise = RetryManager.execute(fn, policy);

      await jest.advanceTimersByTimeAsync(1000); // 1000 * 2^0
      expect(fn).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(2000); // 1000 * 2^1
      expect(fn).toHaveBeenCalledTimes(3);

      await jest.advanceTimersByTimeAsync(4000); // 1000 * 2^2
      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('throws CogniPipeError(STEP_EXECUTION_FAILED) when all maxRetries are exhausted', async () => {
      const fn = jest.fn().mockRejectedValue(make429Error());
      const policy: AiRateLimitPolicy = { maxRetries: 2, initialDelayMs: 1000 };

      // .catch(e => e) attaches a rejection handler synchronously, before any
      // timers advance, so there's no unhandled-rejection warning under fake timers.
      const outcome = RetryManager.execute(fn, policy).catch(e => e);

      await jest.advanceTimersByTimeAsync(1000); // after attempt 0
      await jest.advanceTimersByTimeAsync(2000); // after attempt 1 -> exhausted on attempt 2

      const thrown = await outcome;

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      expect((thrown as CogniPipeError).message).toContain('2');
      expect((thrown as CogniPipeError).context).toMatchObject({
        maxRetries: 2,
        attemptsMade: 3,
      });
      expect((thrown as CogniPipeError).cause).toBeInstanceOf(Error);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('omits cause when the exhausting rejection is not an Error instance', async () => {
      const nonErrorRejection = { status: 429 } as unknown as RateLimitAwareError;
      const fn = jest.fn().mockRejectedValue(nonErrorRejection);
      const policy: AiRateLimitPolicy = { maxRetries: 0, initialDelayMs: 1000 };

      const outcome = RetryManager.execute(fn, policy).catch(e => e);
      const thrown = await outcome;

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).cause).toBeUndefined();
      expect((thrown as CogniPipeError).context).toMatchObject({
        maxRetries: 0,
        attemptsMade: 1,
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseRetryAfter()', () => {
    it('parses delay-seconds format correctly', () => {
      expect(parseRetryAfter('120')).toBe(120000);
      expect(parseRetryAfter('0')).toBe(0);
    });

    it('parses HTTP-date format correctly', () => {
      // Whole-second boundary — see note above on toUTCString()'s precision.
      const now = Math.floor(Date.now() / 1000) * 1000;
      jest.setSystemTime(now);
      const future = new Date(now + 5000).toUTCString();
      expect(parseRetryAfter(future)).toBe(5000);
    });

    it('returns 0 for an HTTP-date already in the past', () => {
      const now = Math.floor(Date.now() / 1000) * 1000;
      jest.setSystemTime(now);
      const past = new Date(now - 5000).toUTCString();
      expect(parseRetryAfter(past)).toBe(0);
    });

    it('returns null for malformed values', () => {
      expect(parseRetryAfter('not-a-valid-value')).toBeNull();
      expect(parseRetryAfter('')).toBeNull();
      expect(parseRetryAfter('-5')).toBeNull();
      expect(parseRetryAfter('12.5')).toBeNull();
      expect(parseRetryAfter('Wed, 21 Oct 2026')).toBeNull(); // wrong shape, not full IMF-fixdate
      // Matches the IMF-fixdate regex shape (3-letter tokens, right punctuation)
      // but "Zzz" isn't a real month, so `new Date()` itself returns Invalid Date —
      // this is the case the inner Number.isNaN(date.getTime()) check guards against.
      expect(parseRetryAfter('Mon, 01 Zzz 2026 00:00:00 GMT')).toBeNull();
    });
  });
});

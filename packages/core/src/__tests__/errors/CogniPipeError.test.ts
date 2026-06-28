import { CogniPipeError, isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

describe('CogniPipeError', () => {
  describe('construction', () => {
    it('creates an instance with the correct name, code, and message', () => {
      const error = new CogniPipeError('something went wrong', {
        code: COGNIPIPE_ERROR_CODES.STEP_NOT_FOUND,
      });

      expect(error.name).toBe('CogniPipeError');
      expect(error.code).toBe('STEP_NOT_FOUND');
      expect(error.message).toBe('something went wrong');
    });

    it('is an instance of Error', () => {
      const error = new CogniPipeError('msg', {
        code: COGNIPIPE_ERROR_CODES.STEP_NOT_FOUND,
      });

      expect(error instanceof Error).toBe(true);
    });

    it('is an instance of CogniPipeError', () => {
      const error = new CogniPipeError('msg', {
        code: COGNIPIPE_ERROR_CODES.STEP_NOT_FOUND,
      });

      expect(error instanceof CogniPipeError).toBe(true);
    });

    it('stores context when provided', () => {
      const context = { stepName: 'fetch-issues', attempt: 3 };
      const error = new CogniPipeError('step not found', {
        code: COGNIPIPE_ERROR_CODES.STEP_NOT_FOUND,
        context,
      });

      expect(error.context).toEqual(context);
    });

    it('context is undefined when not provided', () => {
      const error = new CogniPipeError('msg', {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR,
      });

      expect(error.context).toBeUndefined();
    });

    it('wires up native error chaining when cause is provided', () => {
      const cause = new Error('original error');
      const error = new CogniPipeError('wrapped error', {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        cause,
      });

      expect(error.cause).toBe(cause);
    });

    it('does not set cause when not provided', () => {
      const error = new CogniPipeError('msg', {
        code: COGNIPIPE_ERROR_CODES.NODE_NOT_REGISTERED,
      });

      expect(error.cause).toBeUndefined();
    });
  });

  describe('toJSON()', () => {
    it('returns name, code, and message — context key absent when not provided', () => {
      const error = new CogniPipeError('validation failed', {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR,
      });

      const json = error.toJSON();

      expect(json).toEqual({
        name: 'CogniPipeError',
        code: 'WORKFLOW_VALIDATION_ERROR',
        message: 'validation failed',
      });
      expect('context' in json).toBe(false);
    });

    it('includes context when provided', () => {
      const context = { field: 'steps', reason: 'empty array' };
      const error = new CogniPipeError('parse failed', {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR,
        context,
      });

      const json = error.toJSON();

      expect(json).toEqual({
        name: 'CogniPipeError',
        code: 'WORKFLOW_PARSE_ERROR',
        message: 'parse failed',
        context,
      });
    });

    it('produces fully JSON-serialisable output', () => {
      const error = new CogniPipeError('serialise me', {
        code: COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR,
        context: { template: '{{missing}}' },
      });

      expect(() => JSON.stringify(error.toJSON())).not.toThrow();
    });
  });

  describe('isCogniPipeError()', () => {
    it('returns true for a CogniPipeError instance', () => {
      const error = new CogniPipeError('msg', {
        code: COGNIPIPE_ERROR_CODES.STEP_NOT_FOUND,
      });

      expect(isCogniPipeError(error)).toBe(true);
    });

    it('returns false for a plain Error instance', () => {
      expect(isCogniPipeError(new Error('plain error'))).toBe(false);
    });

    it('returns false for null', () => {
      expect(isCogniPipeError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isCogniPipeError(undefined)).toBe(false);
    });

    it('returns false for a string', () => {
      expect(isCogniPipeError('STEP_NOT_FOUND')).toBe(false);
    });

    it('returns false for a duck-typed object with the same shape', () => {
      const fake = { name: 'CogniPipeError', code: 'STEP_NOT_FOUND', message: 'fake' };
      expect(isCogniPipeError(fake)).toBe(false);
    });
  });
});

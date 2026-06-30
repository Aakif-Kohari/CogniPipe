import { ExecutionContext } from '../../engine/ExecutionContext';
import { CogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

describe('ExecutionContext', () => {
  describe('immutability and store', () => {
    it('creates an empty context', () => {
      const ctx = new ExecutionContext();
      expect(ctx.has('steps')).toBe(false);
    });

    it('returns a different object reference from set()', () => {
      const ctx = new ExecutionContext();
      expect(ctx.set('k', 42)).not.toBe(ctx);
    });

    it('does not mutate the original context after set()', () => {
      const ctx = new ExecutionContext();
      ctx.set('k', 42);
      expect(ctx.has('k')).toBe(false);
    });

    it('returns the set value via get()', () => {
      const ctx = new ExecutionContext();
      expect(ctx.set('k', 42).get('k')).toBe(42);
    });

    it('supports chained set() calls', () => {
      const ctx = new ExecutionContext();
      expect(ctx.set('a', 1).set('b', 2).get('b')).toBe(2);
    });

    it('exposes seeded initial data', () => {
      const seeded = { steps: { 'fetch-issues': { output: { count: 42 } } } };
      const ctx = new ExecutionContext(seeded);
      expect(ctx.get('steps')).toEqual(seeded.steps);
    });

    it('returns a plain object of all stored entries via toJSON()', () => {
      const ctx = new ExecutionContext({ a: 1, b: 'two' });
      expect(ctx.toJSON()).toEqual({ a: 1, b: 'two' });
    });
  });

  describe('interpolation', () => {
    it('resolves a seeded nested path', () => {
      const ctx = new ExecutionContext({
        steps: { 'fetch-issues': { output: { count: 42 } } },
      });
      expect(ctx.interpolate('{{ steps.fetch-issues.output.count }}')).toBe('42');
    });

    it('returns a template with no tokens unchanged', () => {
      const ctx = new ExecutionContext();
      expect(ctx.interpolate('no tokens here')).toBe('no tokens here');
    });

    it('throws CogniPipeError with INTERPOLATION_ERROR for a missing nested step', () => {
      const ctx = new ExecutionContext({ steps: {} });
      let thrown: unknown;

      try {
        ctx.interpolate('{{ steps.missing-step.output }}');
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR);
      expect((thrown as CogniPipeError).message).toContain('steps.missing-step.output');
    });
  });
});

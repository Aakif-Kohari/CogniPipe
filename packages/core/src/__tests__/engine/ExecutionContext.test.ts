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

    it('accepts a ReadonlyMap', () => {
      const map = new Map([['x', 5]]);
      const ctx = new ExecutionContext(map);
      expect(ctx.get('x')).toBe(5);
    });

    it('returns true from has() for a key that has been set', () => {
      const ctx = new ExecutionContext();
      expect(ctx.set('x', 'hello').has('x')).toBe(true);
    });

    it('returns false from has() for a named key that was never set', () => {
      const ctx = new ExecutionContext({ present: 'yes' });
      expect(ctx.has('never-set')).toBe(false);
    });

    it('returns undefined from get() for a missing key', () => {
      const ctx = new ExecutionContext({ a: 1 });
      expect(ctx.get('missing')).toBeUndefined();
    });

    it('returns an empty object from toJSON() for a fresh context', () => {
      expect(new ExecutionContext().toJSON()).toEqual({});
    });

    it('includes all accumulated keys in toJSON() after multiple sets', () => {
      const ctx = new ExecutionContext();
      expect(ctx.set('a', 1).set('b', 2).toJSON()).toEqual({ a: 1, b: 2 });
    });
  });

  // ExecutionContext contract test for the read-modify-write accumulation
  // pattern that WorkflowExecutor uses to persist each completed step's
  // result under the reserved `steps` key without overwriting prior steps.
  // These cases verify the ExecutionContext side of that contract — set/get/
  // interpolate immutability across two merges — purely through the public
  // API. They do NOT guard WorkflowExecutor itself (which has its own
  // integration coverage); the `steps.<name>` merge shape is borrowed from
  // the executor's usage but is not a regression guard for it.
  describe('multi-step context accumulation', () => {
    // StepResult shape matches the issue #54 API specification example:
    // `{ output, completedAt, durationMs }`.
    const stepAResult = {
      output: { count: 5 },
      completedAt: '2026-07-29T00:00:00.000Z',
      durationMs: 100,
    };
    const stepBResult = {
      output: { result: 'done' },
      completedAt: '2026-07-29T00:00:01.000Z',
      durationMs: 50,
    };

    // Stores step A's result under the reserved `steps` key on a fresh context.
    const storeStepA = (): ExecutionContext =>
      new ExecutionContext().set('steps', { 'fetch-data': stepAResult });

    // Merges step B's result alongside whatever `steps` already holds, using
    // the same read-modify-write merge the executor performs between steps.
    const storeStepB = (ctx: ExecutionContext): ExecutionContext => {
      const existingSteps = (ctx.get('steps') as Record<string, unknown> | undefined) ?? {};
      return ctx.set('steps', { ...existingSteps, transform: stepBResult });
    };

    it('exposes step A under ctx.get("steps") after step A is stored', () => {
      const steps = storeStepA().get('steps') as Record<string, unknown>;
      expect(steps['fetch-data']).toEqual(stepAResult);
    });

    it('keeps both step A and step B present after step B is merged by spreading step A', () => {
      const steps = storeStepB(storeStepA()).get('steps') as Record<string, unknown>;
      expect(Object.keys(steps).sort()).toEqual(['fetch-data', 'transform']);
    });

    it('does not remove step A when step B is stored on top of it', () => {
      const steps = storeStepB(storeStepA()).get('steps') as Record<string, unknown>;
      expect(steps['fetch-data']).toEqual(stepAResult);
      expect((steps['fetch-data'] as { output: { count: number } }).output.count).toBe(5);
    });

    it('resolves step A output via ctx.interpolate("{{ steps.fetch-data.output.count }}")', () => {
      expect(storeStepA().interpolate('{{ steps.fetch-data.output.count }}')).toBe('5');
    });

    it('resolves step B output via ctx.interpolate("{{ steps.transform.output.result }}") after step B is stored', () => {
      expect(storeStepB(storeStepA()).interpolate('{{ steps.transform.output.result }}')).toBe(
        'done',
      );
    });

    it('leaves the pre-step-B context containing only step A after step B is stored', () => {
      const beforeStepB = storeStepA();
      const afterStepB = storeStepB(beforeStepB);

      // set() returns a new instance; the captured pre-step-B context must be
      // untouched and still hold only step A.
      expect(afterStepB).not.toBe(beforeStepB);
      const beforeSteps = beforeStepB.get('steps') as Record<string, unknown>;
      expect(Object.keys(beforeSteps).sort()).toEqual(['fetch-data']);
      expect(beforeSteps['transform']).toBeUndefined();
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

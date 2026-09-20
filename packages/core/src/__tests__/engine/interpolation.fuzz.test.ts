import fc from 'fast-check';
import { resolveDotPath, resolveTemplate } from '../../engine/interpolation';
import { ExecutionContext } from '../../engine/ExecutionContext';
import { isCogniPipeError } from '../../errors/CogniPipeError';

describe('resolveDotPath — property-based fuzzing', () => {
  it('never throws for any string path against any object', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), (obj, path) => {
        expect(() => resolveDotPath(obj, path)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe('resolveTemplate — property-based fuzzing', () => {
  it('returns quickly and either throws CogniPipeError or returns a string, never hangs, for arbitrary input', () => {
    const ctx = new ExecutionContext({ foo: { bar: 'baz' } });

    fc.assert(
      fc.property(fc.string(), template => {
        const start = Date.now();
        try {
          const result = resolveTemplate(template, ctx);
          expect(typeof result).toBe('string');
        } catch (err) {
          // CogniPipeError is an expected, valid outcome for malformed expressions.
          // Any other error type (e.g. TypeError) indicates a regression.
          expect(isCogniPipeError(err)).toBe(true);
        }
        expect(Date.now() - start).toBeLessThan(200); // guards against ReDoS regressions
      }),
      { numRuns: 500 },
    );
  });
});

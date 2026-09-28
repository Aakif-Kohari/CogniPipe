import { MockContext } from '../MockContext';

describe('MockContext', () => {
  it('creates an empty context', () => {
    const ctx = new MockContext();

    expect(ctx.toJSON()).toEqual({});
  });

  it('seeds initial data', () => {
    const ctx = new MockContext({ a: 1 });

    expect(ctx.get('a')).toBe(1);
  });

  it('sets and gets a value', () => {
    const ctx = new MockContext().set('k', 'v');

    expect(ctx.get('k')).toBe('v');
  });

  it('returns a new instance from set() without mutating the original', () => {
    const ctx = new MockContext();
    const next = ctx.set('a', 1);

    expect(next).not.toBe(ctx);
    expect(ctx.has('a')).toBe(false);
    expect(next.get('a')).toBe(1);
  });

  it('supports chained set() calls, each returning a new instance with accumulated data', () => {
    const ctx = new MockContext().set('a', 1).set('b', 2);

    expect(ctx.toJSON()).toEqual({ a: 1, b: 2 });
  });

  it('reports has() as true after set and false before', () => {
    const ctx = new MockContext();

    expect(ctx.has('k')).toBe(false);
    const next = ctx.set('k', 'v');
    expect(next.has('k')).toBe(true);
  });

  it('resolves a nested seeded path via interpolate()', () => {
    const ctx = new MockContext({ steps: { auth: { output: { token: 'abc' } } } });

    expect(ctx.interpolate('{{ steps.auth.output.token }}')).toBe('abc');
  });

  it('returns the string unchanged when it has no tokens', () => {
    const ctx = new MockContext();

    expect(ctx.interpolate('no tokens here')).toBe('no tokens here');
  });

  it('returns a plain object from toJSON() matching all stored entries', () => {
    const ctx = new MockContext({ x: 1, y: 'two' });

    expect(ctx.toJSON()).toEqual({ x: 1, y: 'two' });
  });

  it('throws a plain Error, not CogniPipeError, for an unresolved path', () => {
    const ctx = new MockContext();

    let thrown: unknown;
    try {
      ctx.interpolate('{{ missing.key }}');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('Error');
    expect((thrown as Error).message).toContain('missing.key');
  });

  it('throws when a single top-level key cannot be resolved', () => {
    const ctx = new MockContext();

    expect(() => ctx.interpolate('{{ missing }}')).toThrow('missing');
  });

  it('throws when a key exists but its stored value is undefined', () => {
    const ctx = new MockContext({ a: undefined });

    expect(() => ctx.interpolate('{{ a }}')).toThrow('no value found for this path');
  });

  it('throws when a null value sits on the interpolation path', () => {
    const ctx = new MockContext({ a: null });

    expect(() => ctx.interpolate('{{ a.b }}')).toThrow('a.b');
  });

  it('throws when a path segment resolves only to an inherited prototype property', () => {
    const ctx = new MockContext();

    expect(() => ctx.interpolate('{{ toString }}')).toThrow();
  });

  it('resolves instantly on an unterminated malicious token, without hanging (ReDoS guard)', () => {
    const ctx = new MockContext();
    const malicious = '{{' + ' '.repeat(50_000);
    const start = Date.now();
    const result = ctx.interpolate(malicious);

    expect(result).toBe(malicious);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

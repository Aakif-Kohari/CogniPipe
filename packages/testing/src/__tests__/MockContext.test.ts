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
    const ctx = new MockContext();
    ctx.set('k', 'v');

    expect(ctx.get('k')).toBe('v');
  });

  it('chains set() calls and mutates in place', () => {
    const ctx = new MockContext();
    const returned = ctx.set('a', 1).set('b', 2);

    expect(returned).toBe(ctx);
    expect(ctx.toJSON()).toEqual({ a: 1, b: 2 });
  });

  it('reports has() as true after set and false before', () => {
    const ctx = new MockContext();

    expect(ctx.has('k')).toBe(false);
    ctx.set('k', 'v');
    expect(ctx.has('k')).toBe(true);
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

  it('throws when a null value sits on the interpolation path', () => {
    const ctx = new MockContext({ a: null });

    expect(() => ctx.interpolate('{{ a.b }}')).toThrow('a.b');
  });
});

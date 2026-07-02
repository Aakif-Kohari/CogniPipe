import { resolveDotPath, resolveTemplate } from '../../engine/interpolation';
import { ExecutionContext } from '../../engine/ExecutionContext';
import { CogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

describe('resolveDotPath', () => {
  it('resolves a simple nested path', () => {
    expect(resolveDotPath({ a: { b: 'c' } }, 'a.b')).toBe('c');
  });

  it('resolves an array index', () => {
    expect(resolveDotPath({ items: ['x', 'y'] }, 'items[1]')).toBe('y');
  });

  it('resolves a mixed path with array index and nested object', () => {
    expect(resolveDotPath({ a: { b: [{ name: 'Alice' }] } }, 'a.b[0].name')).toBe('Alice');
  });

  it('resolves hyphenated segment names', () => {
    expect(resolveDotPath({ 'fetch-issues': { output: 'data' } }, 'fetch-issues.output')).toBe(
      'data',
    );
  });

  it('resolves a top-level array path', () => {
    expect(resolveDotPath({ items: ['a', 'b'] }, 'items[0]')).toBe('a');
  });

  it('returns obj itself for an empty path', () => {
    const obj = { a: 1 };
    expect(resolveDotPath(obj, '')).toBe(obj);
  });

  it('returns undefined for a missing nested segment without throwing', () => {
    expect(resolveDotPath({ a: 1 }, 'a.b')).toBeUndefined();
  });

  it('returns undefined for a null root without throwing', () => {
    expect(resolveDotPath(null, 'a')).toBeUndefined();
  });

  it('returns undefined for an undefined root without throwing', () => {
    expect(resolveDotPath(undefined, 'a')).toBeUndefined();
  });
});

describe('resolveTemplate', () => {
  const ctx = new ExecutionContext({
    steps: {
      'fetch-issues': {
        output: { count: 42, users: [{ name: 'Alice' }] },
      },
      summarize: { output: { model: 'claude' } },
    },
  });

  it('resolves a token when the root key and path both exist', () => {
    expect(resolveTemplate('{{ steps.fetch-issues.output.count }}', ctx)).toBe('42');
  });

  it('resolves array indices inside a token', () => {
    expect(resolveTemplate('{{ steps.fetch-issues.output.users[0].name }}', ctx)).toBe('Alice');
  });

  it('resolves a top-level array index', () => {
    const arrayCtx = new ExecutionContext({
      items: ['apple', 'banana'],
    });
    expect(resolveTemplate('{{ items[0] }}', arrayCtx)).toBe('apple');
  });

  it('resolves a top-level array index with a nested property', () => {
    const arrayCtx = new ExecutionContext({
      users: [{ name: 'Alice' }, { name: 'Bob' }],
    });
    expect(resolveTemplate('{{ users[1].name }}', arrayCtx)).toBe('Bob');
  });

  it('returns a string with no tokens unchanged', () => {
    expect(resolveTemplate('plain string', ctx)).toBe('plain string');
  });

  it('resolves multiple tokens in a single pass', () => {
    const result = resolveTemplate(
      '{{ steps.fetch-issues.output.count }} issues — model: {{ steps.summarize.output.model }}',
      ctx,
    );
    expect(result).toBe('42 issues — model: claude');
  });

  it('coerces a numeric resolved value to its string representation', () => {
    expect(resolveTemplate('{{ steps.fetch-issues.output.count }}', ctx)).toBe('42');
  });

  it('throws INTERPOLATION_ERROR when the root value is null', () => {
    const nullCtx = new ExecutionContext({
      foo: null,
    });
    let thrown: unknown;
    try {
      resolveTemplate('{{ foo }}', nullCtx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof CogniPipeError).toBe(true);
    expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR);
    expect((thrown as CogniPipeError).message).toContain('foo');
  });

  it('throws INTERPOLATION_ERROR when a nested value is null', () => {
    const nullCtx = new ExecutionContext({
      foo: {
        bar: null,
      },
    });
    let thrown: unknown;
    try {
      resolveTemplate('{{ foo.bar }}', nullCtx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof CogniPipeError).toBe(true);
    expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR);
    expect((thrown as CogniPipeError).message).toContain('foo.bar');
  });

  it('throws INTERPOLATION_ERROR naming the full expression when the nested path is missing', () => {
    let thrown: unknown;
    try {
      resolveTemplate('{{ steps.missing-step.output }}', ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof CogniPipeError).toBe(true);
    expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR);
    expect((thrown as CogniPipeError).message).toContain('steps.missing-step.output');
  });

  it('throws INTERPOLATION_ERROR naming the missing root key', () => {
    let thrown: unknown;
    try {
      resolveTemplate('{{ nonexistent.key }}', ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof CogniPipeError).toBe(true);
    expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR);
    expect((thrown as CogniPipeError).message).toContain('nonexistent');
  });

  it('throws INTERPOLATION_ERROR for an empty expression', () => {
    let thrown: unknown;
    try {
      resolveTemplate('{{ }}', ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof CogniPipeError).toBe(true);
    expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR);
  });
});

describe('resolveTemplate — ReDoS resistance (CodeQL js/polynomial-redos)', () => {
  const ctx = new ExecutionContext({
    steps: {
      'fetch-issues': {
        output: { count: 42 },
      },
    },
  });

  it('resolves instantly on an unterminated token followed by many spaces', () => {
    const malicious = '{{' + ' '.repeat(100_000);
    const start = Date.now();
    const result = resolveTemplate(malicious, ctx);
    const elapsed = Date.now() - start;

    // No closing "}}" exists, so the token never matches and the string
    // is returned unchanged. Before the fix, this input caused the regex
    // engine's backtracking to blow up (would time out well past 1s).
    expect(result).toBe(malicious);
    expect(elapsed).toBeLessThan(200);
  });

  it('resolves instantly on a token opener followed by many spaces then a pipe', () => {
    const malicious = '{{|' + ' '.repeat(100_000);
    const start = Date.now();
    const result = resolveTemplate(malicious, ctx);
    const elapsed = Date.now() - start;

    expect(result).toBe(malicious);
    expect(elapsed).toBeLessThan(200);
  });

  it('still resolves a well-formed token surrounded by lots of incidental whitespace', () => {
    const template = '{{   steps.fetch-issues.output.count   }}';
    expect(resolveTemplate(template, ctx)).toBe('42');
  });
  it('resolves instantly on many repeated unterminated openers (quadratic-scan regression)', () => {
    const malicious = '{{'.repeat(60_000);
    const start = Date.now();
    const result = resolveTemplate(malicious, ctx);
    const elapsed = Date.now() - start;

    // Every "{{" is a potential match start with no closing "}}" anywhere.
    // The naive fix ([^}]+) let '{' slip into the content class, so each of
    // the ~60k overlapping start positions triggered its own full scan to
    // end-of-string before failing — O(n²). Excluding '{' too makes every
    // failed start position fail in O(1).
    expect(result).toBe(malicious);
    expect(elapsed).toBeLessThan(200);
  });
});

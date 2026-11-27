/**
 * @module TransformNode.test
 *
 * Unit tests for TransformNode: all three operations, config validation
 * (NODE_CONFIG_INVALID), data errors (STEP_EXECUTION_FAILED), decorator
 * metadata, and ReDoS regression guards for the linear `${path}` scanner.
 * Everything is in-memory — no network. A small inline IExecutionContext is
 * used instead of adding @cognipipe/testing as a dependency.
 */

import { performance } from 'node:perf_hooks';
import { TransformNode } from '../src/index';
import * as publicApi from '../src/index';
import { CogniPipeError, COGNIPIPE_ERROR_CODES, isCogniPipeError } from '@cognipipe/core';
import * as sdk from '@cognipipe/sdk';
import type { IExecutionContext } from '@cognipipe/types';

/**
 * Wrap defineConfig so tests can reach the parser instance TransformNode creates
 * at module load. The wrapper delegates to the real implementation, so every
 * other test runs against the real schema unchanged.
 */
jest.mock('@cognipipe/sdk', () => {
  const actual = jest.requireActual('@cognipipe/sdk');
  return { __esModule: true, ...actual, defineConfig: jest.fn(actual.defineConfig) };
});

/** Minimal in-memory IExecutionContext: a key/value store, no interpolation. */
class TestContext implements IExecutionContext {
  readonly #store: Map<string, unknown>;

  constructor(seed: Record<string, unknown> = {}) {
    this.#store = new Map(Object.entries(seed));
  }

  get(key: string): unknown {
    return this.#store.get(key);
  }

  set(key: string, value: unknown): TestContext {
    return new TestContext({ ...this.toJSON(), [key]: value });
  }

  has(key: string): boolean {
    return this.#store.has(key);
  }

  interpolate(template: string): string {
    return template;
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#store);
  }
}

/** Context shaped like a real run: upstream output lives at steps.<name>.output. */
function ctxWithBody(body: unknown): TestContext {
  return new TestContext({ steps: { fetch: { output: { body } } } });
}

/**
 * Fastest of `attempts` runs, in milliseconds. Wall-clock guards use the best
 * run on purpose: a quadratic scan is slow on EVERY run (seconds), while a busy
 * machine — turbo running every package's tests in parallel — only slows some
 * of them. This keeps the budget meaningful without flaking.
 */
async function fastestMs(attempts: number, run: () => Promise<unknown>): Promise<number> {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const start = performance.now();
    await run();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

describe('TransformNode', () => {
  let node: TransformNode;
  const emptyCtx = new TestContext();

  beforeEach(() => {
    node = new TransformNode();
  });

  describe('metadata and exports', () => {
    it('registers cogniNodeMeta with the package type and version', () => {
      expect(TransformNode.cogniNodeMeta?.type).toBe('@cognipipe/node-transform');
      expect(TransformNode.cogniNodeMeta?.version).toBe('1.0.0');
    });

    it('exports TransformNode and parseCsv from the package entry point', () => {
      expect(Object.keys(publicApi).sort()).toEqual(['TransformNode', 'parseCsv']);
    });
  });

  describe('pick', () => {
    it('picks fields from an object given as an input JSON string', async () => {
      const out = await node.execute(
        {
          operation: 'pick',
          input: '{"fact":"Cats sleep a lot","length":18,"extra":true}',
          fields: ['fact', 'length'],
        },
        emptyCtx,
      );
      expect(out).toEqual({
        operation: 'pick',
        result: { fact: 'Cats sleep a lot', length: 18 },
      });
    });

    it('picks fields from a live object read via inputPath', async () => {
      const ctx = ctxWithBody({ fact: 'Cats purr', length: 9, extra: 'drop me' });
      const out = await node.execute(
        { operation: 'pick', inputPath: 'steps.fetch.output.body', fields: ['fact', 'length'] },
        ctx,
      );
      expect(out).toEqual({ operation: 'pick', result: { fact: 'Cats purr', length: 9 } });
    });

    it('parses a JSON string found at inputPath', async () => {
      const ctx = ctxWithBody('{"fact":"Cats nap","length":8}');
      const out = await node.execute(
        { operation: 'pick', inputPath: 'steps.fetch.output.body', fields: ['fact'] },
        ctx,
      );
      expect(out).toEqual({ operation: 'pick', result: { fact: 'Cats nap' } });
    });

    it('supports a root-only path with a [0] index in inputPath', async () => {
      const ctx = new TestContext({ items: [{ a: 1, b: 2 }] });
      const out = await node.execute(
        { operation: 'pick', inputPath: 'items[0]', fields: ['a'] },
        ctx,
      );
      expect(out).toEqual({ operation: 'pick', result: { a: 1 } });
    });

    it('reads a root-only inputPath that has no dot or bracket', async () => {
      const ctx = new TestContext({ payload: { a: 1, b: 2 } });
      const out = await node.execute(
        { operation: 'pick', inputPath: 'payload', fields: ['a'] },
        ctx,
      );
      expect(out).toEqual({ operation: 'pick', result: { a: 1 } });
    });

    it('picks per element for an array input', async () => {
      const ctx = ctxWithBody([
        { fact: 'one', length: 3, extra: 1 },
        { fact: 'two', length: 3, extra: 2 },
      ]);
      const out = await node.execute(
        { operation: 'pick', inputPath: 'steps.fetch.output.body', fields: ['fact', 'length'] },
        ctx,
      );
      expect(out).toEqual({
        operation: 'pick',
        result: [
          { fact: 'one', length: 3 },
          { fact: 'two', length: 3 },
        ],
      });
    });

    it('omits missing fields entirely — no undefined or null placeholders', async () => {
      const out = await node.execute(
        { operation: 'pick', input: '{"fact":"x"}', fields: ['fact', 'nope'] },
        emptyCtx,
      );
      expect(out.result).toEqual({ fact: 'x' });
      expect(Object.keys(out.result as Record<string, unknown>)).toEqual(['fact']);
    });

    it('omits fields whose live value is undefined', async () => {
      const ctx = ctxWithBody({ a: undefined, b: 2 });
      const out = await node.execute(
        { operation: 'pick', inputPath: 'steps.fetch.output.body', fields: ['a', 'b'] },
        ctx,
      );
      expect(Object.keys(out.result as Record<string, unknown>)).toEqual(['b']);
    });

    it('orders result keys by fields, not by source-object order', async () => {
      const out = await node.execute(
        { operation: 'pick', input: '{"fact":"x","length":1}', fields: ['length', 'fact'] },
        emptyCtx,
      );
      expect(Object.keys(out.result as Record<string, unknown>)).toEqual(['length', 'fact']);
    });

    it('keeps a null that is really present in the source', async () => {
      const out = await node.execute(
        { operation: 'pick', input: '{"a":null,"b":2}', fields: ['a', 'b'] },
        emptyCtx,
      );
      expect(out.result).toEqual({ a: null, b: 2 });
    });

    it('does not pick inherited members such as toString or __proto__', async () => {
      const out = await node.execute(
        { operation: 'pick', input: '{"a":1}', fields: ['toString', '__proto__', 'a'] },
        emptyCtx,
      );
      expect(out.result).toEqual({ a: 1 });
    });

    it('keeps an own "__proto__" key from JSON as plain data without polluting prototypes', async () => {
      const out = await node.execute(
        {
          operation: 'pick',
          input: '{"__proto__":{"polluted":true},"a":1}',
          fields: ['__proto__'],
        },
        emptyCtx,
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.keys(out.result as Record<string, unknown>)).toEqual(['__proto__']);
    });

    it('throws STEP_EXECUTION_FAILED for invalid JSON, echoing at most 80 characters', async () => {
      expect.assertions(5);
      const bad = 'x'.repeat(5000);
      try {
        await node.execute({ operation: 'pick', input: bad, fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('as JSON');
          expect(err.message).toContain('x'.repeat(80));
          expect(err.message).not.toContain('x'.repeat(81));
        }
      }
    });

    it('attaches the SyntaxError as the cause for invalid JSON', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'pick', input: '{nope', fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.cause).toBeInstanceOf(SyntaxError);
        }
      }
    });

    it('still reports invalid JSON, without a cause, when the parser throws a non-Error', async () => {
      expect.assertions(3);
      const spy = jest.spyOn(JSON, 'parse').mockImplementation(() => {
        // Deliberately not an Error object.
        throw 'not an Error object';
      });
      try {
        await node.execute({ operation: 'pick', input: '{}', fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.cause).toBeUndefined();
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('names inputPath when the JSON text found there is invalid', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'pick', inputPath: 'steps.fetch.output.body', fields: ['a'] },
          ctxWithBody('not json'),
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('inputPath "steps.fetch.output.body"');
        }
      }
    });

    it.each([
      ['a number', '42'],
      ['a string', '"just text"'],
      ['null', 'null'],
    ])('throws STEP_EXECUTION_FAILED when the parsed input is %s', async (_label, input) => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'pick', input, fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('pick requires an object');
        }
      }
    });

    it('throws STEP_EXECUTION_FAILED when inputPath points at a number', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'pick', inputPath: 'steps.fetch.output.body', fields: ['a'] },
          ctxWithBody(42),
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('pick requires an object');
        }
      }
    });

    it('names the index for a non-object array element', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'pick', input: '[{"a":1},7]', fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('index 1');
        }
      }
    });

    it('rejects a nested array element rather than picking from it', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'pick', input: '[[1]]', fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('an array');
        }
      }
    });

    it('names the path when the context root key is missing', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'pick', inputPath: 'steps.missing.output.body', fields: ['a'] },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('steps.missing.output.body');
        }
      }
    });

    it('names the path when it is unresolved deeper inside an existing root', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'pick', inputPath: 'steps.fetch.output.nope', fields: ['a'] },
          ctxWithBody({}),
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('steps.fetch.output.nope');
        }
      }
    });

    it('names the path when it resolves to null', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'pick', inputPath: 'steps.fetch.output.body', fields: ['a'] },
          ctxWithBody(null),
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('steps.fetch.output.body');
        }
      }
    });

    it('rejects a path with no root key', async () => {
      expect.assertions(2);
      try {
        await node.execute(
          { operation: 'pick', inputPath: '.body', fields: ['a'] },
          ctxWithBody({}),
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        }
      }
    });

    it('echoes at most 80 characters of a long inputPath, in the message and the context', async () => {
      expect.assertions(5);
      const path = 'a'.repeat(5000);
      const shown = `${'a'.repeat(80)}…`;
      try {
        await node.execute({ operation: 'pick', inputPath: path, fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain(shown);
          expect(err.message).not.toContain('a'.repeat(81));
          expect(err.context).toEqual({ path: shown, rootKey: shown });
        }
      }
    });
  });

  describe('parseCsv', () => {
    it('maps rows to records with rowCount in header mode (the default)', async () => {
      const out = await node.execute(
        { operation: 'parseCsv', input: 'name,age\nAda,36\nGrace,45\n' },
        emptyCtx,
      );
      expect(out).toEqual({
        operation: 'parseCsv',
        result: [
          { name: 'Ada', age: '36' },
          { name: 'Grace', age: '45' },
        ],
        rowCount: 2,
      });
    });

    it('returns string[][] including the first row when header: false', async () => {
      const out = await node.execute(
        { operation: 'parseCsv', input: 'name,age\nAda,36\n', header: false },
        emptyCtx,
      );
      expect(out).toEqual({
        operation: 'parseCsv',
        result: [
          ['name', 'age'],
          ['Ada', '36'],
        ],
        rowCount: 2,
      });
    });

    it('supports a custom ";" delimiter', async () => {
      const out = await node.execute(
        { operation: 'parseCsv', input: 'name;age\nAda;36', delimiter: ';' },
        emptyCtx,
      );
      expect(out.result).toEqual([{ name: 'Ada', age: '36' }]);
    });

    it('handles quoted delimiters, "" escapes and embedded newlines', async () => {
      const out = await node.execute(
        {
          operation: 'parseCsv',
          input: 'name,note\nAda,"likes, commas"\nGrace,"said ""hi"""\nMulti,"line\nbreak"',
        },
        emptyCtx,
      );
      expect(out).toMatchObject({ rowCount: 3 });
      expect(out.result).toEqual([
        { name: 'Ada', note: 'likes, commas' },
        { name: 'Grace', note: 'said "hi"' },
        { name: 'Multi', note: 'line\nbreak' },
      ]);
    });

    it('handles CRLF input', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: 'a,b\r\n1,2\r\n' }, emptyCtx);
      expect(out.result).toEqual([{ a: '1', b: '2' }]);
    });

    it('strips a UTF-8 BOM so the first header name is clean', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: '﻿a,b\n1,2' }, emptyCtx);
      expect(out.result).toEqual([{ a: '1', b: '2' }]);
    });

    it('ignores one trailing newline', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: 'a,b\n1,2\n' }, emptyCtx);
      expect(out).toMatchObject({ rowCount: 1 });
      expect(out.result).toEqual([{ a: '1', b: '2' }]);
    });

    it('turns a blank line into a record of empty strings and drops only ONE trailing newline', async () => {
      const out = await node.execute(
        { operation: 'parseCsv', input: 'a,b\n1,2\n\n3,4\n\n' },
        emptyCtx,
      );
      expect(out).toMatchObject({ rowCount: 4 });
      expect(out.result).toEqual([
        { a: '1', b: '2' },
        { a: '', b: '' },
        { a: '3', b: '4' },
        { a: '', b: '' },
      ]);
    });

    it('pads a short row with empty strings', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: 'a,b,c\n1,2\n' }, emptyCtx);
      expect(out.result).toEqual([{ a: '1', b: '2', c: '' }]);
    });

    it('keeps every value a string — no type coercion', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: 'n,b\n007,true\n' }, emptyCtx);
      expect(out.result).toEqual([{ n: '007', b: 'true' }]);
    });

    it('returns result: [] and rowCount: 0 for an empty CSV string', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: '' }, emptyCtx);
      expect(out).toEqual({ operation: 'parseCsv', result: [], rowCount: 0 });
    });

    it('returns result: [] and rowCount: 0 for an empty CSV string with header: false', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: '', header: false }, emptyCtx);
      expect(out).toEqual({ operation: 'parseCsv', result: [], rowCount: 0 });
    });

    it('returns result: [] and rowCount: 0 for a header-only CSV', async () => {
      const out = await node.execute({ operation: 'parseCsv', input: 'a,b' }, emptyCtx);
      expect(out).toEqual({ operation: 'parseCsv', result: [], rowCount: 0 });
    });

    it('parses a field that is just "" as an empty string', async () => {
      const out = await node.execute(
        { operation: 'parseCsv', input: '""', header: false },
        emptyCtx,
      );
      expect(out.result).toEqual([['']]);
    });

    it('keeps a "__proto__" header as plain data without polluting prototypes', async () => {
      const out = await node.execute(
        { operation: 'parseCsv', input: '__proto__,a\npolluted,1' },
        emptyCtx,
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const [record] = out.result as Array<Record<string, string>>;
      expect(Object.keys(record ?? {})).toEqual(['__proto__', 'a']);
    });

    it('throws STEP_EXECUTION_FAILED for an unterminated quote', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'parseCsv', input: 'a,b\n"1,2' }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('unterminated quoted field');
        }
      }
    });

    it('throws STEP_EXECUTION_FAILED for duplicate header names', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'parseCsv', input: 'name,name\n1,2' }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('duplicate column name "name"');
        }
      }
    });

    it('echoes at most 80 characters of a long duplicate header name, in the message and the context', async () => {
      expect.assertions(5);
      const name = 'x'.repeat(5000);
      try {
        await node.execute({ operation: 'parseCsv', input: `${name},${name}\n1,2` }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain(`${'x'.repeat(80)}…`);
          expect(err.message).not.toContain('x'.repeat(81));
          expect(err.context).toEqual({ column: `${'x'.repeat(80)}…` });
        }
      }
    });

    it('allows duplicate values in the first row when header: false', async () => {
      const out = await node.execute(
        { operation: 'parseCsv', input: 'x,x\n1,2', header: false },
        emptyCtx,
      );
      expect(out.result).toEqual([
        ['x', 'x'],
        ['1', '2'],
      ]);
    });

    it('names the 1-based row (header is row 1) for a row with too many cells', async () => {
      expect.assertions(5);
      try {
        await node.execute(
          { operation: 'parseCsv', input: 'a,b,c,d\n1,2,3,4\n1,2,3,4,5' },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('row 3');
          expect(err.message).toContain('header is row 1');
          expect(err.message).toContain('5 cells');
        }
      }
    });
  });

  describe('template', () => {
    const data = {
      user: {
        name: 'Ada',
        profile: { city: 'London' },
        roles: ['admin', 'dev'],
        age: 36,
        active: true,
        meta: { k: 1 },
        nothing: null,
      },
    };

    it('fills nested dot paths', async () => {
      const out = await node.execute(
        { operation: 'template', template: 'Hi ${user.name} from ${user.profile.city}', data },
        emptyCtx,
      );
      expect(out).toEqual({ operation: 'template', result: 'Hi Ada from London' });
    });

    it('supports [0] array indices', async () => {
      const out = await node.execute(
        { operation: 'template', template: '${user.roles[0]}/${user.roles[1]}', data },
        emptyCtx,
      );
      expect(out.result).toBe('admin/dev');
    });

    it('formats numbers and booleans via String()', async () => {
      const out = await node.execute(
        { operation: 'template', template: '${user.age} ${user.active}', data },
        emptyCtx,
      );
      expect(out.result).toBe('36 true');
    });

    it('formats objects and arrays via JSON.stringify', async () => {
      const out = await node.execute(
        { operation: 'template', template: '${user.meta} ${user.roles}', data },
        emptyCtx,
      );
      expect(out.result).toBe('{"k":1} ["admin","dev"]');
    });

    it('inserts strings as-is, without JSON quoting or HTML escaping', async () => {
      const out = await node.execute(
        { operation: 'template', template: '${v}', data: { v: '<b>"hi"</b>' } },
        emptyCtx,
      );
      expect(out.result).toBe('<b>"hi"</b>');
    });

    it('trims whitespace inside a placeholder', async () => {
      const out = await node.execute(
        { operation: 'template', template: '${ user.name }', data },
        emptyCtx,
      );
      expect(out.result).toBe('Ada');
    });

    it('produces a literal ${ for the \\${ escape', async () => {
      const out = await node.execute(
        { operation: 'template', template: '\\${user.name} stays literal', data },
        emptyCtx,
      );
      expect(out.result).toBe('${user.name} stays literal');
    });

    it('leaves text without placeholders unchanged, including {{ }}', async () => {
      const out = await node.execute(
        { operation: 'template', template: 'plain {{ text }} $ { }', data },
        emptyCtx,
      );
      expect(out.result).toBe('plain {{ text }} $ { }');
    });

    it('reads data from the context via dataPath', async () => {
      const ctx = new TestContext({ steps: { build: { output: { user: { name: 'Grace' } } } } });
      const out = await node.execute(
        { operation: 'template', template: 'Hello ${name}', dataPath: 'steps.build.output.user' },
        ctx,
      );
      expect(out.result).toBe('Hello Grace');
    });

    it('reads a root-only dataPath that has no dot or bracket', async () => {
      const ctx = new TestContext({ user: { name: 'Grace' } });
      const out = await node.execute(
        { operation: 'template', template: 'Hello ${name}', dataPath: 'user' },
        ctx,
      );
      expect(out.result).toBe('Hello Grace');
    });

    it('accepts an array at dataPath and indexes it with a numeric segment', async () => {
      const ctx = new TestContext({ rows: [{ name: 'Ada' }] });
      const out = await node.execute(
        { operation: 'template', template: '${0.name}', dataPath: 'rows' },
        ctx,
      );
      expect(out.result).toBe('Ada');
    });

    it('copies malformed placeholders through as literal text', async () => {
      const out = await node.execute(
        { operation: 'template', template: '${user.name and ${a{b}', data },
        emptyCtx,
      );
      expect(out.result).toBe('${user.name and ${a{b}');
    });

    it('copies an unterminated placeholder at the end of the text through as literal text', async () => {
      const out = await node.execute(
        { operation: 'template', template: 'Hi ${user.name', data },
        emptyCtx,
      );
      expect(out.result).toBe('Hi ${user.name');
    });

    it('names a placeholder that resolves to undefined', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'template', template: 'Hi ${user.missing}', data },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('${user.missing}');
        }
      }
    });

    it('names a placeholder that resolves to null', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'template', template: 'Hi ${user.nothing}', data },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('${user.nothing}');
        }
      }
    });

    it('rejects an empty ${} placeholder', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'template', template: 'x ${} y', data }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('${}');
        }
      }
    });

    it('names the path when dataPath is unresolved', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'template', template: '${name}', dataPath: 'steps.nope.output.user' },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('steps.nope.output.user');
        }
      }
    });

    it('rejects a dataPath that resolves to a non-object', async () => {
      expect.assertions(4);
      const ctx = new TestContext({ steps: { build: { output: { user: 42 } } } });
      try {
        await node.execute(
          { operation: 'template', template: '${name}', dataPath: 'steps.build.output.user' },
          ctx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('to be an object');
          expect(err.message).toContain('number');
        }
      }
    });

    it('names the placeholder for a value that cannot be serialized to JSON', async () => {
      expect.assertions(3);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      try {
        await node.execute(
          { operation: 'template', template: '${loop}', data: { loop: circular } },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('${loop}');
        }
      }
    });

    it('reports a toJSON() that throws a non-Error without a cause', async () => {
      expect.assertions(4);
      const hostile = {
        toJSON(): never {
          // Deliberately not an Error object.
          throw 'not an Error object';
        },
      };
      try {
        await node.execute(
          { operation: 'template', template: '${bad}', data: { bad: hostile } },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('${bad}');
          expect(err.cause).toBeUndefined();
        }
      }
    });

    it('echoes at most 80 characters of a hostile placeholder body, in the message and the context, without slowing down', async () => {
      expect.assertions(6);
      const body = '[1'.repeat(50_000);
      const config = { operation: 'template', template: '${' + body + '}', data: {} };
      const shown = `${body.slice(0, 80)}…`;
      try {
        await node.execute(config, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain(shown);
          expect(err.message).not.toContain(body.slice(0, 81));
          expect(err.context).toEqual({ placeholder: shown });
        }
      }
      // Also exercises core's resolveDotPath regex on a hostile body.
      const fastest = await fastestMs(5, () =>
        node.execute(config, emptyCtx).catch(() => undefined),
      );
      expect(fastest).toBeLessThan(200);
    });
  });

  describe('config validation (NODE_CONFIG_INVALID)', () => {
    it('rejects pick with BOTH input and inputPath', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'pick', input: '{}', inputPath: 'steps.x.output', fields: ['a'] },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('exactly one of');
        }
      }
    });

    it('rejects pick with NEITHER input nor inputPath', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'pick', fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('exactly one of');
        }
      }
    });

    it('rejects template with BOTH data and dataPath', async () => {
      expect.assertions(3);
      try {
        await node.execute(
          { operation: 'template', template: '${a}', data: { a: 1 }, dataPath: 'steps.x.output' },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('exactly one of');
        }
      }
    });

    it('rejects template with NEITHER data nor dataPath', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'template', template: '${a}' }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('exactly one of');
        }
      }
    });

    it('rejects an empty fields array', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'pick', input: '{}', fields: [] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('fields');
        }
      }
    });

    it('rejects an unknown operation, mentioning operation in the message', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'merge', input: '{}' }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('operation');
        }
      }
    });

    it('rejects a missing operation, mentioning operation in the message', async () => {
      expect.assertions(3);
      try {
        await node.execute({ input: '{}' }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('operation');
        }
      }
    });

    it('rejects a multi-character delimiter', async () => {
      expect.assertions(3);
      try {
        await node.execute({ operation: 'parseCsv', input: 'a;;b', delimiter: ';;' }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('delimiter');
        }
      }
    });

    it.each([['"'], ['\n'], ['\r']])(
      'rejects %j as a delimiter because it is reserved by the CSV grammar',
      async delimiter => {
        expect.assertions(3);
        try {
          await node.execute({ operation: 'parseCsv', input: 'a,b', delimiter }, emptyCtx);
        } catch (err) {
          expect(isCogniPipeError(err)).toBe(true);
          if (isCogniPipeError(err)) {
            expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
            expect(err.message).toContain('delimiter');
          }
        }
      },
    );

    it('rejects parseCsv without input', async () => {
      expect.assertions(2);
      try {
        await node.execute({ operation: 'parseCsv' }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
        }
      }
    });

    it('bounds context.received for a long invalid delimiter, keeping code and message', async () => {
      expect.assertions(5);
      const delimiter = 'x'.repeat(5000);
      try {
        await node.execute({ operation: 'parseCsv', input: 'a,b', delimiter }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('delimiter');
          expect(err.context).toEqual({ path: 'delimiter', received: `${'x'.repeat(80)}…` });
          expect(err.cause).toBeUndefined();
        }
      }
    });

    it('reduces a non-string rejected value to its type, never serialising it', async () => {
      expect.assertions(4);
      try {
        await node.execute({ operation: 'parseCsv', input: { big: 'y'.repeat(5000) } }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.context).toEqual({ path: 'input', received: 'object' });
          expect(JSON.stringify(err.context)).not.toContain('yy');
        }
      }
    });

    it('bounds the second field of an "exactly one of" violation', async () => {
      expect.assertions(4);
      try {
        await node.execute(
          { operation: 'pick', input: '{}', inputPath: 'p'.repeat(5000), fields: ['a'] },
          emptyCtx,
        );
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toContain('exactly one of');
          expect(err.context).toEqual({ path: 'inputPath', received: `${'p'.repeat(80)}…` });
        }
      }
    });

    it.each([
      ['an unknown operation', { operation: 'merge', input: '{}' }, 'merge'],
      ['a missing operation', { input: '{}' }, 'undefined'],
    ])(
      'keeps short or absent values readable in context.received for %s',
      async (_label, config, received) => {
        expect.assertions(3);
        try {
          await node.execute(config, emptyCtx);
        } catch (err) {
          expect(isCogniPipeError(err)).toBe(true);
          if (isCogniPipeError(err)) {
            expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
            expect(err.context).toEqual({ path: 'operation', received });
          }
        }
      },
    );

    /** The parser TransformNode built at module load via the wrapped defineConfig. */
    const parser = (sdk.defineConfig as unknown as jest.Mock).mock.results[0]?.value as {
      parse: (config: unknown) => unknown;
    };

    it('passes a non-config error from the parser through unchanged', async () => {
      expect.assertions(2);
      const boom = new Error('parser blew up');
      const spy = jest.spyOn(parser, 'parse').mockImplementationOnce(() => {
        throw boom;
      });
      try {
        await node.execute({ operation: 'pick', input: '{}', fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(err).toBe(boom);
        expect(isCogniPipeError(err)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('still bounds a NODE_CONFIG_INVALID error that carries no context', async () => {
      expect.assertions(4);
      const spy = jest.spyOn(parser, 'parse').mockImplementationOnce(() => {
        throw new CogniPipeError('schema failed without an issue', {
          code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
        });
      });
      try {
        await node.execute({ operation: 'pick', input: '{}', fields: ['a'] }, emptyCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
          expect(err.message).toBe('schema failed without an issue');
          expect(err.context).toEqual({ path: '', received: 'undefined' });
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('ReDoS regression (linear template scan)', () => {
    it.each([
      ['"${".repeat(60_000)', '${'.repeat(60_000)],
      ['"${" followed by 100_000 spaces', '${' + ' '.repeat(100_000)],
      ['"${ ".repeat(60_000)', '${ '.repeat(60_000)],
    ])('%s completes in < 200 ms without hanging', async (_label, template) => {
      const config = { operation: 'template', template, data: {} };

      const out = await node.execute(config, emptyCtx);
      expect(out.result).toBe(template);

      const fastest = await fastestMs(5, () => node.execute(config, emptyCtx));
      expect(fastest).toBeLessThan(200);
    });
  });
});

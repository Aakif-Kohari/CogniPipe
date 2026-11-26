/**
 * @module csv.test
 *
 * Unit tests for the pure RFC 4180 tokenizer: quoting, "" escapes, embedded
 * newlines, CRLF/LF, BOM stripping, trailing-newline handling, custom
 * delimiters, error cases, and a 1 MB linear-time performance guard.
 * Everything is in-memory — no network, no fixtures on disk.
 */

import { performance } from 'node:perf_hooks';
import { parseCsv } from '../src/csv';
import { COGNIPIPE_ERROR_CODES, isCogniPipeError } from '@cognipipe/core';

/**
 * Fastest of `attempts` runs, in milliseconds. Wall-clock guards use the best
 * run on purpose: a quadratic parser is slow on EVERY run (seconds), while a
 * busy machine — turbo running every package's tests in parallel — only slows
 * some of them. This keeps the budget meaningful without flaking.
 */
function fastestMs(attempts: number, run: () => unknown): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const start = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

describe('parseCsv', () => {
  describe('basic parsing', () => {
    it('parses simple rows', () => {
      expect(parseCsv('a,b\n1,2')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('returns [] for an empty string', () => {
      expect(parseCsv('')).toEqual([]);
    });

    it('returns [] for a single newline', () => {
      expect(parseCsv('\n')).toEqual([]);
    });

    it('returns [] for BOM-only input', () => {
      expect(parseCsv('﻿')).toEqual([]);
    });

    it('keeps empty cells, including a trailing one', () => {
      expect(parseCsv('a,,c\nd,\n')).toEqual([
        ['a', '', 'c'],
        ['d', ''],
      ]);
    });

    it('does not pad or trim rows — header semantics belong to the node', () => {
      expect(parseCsv('a,b\n1')).toEqual([['a', 'b'], ['1']]);
    });

    it('keeps surrounding spaces in unquoted cells', () => {
      expect(parseCsv(' a , b ')).toEqual([[' a ', ' b ']]);
    });
  });

  describe('line endings, BOM and trailing newline', () => {
    it('strips a leading UTF-8 BOM', () => {
      expect(parseCsv('﻿a,b\n1,2')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('ignores exactly one trailing LF', () => {
      expect(parseCsv('a,b\n1,2\n')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('ignores exactly one trailing CRLF', () => {
      expect(parseCsv('a,b\n1,2\r\n')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('keeps the empty final record when two newlines trail', () => {
      expect(parseCsv('a\n\n')).toEqual([['a'], ['']]);
    });

    it('handles CRLF record separators', () => {
      expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('handles mixed LF and CRLF separators', () => {
      expect(parseCsv('a,b\r\n1,2\n3,4\r\n')).toEqual([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('treats a lone CR as data — only CRLF and LF separate records', () => {
      expect(parseCsv('a\rb')).toEqual([['a\rb']]);
    });
  });

  describe('quoting', () => {
    it('parses a quoted field containing the delimiter', () => {
      expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
    });

    it('unescapes "" inside quoted fields', () => {
      expect(parseCsv('"c""d",x')).toEqual([['c"d', 'x']]);
    });

    it('keeps an embedded LF inside quotes', () => {
      expect(parseCsv('"e\nf",x')).toEqual([['e\nf', 'x']]);
    });

    it('keeps an embedded CRLF inside quotes verbatim', () => {
      expect(parseCsv('"e\r\nf",x')).toEqual([['e\r\nf', 'x']]);
    });

    it('does not start a new record for a newline inside quotes', () => {
      expect(parseCsv('"a\nb"\n"c"')).toEqual([['a\nb'], ['c']]);
    });

    it('parses a field that is just "" as an empty string', () => {
      expect(parseCsv('""')).toEqual([['']]);
    });

    it('parses four quotes as a single literal quote', () => {
      expect(parseCsv('""""')).toEqual([['"']]);
    });

    it('treats a quote in the middle of an unquoted field as literal data', () => {
      expect(parseCsv('a"b')).toEqual([['a"b']]);
    });

    it('treats a quote after a leading space as literal data (it must open the field)', () => {
      expect(parseCsv('a, "b"')).toEqual([['a', ' "b"']]);
    });
  });

  describe('delimiters', () => {
    it('supports a custom ";" delimiter', () => {
      expect(parseCsv('a;b\n1;2', ';')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('supports a tab delimiter', () => {
      expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('treats the default delimiter as data when another delimiter is set', () => {
      expect(parseCsv('a,b;c', ';')).toEqual([['a,b', 'c']]);
    });

    it.each([
      ['an empty string', ''],
      ['a multi-character string', ';;'],
      ['a double quote', '"'],
      ['a CR', '\r'],
      ['an LF', '\n'],
    ])(
      'throws NODE_CONFIG_INVALID when called directly with %s as the delimiter',
      (_label, delimiter) => {
        expect.assertions(3);
        try {
          parseCsv('a,b', delimiter);
        } catch (err) {
          expect(isCogniPipeError(err)).toBe(true);
          if (isCogniPipeError(err)) {
            expect(err.code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
            expect(err.message).toContain('exactly one character');
          }
        }
      },
    );
  });

  describe('errors', () => {
    it('throws STEP_EXECUTION_FAILED for an unterminated quote, naming row 1', () => {
      expect.assertions(4);
      try {
        parseCsv('"abc');
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('unterminated quoted field');
          expect(err.message).toContain('row 1');
        }
      }
    });

    it('names the right row when the unterminated quote is on a later record', () => {
      expect.assertions(3);
      try {
        parseCsv('a,b\n"c,d');
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('row 2');
        }
      }
    });

    it('treats a quoted field whose closing quote was the trailing newline as unterminated', () => {
      expect.assertions(2);
      try {
        parseCsv('"abc\n');
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.message).toContain('unterminated quoted field');
        }
      }
    });

    it('throws STEP_EXECUTION_FAILED for text after a closing quote, naming the row', () => {
      expect.assertions(4);
      try {
        parseCsv('a\n"b"x');
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        if (isCogniPipeError(err)) {
          expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
          expect(err.message).toContain('after a closing quote');
          expect(err.message).toContain('row 2');
        }
      }
    });
  });

  describe('performance', () => {
    it('parses a 1 MB CSV in under 1 s (single-pass, linear)', () => {
      const csv = 'id,name,value\n' + '12345,abcdefgh,98.6\n'.repeat(60_000);
      expect(csv.length).toBeGreaterThan(1_000_000);

      expect(parseCsv(csv)).toHaveLength(60_001);
      expect(fastestMs(3, () => parseCsv(csv))).toBeLessThan(1000);
    });

    it('parses a 1 MB single quoted field in under 1 s', () => {
      const csv = `"${'x'.repeat(1_000_000)}"`;

      expect(parseCsv(csv)[0]?.[0]).toHaveLength(1_000_000);
      expect(fastestMs(3, () => parseCsv(csv))).toBeLessThan(1000);
    });
  });
});

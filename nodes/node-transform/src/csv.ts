/**
 * @module csv
 *
 * Pure, in-house RFC 4180 CSV tokenizer used by TransformNode's `parseCsv`
 * operation. A single left-to-right pass over the input with a four-state
 * machine — no regex over the input and no backtracking — so untrusted CSV
 * text is parsed in linear time.
 *
 * Scope (v1):
 * - Quoted fields, `""` escapes inside quotes, newlines inside quotes.
 * - Record separators are CRLF or LF. A lone CR outside quotes is field data.
 * - An optional leading UTF-8 BOM is stripped and exactly one trailing newline
 *   is ignored.
 * - A quote at the very start of a field opens a quoted field; a quote in the
 *   middle of an unquoted field is kept as literal data (lenient, like most
 *   CSV writers).
 * - Every cell stays a string — no type coercion.
 *
 * Header semantics (record mapping, duplicate names, ragged rows) live in
 * TransformNode, not here: this module only produces raw rows.
 */

import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';

/** Character codes compared in the hot loop — avoids one-character string allocations. */
const QUOTE = 34; // '"'
const CR = 13; // '\r'
const LF = 10; // '\n'
const BOM = 0xfeff;

/** States of the single-pass tokenizer. */
type CsvState = 'fieldStart' | 'unquoted' | 'quoted' | 'afterQuote';

/**
 * Parses RFC 4180 CSV text into rows of string cells.
 *
 * Pure function: no I/O, no shared state, deterministic for a given input.
 * Runs in O(n) time with one pass over the input, so it is safe on untrusted
 * text.
 *
 * "Row" in error messages is the 1-based record number counting the first
 * record as row 1 (a newline embedded inside a quoted field does not start a
 * new record).
 *
 * @param input - The raw CSV text. A leading UTF-8 BOM is stripped and exactly
 *   one trailing newline (CRLF or LF) is ignored. Empty input yields `[]`.
 * @param delimiter - Field delimiter: exactly one character, and not `"`, CR
 *   or LF. Defaults to `','`.
 * @returns The records, each an array of string cells. Rows are NOT padded or
 *   trimmed here — header semantics belong to the caller.
 * @throws {CogniPipeError} `NODE_CONFIG_INVALID` if `delimiter` is not exactly
 *   one character or is a quote or line break (TransformNode validates this
 *   up front; the check protects direct callers). `STEP_EXECUTION_FAILED` if a
 *   quoted field is never closed, or a closing quote is followed by anything
 *   other than a delimiter, a newline, or a second quote (`""` escape).
 *
 * @example
 * ```typescript
 * parseCsv('name,age\nAda,36\n'); // → [['name', 'age'], ['Ada', '36']]
 * parseCsv('a;b\n1;2', ';'); //      → [['a', 'b'], ['1', '2']]
 * parseCsv('""'); //                 → [['']]
 * ```
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  // The tokenizer compares one character code per step. A delimiter that is not
  // a single code unit, or that collides with the quote/newline characters the
  // grammar already owns, would make the parse ambiguous.
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new CogniPipeError(
      'CSV delimiter must be exactly one character and cannot be a double quote or a line break.',
      { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID },
    );
  }
  const delimiterCode = delimiter.charCodeAt(0);

  let text = input;
  if (text.charCodeAt(0) === BOM) {
    text = text.slice(1);
  }
  if (text.endsWith('\r\n')) {
    text = text.slice(0, -2);
  } else if (text.endsWith('\n')) {
    text = text.slice(0, -1);
  }
  if (text === '') {
    return [];
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: CsvState = 'fieldStart';
  const length = text.length;
  let i = 0;

  while (i < length) {
    const code = text.charCodeAt(i);

    if (state === 'quoted') {
      // Inside quotes everything is data — delimiters and newlines included —
      // until the closing quote.
      if (code === QUOTE) {
        state = 'afterQuote';
      } else {
        field += text.charAt(i);
      }
      i += 1;
    } else if (state === 'afterQuote' && code === QUOTE) {
      // "" inside a quoted field is an escaped literal quote.
      field += '"';
      state = 'quoted';
      i += 1;
    } else if (code === delimiterCode) {
      row.push(field);
      field = '';
      state = 'fieldStart';
      i += 1;
    } else if (code === LF || (code === CR && text.charCodeAt(i + 1) === LF)) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      state = 'fieldStart';
      i += code === CR ? 2 : 1;
    } else if (state === 'afterQuote') {
      throw new CogniPipeError(
        `CSV parse failed in row ${rows.length + 1}: unexpected character ${JSON.stringify(text.charAt(i))} after a closing quote. Only a delimiter, a newline, or a second quote (an escaped "") may follow a closing quote.`,
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { row: rows.length + 1 },
        },
      );
    } else if (state === 'fieldStart' && code === QUOTE) {
      state = 'quoted';
      i += 1;
    } else {
      // Unquoted data. A quote here (not at the start of the field) is literal.
      field += text.charAt(i);
      state = 'unquoted';
      i += 1;
    }
  }

  if (state === 'quoted') {
    throw new CogniPipeError(
      `CSV parse failed in row ${rows.length + 1}: unterminated quoted field. Add the missing closing '"' before the end of the input.`,
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { row: rows.length + 1 },
      },
    );
  }

  // One trailing newline was stripped above, so a pending record is always real
  // — even an empty one ('a\n\n' keeps its final empty record).
  row.push(field);
  rows.push(row);
  return rows;
}

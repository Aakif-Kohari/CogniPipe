/**
 * @module TransformNode
 *
 * Data-transformation node for CogniPipe workflows. Shapes data between steps
 * with three operations, selected by a Zod discriminated union on `operation`:
 *
 * - `pick`     — keep only listed top-level fields of an object (or of every
 *                object in an array).
 * - `parseCsv` — parse RFC 4180 CSV text into rows (in-house parser, csv.ts).
 * - `template` — fill a `${path}` template from data.
 *
 * Two engine constraints shape the design (see README.md):
 * 1. WorkflowExecutor resolves `{{ }}` in every config string BEFORE the node
 *    runs, so a value interpolated into config reaches the node as text. To get
 *    a live object or array, the node reads it from the context by path
 *    (`inputPath` / `dataPath`).
 * 2. `{{ }}` is consumed by the engine and throws when it cannot be resolved,
 *    so the template operation uses its own `${path}` syntax, scanned linearly.
 */

import { BaseNode, CogniNode, defineConfig } from '@cognipipe/sdk';
import type { IExecutionContext, NodeConfig } from '@cognipipe/types';
import {
  CogniPipeError,
  COGNIPIPE_ERROR_CODES,
  isCogniPipeError,
  resolveDotPath,
} from '@cognipipe/core';
import { z } from 'zod';
import { parseCsv } from './csv.js';

/**
 * `pick` — exactly one of `input` (a JSON string) / `inputPath` (a context
 * path) is required; that cross-field rule is checked on the union below so the
 * discriminated parse can narrow first.
 */
const PickOperationSchema = z.object({
  operation: z.literal('pick'),
  fields: z.array(z.string()).min(1, 'fields must list at least one field name'),
  input: z.string().optional(),
  inputPath: z.string().min(1).optional(),
});

/** `parseCsv` — RFC 4180 text in, rows out. Every cell stays a string in v1. */
const ParseCsvOperationSchema = z.object({
  operation: z.literal('parseCsv'),
  input: z.string(),
  delimiter: z
    .string()
    .length(1, 'delimiter must be exactly one character')
    .refine(
      char => char !== '"' && char !== '\r' && char !== '\n',
      'delimiter cannot be a double quote or a line break',
    )
    .default(','),
  header: z.boolean().default(true),
});

/**
 * `template` — exactly one of `data` / `dataPath` is required (checked on the
 * union below). Placeholders use `${path}`, never `{{ }}`: the engine owns and
 * consumes the latter before the node ever runs.
 */
const TemplateOperationSchema = z.object({
  operation: z.literal('template'),
  template: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  dataPath: z.string().min(1).optional(),
});

const TransformConfigSchema = z
  .discriminatedUnion('operation', [
    PickOperationSchema,
    ParseCsvOperationSchema,
    TemplateOperationSchema,
  ])
  .superRefine((cfg, ctx) => {
    // Cross-field "exactly one of" checks run after the discriminated parse, so
    // `cfg` is already narrowed to a single operation here.
    const exactlyOne = (a: unknown, b: unknown, aName: string, bName: string): void => {
      const hasA = a !== undefined;
      const hasB = b !== undefined;
      if (hasA === hasB) {
        ctx.addIssue({
          code: 'custom',
          path: [hasA ? bName : aName],
          message: `operation "${cfg.operation}" requires exactly one of "${aName}" or "${bName}" — ${
            hasA ? 'remove one of them' : 'provide one of them'
          }.`,
        });
      }
    };
    if (cfg.operation === 'pick') {
      exactlyOne(cfg.input, cfg.inputPath, 'input', 'inputPath');
    } else if (cfg.operation === 'template') {
      exactlyOne(cfg.data, cfg.dataPath, 'data', 'dataPath');
    }
  });

/** Runtime-validated config parser (failures become NODE_CONFIG_INVALID). */
const TransformConfigParser = defineConfig(TransformConfigSchema);

/**
 * Raw (pre-validation) config accepted by TransformNode, inferred from the Zod
 * schema. Defaults (`delimiter`, `header`) are optional on this side.
 */
export type TransformConfig = z.input<typeof TransformConfigSchema>;

/**
 * Successful output of TransformNode — one shape per operation.
 * `pick` and `template` return `{ operation, result }`; `parseCsv` also returns
 * `rowCount` (data rows — the header row is not counted when `header: true`).
 */
export type TransformOutput =
  | { operation: 'pick'; result: Record<string, unknown> | Array<Record<string, unknown>> }
  | { operation: 'parseCsv'; result: Array<Record<string, string>> | string[][]; rowCount: number }
  | { operation: 'template'; result: string };

type PickOperation = z.infer<typeof PickOperationSchema>;
type ParseCsvOperation = z.infer<typeof ParseCsvOperationSchema>;
type TemplateOperation = z.infer<typeof TemplateOperationSchema>;

/** Maximum characters of untrusted input echoed into an error message or its context. */
const MAX_INPUT_EXCERPT_CHARS = 80;

/** Character codes for the template scanner. */
const BACKSLASH = 92; // '\'
const OPEN_BRACE = 123; // '{'
const CLOSE_BRACE = 125; // '}'

/**
 * Bounds untrusted input echoed into error messages and `context` — never
 * dumps whole payloads (`cognipipe run` prints `err.context` in full).
 */
function excerpt(value: string): string {
  return value.length > MAX_INPUT_EXCERPT_CHARS
    ? `${value.slice(0, MAX_INPUT_EXCERPT_CHARS)}…`
    : value;
}

/** Names a value's kind for error messages: "null", "an array", or its `typeof`. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'an array' : typeof value;
}

/**
 * Reads a value from the execution context by path. The root key is the text
 * before the first `.` or `[` (the same split the engine's `{{ }}` interpolation
 * uses); it is read with `ctx.get()` and the remainder is resolved with core's
 * `resolveDotPath`, which understands dot paths and `[0]` indices.
 */
function readFromContext(
  ctx: IExecutionContext,
  path: string,
  configKey: 'inputPath' | 'dataPath',
): unknown {
  const separatorIndex = path.search(/[.[\]]/);
  const rootKey = separatorIndex === -1 ? path : path.slice(0, separatorIndex);
  const remainder = separatorIndex === -1 ? '' : path.slice(separatorIndex);
  // Bound only the echoed copies — lookup and resolution use the real values.
  const shownPath = excerpt(path);
  const shownRoot = excerpt(rootKey);

  const stored = rootKey === '' ? undefined : ctx.get(rootKey);
  if (stored === undefined || stored === null) {
    throw new CogniPipeError(
      `Transform could not resolve ${configKey} "${shownPath}": context key "${shownRoot}" is missing or null. Ensure the referenced step ran before this one (add it to dependsOn).`,
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { path: shownPath, rootKey: shownRoot },
      },
    );
  }

  const value = resolveDotPath(stored, remainder);
  if (value === undefined || value === null) {
    throw new CogniPipeError(
      `Transform could not resolve ${configKey} "${shownPath}": the path resolved to undefined or null. Check the field names and array indices.`,
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { path: shownPath, rootKey: shownRoot },
      },
    );
  }
  return value;
}

/** Parses a JSON string input, echoing at most a bounded excerpt on failure. */
function parseJsonInput(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CogniPipeError(
      `pick could not parse ${source} as JSON. The text starts with: ${JSON.stringify(excerpt(raw))}. Expected a JSON object or array.`,
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        cause: err instanceof Error ? err : undefined,
      },
    );
  }
}

/**
 * Keeps only the listed top-level fields, in `fields` order. Missing (or
 * undefined-valued) fields are omitted — never placeholders. A `null` that is
 * really present in the source is data and is kept.
 */
function pickFields(
  source: unknown,
  fields: string[],
  elementIndex?: number,
): Record<string, unknown> {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    const where =
      elementIndex === undefined ? 'the input' : `the input array element at index ${elementIndex}`;
    throw new CogniPipeError(
      `pick requires an object (or an array of objects), but ${where} is ${describeValue(source)}.`,
      { code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED, context: { elementIndex } },
    );
  }
  const record = source as Record<string, unknown>;
  // Object.hasOwn skips inherited members, and Object.fromEntries defines own
  // data properties, so a hostile key like "__proto__" cannot touch a prototype.
  return Object.fromEntries(
    fields
      .filter(field => Object.hasOwn(record, field) && record[field] !== undefined)
      .map((field): [string, unknown] => [field, record[field]]),
  );
}

/** `pick`: resolve the input, parse JSON text, pick per element for arrays. */
function runPick(cfg: PickOperation, ctx: IExecutionContext): TransformOutput {
  let value: unknown =
    cfg.inputPath !== undefined ? readFromContext(ctx, cfg.inputPath, 'inputPath') : cfg.input;
  if (typeof value === 'string') {
    // The path is config text (possibly interpolated from upstream data), so
    // its echoed label is bounded like every other untrusted echo.
    const source =
      cfg.inputPath !== undefined ? `inputPath "${excerpt(cfg.inputPath)}"` : '"input"';
    value = parseJsonInput(value, source);
  }
  if (Array.isArray(value)) {
    return {
      operation: 'pick',
      result: value.map((element, index) => pickFields(element, cfg.fields, index)),
    };
  }
  return { operation: 'pick', result: pickFields(value, cfg.fields) };
}

/** `parseCsv`: tokenize, then apply header semantics when enabled. */
function runParseCsv(cfg: ParseCsvOperation): TransformOutput {
  const rows = parseCsv(cfg.input, cfg.delimiter);
  if (!cfg.header) {
    return { operation: 'parseCsv', result: rows, rowCount: rows.length };
  }

  const [headerRow, ...dataRows] = rows;
  if (headerRow === undefined) {
    return { operation: 'parseCsv', result: [], rowCount: 0 };
  }

  const seen = new Set<string>();
  for (const name of headerRow) {
    if (seen.has(name)) {
      const shown = excerpt(name);
      throw new CogniPipeError(
        `CSV header has a duplicate column name ${JSON.stringify(shown)}. Rename or remove the duplicate column, or set header: false.`,
        { code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED, context: { column: shown } },
      );
    }
    seen.add(name);
  }

  const result = dataRows.map((cells, index) => {
    if (cells.length > headerRow.length) {
      // The header is row 1, so the first data row is row 2 — the number a
      // spreadsheet shows (unless a quoted field spans several lines).
      const row = index + 2;
      throw new CogniPipeError(
        `CSV row ${row} (the header is row 1) has ${cells.length} cells, but the header defines ${headerRow.length} columns. Remove the extra cells or fix the quoting.`,
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { row, cells: cells.length, columns: headerRow.length },
        },
      );
    }
    // Short rows are padded with ''. fromEntries is safe for keys like "__proto__".
    return Object.fromEntries(
      headerRow.map((name, column): [string, string] => [name, cells[column] ?? '']),
    );
  });
  return { operation: 'parseCsv', result, rowCount: result.length };
}

/** Resolves one `${path}` placeholder body against the data root and formats it. */
function resolvePlaceholder(body: string, data: object): string {
  if (body === '') {
    throw new CogniPipeError(
      'Template placeholder "${}" is empty. Give it a path such as "${user.name}".',
      { code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED },
    );
  }

  // The body is template text (possibly interpolated from upstream data), so
  // only its bounded copy is echoed — resolution uses the real body.
  const shown = excerpt(body);
  const value = resolveDotPath(data, body);
  if (value === undefined || value === null) {
    throw new CogniPipeError(
      `Template placeholder "\${${shown}}" resolved to ${value === null ? 'null' : 'undefined'}. Provide a value at this path in "data" (or in the context at "dataPath").`,
      { code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED, context: { placeholder: shown } },
    );
  }

  if (typeof value === 'object') {
    // Objects and arrays would become "[object Object]" / "a,b" via String();
    // embed them as JSON instead.
    let json: string | undefined;
    let cause: Error | undefined;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      cause = err instanceof Error ? err : undefined;
    }
    if (json === undefined) {
      throw new CogniPipeError(
        `Template placeholder "\${${shown}}" resolved to a value that cannot be serialized to JSON (circular reference, BigInt, or a toJSON() that threw).`,
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { placeholder: shown },
          cause,
        },
      );
    }
    return json;
  }

  return String(value);
}

/**
 * Linear scan for `${path}` placeholders. A placeholder body may not contain
 * `{` or `}`; a malformed opener (no closing `}` before the next `{` or the end
 * of the text) is copied through literally, the way the engine leaves an
 * unmatched `{{` alone. `\${` produces a literal `${`.
 *
 * `indexOf` jumps from opener to opener, plain text between them is copied as
 * whole slices, and the body probe stops at the next brace, so every character
 * is probed at most once and hostile input such as `'${'.repeat(60_000)` stays
 * O(n). No regex runs over the template — this repo has had a ReDoS finding in
 * interpolation.
 */
function renderTemplate(template: string, data: object): string {
  const parts: string[] = [];
  let literalStart = 0; // start of the pending run of plain text
  let from = 0; // where to look for the next `${`

  for (;;) {
    const opener = template.indexOf('${', from);
    if (opener === -1) {
      break;
    }

    if (opener > 0 && template.charCodeAt(opener - 1) === BACKSLASH) {
      // `\${` — drop the backslash and keep a literal `${`.
      parts.push(template.slice(literalStart, opener - 1), '${');
      literalStart = opener + 2;
      from = literalStart;
      continue;
    }

    let end = opener + 2;
    while (end < template.length) {
      const bodyCode = template.charCodeAt(end);
      if (bodyCode === CLOSE_BRACE || bodyCode === OPEN_BRACE) {
        break;
      }
      end += 1;
    }

    if (end < template.length && template.charCodeAt(end) === CLOSE_BRACE) {
      parts.push(
        template.slice(literalStart, opener),
        resolvePlaceholder(template.slice(opener + 2, end).trim(), data),
      );
      literalStart = end + 1;
      from = literalStart;
    } else {
      // Malformed placeholder — the opener stays in the pending literal run.
      from = opener + 2;
    }
  }

  parts.push(template.slice(literalStart));
  return parts.join('');
}

/** `template`: resolve the data root, then render. */
function runTemplate(cfg: TemplateOperation, ctx: IExecutionContext): TransformOutput {
  const data: unknown =
    cfg.dataPath !== undefined ? readFromContext(ctx, cfg.dataPath, 'dataPath') : cfg.data;
  if (data === null || typeof data !== 'object') {
    throw new CogniPipeError(
      `template requires "data" to be an object (or "dataPath" to resolve to one), but it is ${describeValue(data)}.`,
      { code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED },
    );
  }
  return { operation: 'template', result: renderTemplate(cfg.template, data) };
}

/**
 * Summarises a rejected config value for error context: a string is cut like every other
 * echo, anything else is reduced to its kind ("object", "an array", "number", "null",
 * "undefined"). Never serialises the value.
 */
function summarizeReceived(value: unknown): string {
  return typeof value === 'string' ? excerpt(value) : describeValue(value);
}

/**
 * Validates `config` with the shared parser but re-throws schema failures with a bounded
 * `context`. defineConfig() puts the complete rejected value in `context.received`, and
 * `cognipipe run` prints `err.context` in full; config values can come from upstream
 * `{{ }}` output, so the raw value must not travel. Code and message are unchanged, and
 * the original error is deliberately NOT attached as `cause` (it would keep the full
 * value reachable).
 */
function parseConfig(config: NodeConfig) {
  try {
    return TransformConfigParser.parse(config);
  } catch (err) {
    if (!isCogniPipeError(err) || err.code !== COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID) {
      throw err;
    }
    const path = err.context?.['path'];
    throw new CogniPipeError(err.message, {
      code: err.code,
      context: {
        path: typeof path === 'string' ? excerpt(path) : '',
        received: summarizeReceived(err.context?.['received']),
      },
    });
  }
}

/**
 * Data-transformation node: JSON pick, CSV parse, text template.
 *
 * Config is a discriminated union on `operation` — see README.md for every
 * field, the output shapes, and the two engine constraints behind
 * `inputPath` / `dataPath` and the `${path}` template syntax.
 *
 * @example
 * ```yaml
 * steps:
 *   - name: fetch-fact
 *     uses: '@cognipipe/node-http'
 *     config:
 *       url: 'https://catfact.ninja/fact'
 *       method: GET
 *   - name: log-result
 *     uses: '@cognipipe/node-transform'
 *     dependsOn: ['fetch-fact']
 *     config:
 *       operation: pick
 *       inputPath: 'steps.fetch-fact.output.body'
 *       fields: ['fact', 'length']
 * ```
 */
@CogniNode({ type: '@cognipipe/node-transform', version: '1.0.0' })
export class TransformNode extends BaseNode {
  /**
   * Executes the configured transform operation.
   *
   * @param config - The step's config block, validated against the
   *   discriminated union via `defineConfig()` before any work happens.
   * @param ctx - Current execution context; read by `inputPath` / `dataPath`.
   * @returns `{ operation, result }`, plus `rowCount` for `parseCsv`.
   * @throws {CogniPipeError} `NODE_CONFIG_INVALID` for schema failures (its
   *   `context` is `{ path, received }`, where `received` is a string cut to 80
   *   characters or, for any other value, just its type);
   *   `STEP_EXECUTION_FAILED` for bad data (invalid JSON, ragged CSV, unresolved
   *   paths or placeholders). Data errors echo at most the first 80 characters
   *   of any untrusted input, in both the message and the error `context`.
   */
  async execute(config: NodeConfig, ctx: IExecutionContext): Promise<TransformOutput> {
    const cfg = parseConfig(config);
    switch (cfg.operation) {
      case 'pick':
        return runPick(cfg, ctx);
      case 'parseCsv':
        return runParseCsv(cfg);
      case 'template':
        return runTemplate(cfg, ctx);
    }
  }
}

# @cognipipe/node-transform

Data-transformation node for CogniPipe workflows: pick fields from JSON, parse CSV, and fill text templates.

> **Status:** private package, not yet published to npm. First-publish and
> Trusted Publisher setup on npmjs.com is a maintainer task tracked
> separately — this package stays `"private": true` until that's done.

## TransformNode

One node, three operations. The `operation` field selects which one runs, and
each operation has its own config shape. Every config is validated with Zod
before any work happens. A missing or invalid field fails fast with a message
that names it. Unknown keys are ignored, as in the other nodes, so double-check
optional field names (`delimiter`, `header`).

| Operation  | What it does                                                                          | Output                            |
| ---------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| `pick`     | Keeps only the listed top-level fields of an object (or of each element of an array). | `{ operation, result }`           |
| `parseCsv` | Parses RFC 4180 CSV text into records (or raw rows).                                  | `{ operation, result, rowCount }` |
| `template` | Fills a `${path}` template from an object.                                            | `{ operation, result }`           |

No runtime dependencies beyond the CogniPipe workspace packages and `zod` — the
CSV parser is written in-house.

### Why `inputPath` / `dataPath`, and why `${path}`

Two engine behaviors shape this node's config:

1. **`{{ }}` values arrive as text.** `WorkflowExecutor` resolves every `{{ }}`
   expression in a step's config _before_ the node runs. A value interpolated
   into `input` is therefore a string — the engine coerces resolved values with
   `String()`, so an object arrives as `[object Object]` and an array is
   comma-joined. To receive the **live** value instead, the node can read it
   from the execution context itself: put the path in `inputPath` (or
   `dataPath`), **without** `{{ }}` around it.
2. **`{{ }}` is reserved for the engine.** It throws on any expression it
   cannot resolve, so a template that used `{{ }}` placeholders could never
   reach this node. The `template` operation uses `${path}` placeholders
   instead.

An `inputPath` / `dataPath` looks like `steps.fetch-fact.output.body`. The root
key (the text before the first `.` or `[`) is read from the context, and the
rest is resolved with dot paths and `[0]` array indices.

### `pick`

Keeps only the listed top-level fields. Fields that are missing are omitted from
the result — they never appear as `undefined` or `null` placeholders. If the
input is an array, every element is picked individually.

```yaml
steps:
  - name: fetch-fact
    uses: '@cognipipe/node-http'
    config:
      url: 'https://catfact.ninja/fact'
      method: GET

  - name: log-result
    uses: '@cognipipe/node-transform'
    dependsOn: ['fetch-fact']
    config:
      operation: pick
      inputPath: 'steps.fetch-fact.output.body'
      fields: ['fact', 'length']
```

| Field       | Type       | Required | Notes                                                                                             |
| ----------- | ---------- | -------- | ------------------------------------------------------------------------------------------------- |
| `operation` | `'pick'`   | ✅       |                                                                                                   |
| `fields`    | `string[]` | ✅       | At least one top-level key. Nested paths are not supported in v1.                                 |
| `input`     | `string`   | one of   | A JSON string (an object or an array of objects).                                                 |
| `inputPath` | `string`   | one of   | Context path to the value. A JSON string found there is parsed; an object or array is used as-is. |

**Exactly one** of `input` / `inputPath` is required. A non-object input (a
number, a string, `null`) is an error.

Downstream steps read the result with:

```yaml
fact: '{{ steps.log-result.output.result.fact }}'
```

### `parseCsv`

Parses RFC 4180 CSV: quoted fields, `""` as an escaped quote, newlines inside
quotes, CRLF or LF row endings. A leading UTF-8 BOM is stripped and one trailing
newline is ignored. Every cell stays a **string** — `'007'` is not turned into a
number.

```yaml
- name: parse
  uses: '@cognipipe/node-transform'
  config:
    operation: parseCsv
    input: "name,age\nAda,36\nGrace,45"
```

→ `{ operation: 'parseCsv', result: [{ name: 'Ada', age: '36' }, { name: 'Grace', age: '45' }], rowCount: 2 }`

| Field       | Type         | Required | Default | Notes                                                                                                                                         |
| ----------- | ------------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation` | `'parseCsv'` | ✅       | —       |                                                                                                                                               |
| `input`     | `string`     | ✅       | —       | The CSV text. To parse a value from an earlier step, interpolate it: `'{{ steps.x.output.body }}'`.                                           |
| `delimiter` | `string`     | —        | `','`   | Exactly one character. Cannot be `"`, a carriage return, or a line feed.                                                                      |
| `header`    | `boolean`    | —        | `true`  | `true`: the first row names the columns and `result` is an array of records. `false`: `result` is a `string[][]` that includes the first row. |

Behavior worth knowing:

- **Short rows are padded** with `''` up to the header's width. **Longer rows are
  an error** that names the row — counted the way a spreadsheet counts, so the
  header is row 1 and the first data row is row 2.
- **Duplicate header names are an error** (when `header: true`).
- A **blank line** is a record with one empty cell (padded with `''` in header
  mode), so it appears in `result` and `rowCount`. Only **one** trailing newline
  is dropped; a file ending in two newlines gains a final all-empty record.
- An **empty CSV** and a **header-only CSV** both return `result: []` and
  `rowCount: 0`. `rowCount` counts data rows; the header is not included.
- An **unterminated quote**, or text directly after a closing quote, is an error.

### `template`

Fills `${path}` placeholders from an object. Paths use dots and `[0]` indices:
`${user.name}`, `${items[0].title}`.

```yaml
- name: greet
  uses: '@cognipipe/node-transform'
  dependsOn: ['load-user']
  config:
    operation: template
    template: 'Hello ${name}, you live in ${address.city}.'
    dataPath: 'steps.load-user.output.body'
```

| Field       | Type         | Required | Notes                                                                       |
| ----------- | ------------ | -------- | --------------------------------------------------------------------------- |
| `operation` | `'template'` | ✅       |                                                                             |
| `template`  | `string`     | ✅       | Text containing `${path}` placeholders. Write `\${` for a literal `${`.     |
| `data`      | `object`     | one of   | Inline data. String values may use `{{ }}`, and arrive as text.             |
| `dataPath`  | `string`     | one of   | Context path to an object (an array also works; index it with `${0.name}`). |

> In YAML, write the escape in a plain or single-quoted scalar
> (`template: 'cost \${x}'`); a double-quoted scalar rejects `\$`. In a JSON
> workflow write `\\${`.

**Exactly one** of `data` / `dataPath` is required.

How values are inserted:

| Value                        | Inserted as                          |
| ---------------------------- | ------------------------------------ |
| string                       | as-is — no quoting, no escaping      |
| number, boolean              | `String(value)`                      |
| object, array                | `JSON.stringify(value)`              |
| `undefined`, `null`, missing | **error** that names the placeholder |

Whitespace inside a placeholder is trimmed (`${ name }` equals `${name}`). A `${`
that never closes with `}` is left in the text as-is, the way the engine leaves
an unmatched `{{` alone. An empty `${}` is an error.

## Errors

- Invalid config → `CogniPipeError(NODE_CONFIG_INVALID)`: an unknown or missing `operation`, an empty `fields` array, both or neither of `input` / `inputPath` (or `data` / `dataPath`), a `delimiter` that is not exactly one character or is a quote or line break. The message names the offending field. The error's `context` is `{ path, received }`; `received` is a string cut to 80 characters, or just the type (`object`, `an array`, `number`, `null`, `undefined`) for anything else.
- Bad data → `CogniPipeError(STEP_EXECUTION_FAILED)`: invalid JSON, a non-object `pick` input, a ragged or malformed CSV, a duplicate header, an `inputPath` / `dataPath` that resolves to nothing (or `null`), or a template placeholder that resolves to nothing. The message names the path, row, or placeholder involved.
- Error messages never dump a whole payload: any untrusted input echoed back is cut to its first 80 characters (the `context` attached to the error is bounded the same way; `cognipipe run` prints it).

## Security notes

- **No backtracking-prone regex runs over untrusted input.** The CSV parser is a single-pass state machine and the template renderer is a linear scan; the only regexes involved are the single-class, linear patterns in core's `resolveDotPath` and the root-key split. Hostile input such as `'${'.repeat(60_000)` cannot trigger catastrophic backtracking; the tests pin this with timing checks.
- Keys such as `__proto__` are copied as plain own properties (`Object.fromEntries`), so they cannot pollute a prototype.
- `pick` only reads own properties — it will not return inherited members such as `toString`.

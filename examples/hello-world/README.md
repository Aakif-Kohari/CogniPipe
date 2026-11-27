# Hello World — CogniPipe Example

A minimal two-step workflow that demonstrates the core CogniPipe `workflow.yaml`
syntax: sequential steps wired together with `dependsOn`, where a later step
reads an earlier step's output from the shared context.

## What this workflow does

The workflow fetches a random cat fact from the public `catfact.ninja` API in an
HTTP step, then passes the response body into a transform step that picks just
the `fact` and `length` fields. It is the smallest example that exercises the core
building blocks a real CogniPipe pipeline relies on — a `name`/`version` header,
two steps connected by `dependsOn`, and an `inputPath` of the form
`steps.<step-name>.output.<path>` that reads one step's output from the next.
The transform step uses `inputPath` rather than a `{{ }}` expression because
`{{ }}` values reach a node as text, while `inputPath` hands the node the live
response body — see the
[node-transform README](../../nodes/node-transform/README.md#why-inputpath--datapath-and-why-path).

## How to run

> ⚠️ **This workflow cannot be executed end-to-end yet — not because
> `cognipipe run` doesn't exist, but because neither node package it depends on
> is resolvable from the CLI's runtime context.** `cognipipe run` dynamically
> imports each step's `uses` package at execution time; since neither
> `@cognipipe/node-http` nor `@cognipipe/node-transform` is installed as a
> dependency of a project that also has `cognipipe` installed, the import fails
> and `run` reports `NODE_NOT_REGISTERED` — the same reason `cognipipe test`'s
> node availability check shows ❌ below. This example exists to demonstrate
> the intended `workflow.yaml` syntax and give node implementers a concrete
> reference scenario.

The `cognipipe test <workflow-file>` command validates a workflow and previews
its execution order **without executing any nodes**. From the repo root, after
building the CLI:

```bash
pnpm turbo build --filter=cognipipe
node apps/cli/dist/index.js test examples/hello-world/workflow.yaml
```

`pnpm turbo build --filter=cognipipe` builds the CLI **and** its workspace
dependencies (`@cognipipe/core`, `@cognipipe/types`) in the right order. Using
`pnpm --filter cognipipe build` alone runs only the CLI's `tsc` and fails on a
fresh checkout because the dependency `.d.ts` files are not built yet.

`cognipipe test` also checks whether each `uses` package can be resolved from
the CLI's context. Neither `@cognipipe/node-http` nor `@cognipipe/node-transform`
is declared as a dependency of the `cognipipe` CLI package, so both availability
checks fail today — this reflects the package-resolution boundary, not the
implementation status of the nodes (`node-http` and `node-transform` are both
implemented; see [Nodes used](#nodes-used) below). The structural checks — parse, schema
validation, `dependsOn` references, and cycle detection — still pass.

For a guarantee that the YAML is structurally valid **today**, use the snippet
in [Validate the YAML now](#validate-the-yaml-now) below. It exercises the same
`WorkflowParser` + `WorkflowValidator` that the engine uses, with no dependency
on node packages.

## Validate the YAML now

`WorkflowParser` and `WorkflowValidator` are both merged in `@cognipipe/core`,
so you can validate this workflow against `WorkflowConfigSchema` right now.
Build core once, save the snippet below as `validate.mjs` next to
`workflow.yaml`, and run it:

```bash
pnpm turbo build --filter=@cognipipe/core
node examples/hello-world/validate.mjs
```

```typescript
// validate.mjs — verification tool only, do not commit
import { WorkflowParser, WorkflowValidator } from '../../packages/core/dist/index.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const parser = new WorkflowParser();
const validator = new WorkflowValidator();

const raw = await parser.parseFile(resolve(__dirname, 'workflow.yaml'));
const config = validator.validate(raw);
console.log('Valid workflow:', config.name, '—', config.steps.length, 'steps');
```

On success you will see:

```
Valid workflow: hello-world — 2 steps
```

Delete `validate.mjs` before committing — it is a scratch file, not part of the
example.

## Nodes used

| Node         | Package                     | Status                                                                                                                                                                                                                                        |
| ------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP Request | `@cognipipe/node-http`      | Implemented — supports `GET`, `POST`, `PUT`, `DELETE`, and `PATCH` via Node.js 22's built-in `fetch`. See [`nodes/node-http/README.md`](../../nodes/node-http/README.md).                                                                     |
| Transform    | `@cognipipe/node-transform` | Implemented — `pick`, `parseCsv` and `template` operations. See [`nodes/node-transform/README.md`](../../nodes/node-transform/README.md). The package is still private and unpublished (`0.0.0`), so this workflow cannot run end to end yet. |

The `fetch-fact` step is fully specified against the implemented `node-http`
config (`url`, `method`), and the `log-result` step against the implemented
`node-transform` config (`operation`, `inputPath`, `fields`). Both packages are
still private and unpublished, so the workflow cannot run end to end until they
can be resolved from the CLI (see [How to run](#how-to-run)).

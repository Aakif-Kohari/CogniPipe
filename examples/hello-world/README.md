# Hello World — CogniPipe Example

A minimal two-step workflow that demonstrates the core CogniPipe `workflow.yaml`
syntax: sequential steps wired together with `dependsOn` and `{{ }}` context
interpolation.

## What this workflow does

The workflow fetches a random cat fact from the public `catfact.ninja` API in an
HTTP step, then passes the response body into a transform step that picks just
the `fact` and `length` fields. It is the smallest example that exercises every
building block a real CogniPipe pipeline relies on — a `name`/`version` header,
two steps connected by `dependsOn`, and a `{{ steps.<step-name>.<path> }}`
interpolation expression reading one step's output from the next.

## How to run

> ⚠️ **This workflow cannot be executed end-to-end yet.** The `cognipipe run`
> command is not implemented, and the node packages are not published to npm.
> This example exists to demonstrate the **intended `workflow.yaml` syntax** and
> to give node implementers a concrete reference scenario — not to provide a
> runnable CLI command today.

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
implementation status of the nodes (`node-http` is in fact implemented; see
[Nodes used](#nodes-used) below). The structural checks — parse, schema
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

| Node         | Package                     | Status                                                                                                                                                                                                         |
| ------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP Request | `@cognipipe/node-http`      | Implemented — supports `GET`, `POST`, `PUT`, `DELETE`, and `PATCH` via Node.js 22's built-in `fetch`. See [`nodes/node-http/README.md`](../../nodes/node-http/README.md).                                      |
| Transform    | `@cognipipe/node-transform` | In active development — currently a stub package (`0.0.0`, no source). The `operation: pick` / `fields` config used by `log-result` is the intended contract this example pins down for the node to grow into. |

The `fetch-fact` step is fully specified against the implemented `node-http`
config (`url`, `method`). The `log-result` step documents the shape that
`node-transform` is expected to support; once that node lands, this workflow
will run without changes.

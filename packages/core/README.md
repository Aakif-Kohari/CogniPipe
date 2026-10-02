# @cognipipe/core

The workflow engine behind [CogniPipe](https://github.com/Aakif-Kohari/CogniPipe): parse a workflow file, validate it, and execute its steps through registered nodes.

Requires Node.js >= 22.14. Ships ESM and CommonJS builds.

## Install

```bash
npm install @cognipipe/core
# or: pnpm add @cognipipe/core
```

## Quick start

```ts
import { WorkflowParser, WorkflowValidator, NodeRegistry, WorkflowExecutor } from '@cognipipe/core';
import { HttpNode } from '@cognipipe/node-http';

const registry = new NodeRegistry();
registry.register('@cognipipe/node-http', HttpNode);

const raw = await new WorkflowParser().parseFile('./workflow.yaml'); // .yaml, .yml or .json
const config = new WorkflowValidator().validate(raw); // throws CogniPipeError if invalid

const { context, stepErrors } = await new WorkflowExecutor(registry).run(config);
console.log(context.get('steps')); // { [stepName]: { output, completedAt, durationMs, retryCount } }
```

```yaml
# workflow.yaml
name: fetch-and-report
version: '1.0.0'
steps:
  - name: fetch-data
    uses: '@cognipipe/node-http'
    config:
      url: 'https://catfact.ninja/fact'

  - name: report
    uses: '@cognipipe/node-http'
    dependsOn: ['fetch-data'] # required to read fetch-data's output
    config:
      url: 'https://example.com/hook'
      method: POST
      body: '{{ steps.fetch-data.output.body }}'
```

## How execution works

- Every step's `uses` must be registered **before** anything runs; a typo never leaves earlier steps half-applied.
- Cycles in `dependsOn` are rejected up front (`CIRCULAR_DEPENDENCY`).
- Steps run as a DAG: a step with no unmet `dependsOn` starts immediately, **concurrently** with other ready steps. A step that reads another step's output with `{{ steps.<name>.output.<path> }}` must list that step in `dependsOn`.
- `continueOnError: true` records the failure in `stepErrors` and keeps going. Other failures throw `STEP_EXECUTION_FAILED`.
- `retry: { attempts, delayMs, backoff }` retries a step's `execute()` (`linear` or `exponential` backoff).
- `{{ ... }}` expressions in a step's `config` are resolved before the node runs. Objects and arrays are inserted as JSON.

## API

| Export                                                          | Purpose                                              |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| `WorkflowParser`                                                | `parseFile`, `parseYAML`, `parseJSON` → `unknown`    |
| `WorkflowValidator`                                             | `validate(raw)` → typed `WorkflowConfig`             |
| `NodeRegistry`                                                  | `register`, `get`, `has`, `instantiate`, `listTypes` |
| `WorkflowExecutor`                                              | `run(config, initial?)` → `{ context, stepErrors }`  |
| `ExecutionContext`                                              | Immutable key/value store with `interpolate()`       |
| `resolveTemplate`, `resolveDotPath`                             | Interpolation utilities                              |
| `detectCycles`                                                  | Cycle detection for `dependsOn` graphs               |
| `WorkflowConfigSchema`, `StepConfigSchema`, `RetryConfigSchema` | Zod schemas                                          |
| `CogniPipeError`, `isCogniPipeError`, `COGNIPIPE_ERROR_CODES`   | Error handling                                       |

## Errors

Every error is a `CogniPipeError` with a machine-readable `code` and optional `context`:

```ts
import { isCogniPipeError } from '@cognipipe/core';

try {
  await executor.run(config);
} catch (err) {
  if (isCogniPipeError(err)) console.error(`[${err.code}] ${err.message}`, err.context);
  else throw err;
}
```

Codes: `WORKFLOW_VALIDATION_ERROR`, `WORKFLOW_PARSE_ERROR`, `STEP_NOT_FOUND`, `NODE_NOT_REGISTERED`, `STEP_EXECUTION_FAILED`, `CIRCULAR_DEPENDENCY`, `INTERPOLATION_ERROR`, `CONTEXT_KEY_NOT_FOUND`, `NODE_INSTANTIATION_FAILED`, `NODE_CONFIG_INVALID`.

## Related packages

[`@cognipipe/types`](https://www.npmjs.com/package/@cognipipe/types) · [`@cognipipe/sdk`](https://www.npmjs.com/package/@cognipipe/sdk) · [`cognipipe`](https://www.npmjs.com/package/cognipipe) (CLI)

## License

MIT © [Aakif Kohari](https://github.com/Aakif-Kohari)

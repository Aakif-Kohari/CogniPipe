# cognipipe

Code-first workflow automation for developers. Define pipelines as typed YAML, validate them, and run them from the command line. See [CogniPipe](https://github.com/Aakif-Kohari/CogniPipe).

Requires Node.js >= 22.14.

## Install

```bash
npm install -g cognipipe
# or add it to a project: pnpm add cognipipe @cognipipe/node-http
```

## Usage

```bash
cognipipe --version
cognipipe test workflow.yaml            # validate only — never executes a node
cognipipe run workflow.yaml             # execute the workflow
cognipipe run workflow.yaml --verbose   # also print each step's result
```

Both commands exit `0` on success and `1` on any error.

### Example workflow

```yaml
# workflow.yaml
name: hello-world
version: '1.0.0'
steps:
  - name: fetch-fact
    uses: '@cognipipe/node-http'
    config:
      url: 'https://catfact.ninja/fact'
      method: GET

  - name: post-fact
    uses: '@cognipipe/node-http'
    dependsOn: ['fetch-fact'] # needed to read fetch-fact's output
    config:
      url: 'https://example.com/hook'
      method: POST
      body: '{{ steps.fetch-fact.output.body }}'
```

`cognipipe test` checks structure, that every `dependsOn` name exists, that there are no cycles, that each node package can be resolved, and prints the execution order:

```
Validating workflow: hello-world (1.0.0)
Structure         ✅ Valid
dependsOn refs    ✅ All 1 reference resolves
Circular deps     ✅ No cycles detected
Node availability ✅ @cognipipe/node-http (found)
Execution order:
  1. fetch-fact (@cognipipe/node-http)
  2. post-fact  (@cognipipe/node-http)
Result: All checks passed — workflow is ready to run.
```

## Nodes

Each step's `uses` is an npm package that exports a CogniPipe node. Install the node packages in the same place as the CLI (the same project, or globally alongside it), because the CLI loads them from its own installation context. Steps with no `dependsOn` run concurrently; use `dependsOn` whenever a step reads another step's output.

Published nodes: [`@cognipipe/node-http`](https://www.npmjs.com/package/@cognipipe/node-http). To build your own, see [`@cognipipe/sdk`](https://www.npmjs.com/package/@cognipipe/sdk).

## Related packages

[`@cognipipe/core`](https://www.npmjs.com/package/@cognipipe/core) · [`@cognipipe/sdk`](https://www.npmjs.com/package/@cognipipe/sdk) · [`@cognipipe/types`](https://www.npmjs.com/package/@cognipipe/types)

## License

MIT © [Aakif Kohari](https://github.com/Aakif-Kohari)

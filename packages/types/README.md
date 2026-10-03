# @cognipipe/types

Shared TypeScript types for [CogniPipe](https://github.com/Aakif-Kohari/CogniPipe) — the code-first workflow automation engine. Everything here is a type or interface; there is no runtime logic.

## Install

```bash
npm install @cognipipe/types
# or: pnpm add @cognipipe/types
```

## Usage

```ts
import type { WorkflowConfig, StepConfig, IExecutionContext, NodeOutput } from '@cognipipe/types';
```

## What's exported

| Area              | Types                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Workflow          | `WorkflowConfig`, `StepConfig`, `RetryConfig`                                                          |
| Nodes             | `NodeConfig`, `NodeOutput`, `NodeDefinition`, `IBaseNode`, `CogniNodeMeta`                             |
| Execution context | `IExecutionContext`, `StepResult`                                                                      |
| AI nodes          | `AiProviderConfig`, `AiRateLimitPolicy`, `AiProviderCapability`, `AiNodeOutput`, `AiExecutionMetadata` |

## Related packages

- [`@cognipipe/core`](https://www.npmjs.com/package/@cognipipe/core) — parser, validator, executor
- [`@cognipipe/sdk`](https://www.npmjs.com/package/@cognipipe/sdk) — build your own nodes
- [`cognipipe`](https://www.npmjs.com/package/cognipipe) — the CLI

## License

MIT © [Aakif Kohari](https://github.com/Aakif-Kohari)

# @cognipipe/sdk

Everything you need to build a [CogniPipe](https://github.com/Aakif-Kohari/CogniPipe) node: the `BaseNode` class, the `@CogniNode()` decorator, `defineConfig()` for Zod-validated config, and `RetryManager` for rate-limit handling.

Requires Node.js >= 22.14 and TypeScript >= 5.0. Ships ESM and CommonJS builds.

## Install

```bash
npm install @cognipipe/sdk @cognipipe/types zod
# or: pnpm add @cognipipe/sdk @cognipipe/types zod
```

## Build a node

```ts
import { BaseNode, CogniNode, defineConfig } from '@cognipipe/sdk';
import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import { z } from 'zod';

const GreetConfig = defineConfig(
  z.object({
    name: z.string().min(1),
    excited: z.boolean().default(false),
  }),
);

@CogniNode({ type: '@acme/node-greet', version: '1.0.0' })
export class GreetNode extends BaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    const { name, excited } = GreetConfig.parse(config); // throws CogniPipeError(NODE_CONFIG_INVALID)
    return { greeting: `Hello, ${name}${excited ? '!' : '.'}` };
  }
}
```

Then use it in a workflow:

```yaml
steps:
  - name: greet
    uses: '@acme/node-greet'
    config:
      name: Ada
```

Notes:

- `@CogniNode({ type, version })` validates at import time. `type` must match your npm package name; `version` must be strict `x.y.z` semver.
- Decorators use the standard (TC39) syntax. **Do not** enable `experimentalDecorators` in your `tsconfig.json`.
- Always validate config through `defineConfig()` (or `this.validateConfig()`) so failures are `CogniPipeError`s, not raw `ZodError`s.
- Optional lifecycle hooks: `beforeExecute(config, ctx)` and `afterExecute(output, ctx)`.
- Read secrets from environment variables, never from workflow config.

## Handling HTTP 429 (AI/provider nodes)

```ts
import { RetryManager, type RateLimitAwareError } from '@cognipipe/sdk';

const response = await RetryManager.execute(
  async () => {
    const res = await fetch(url, init);
    if (res.status === 429) {
      throw Object.assign(new Error('Rate limited'), {
        status: 429,
        retryAfterHeader: res.headers.get('retry-after') ?? undefined,
      }) as RateLimitAwareError;
    }
    return res;
  },
  { maxRetries: 3, initialDelayMs: 1000 }, // respectRetryAfter defaults to true
);
```

Only HTTP 429 is retried. `parseRetryAfter(header)` is exported separately (supports `delay-seconds` and HTTP-date).

## Exports

`BaseNode`, `CogniNode`, `defineConfig`, `RetryManager`, `parseRetryAfter`, and the types `CogniNodeOptions`, `ConfigDefinition`, `NodeConfig`, `RateLimitAwareError`.

## Related packages

[`@cognipipe/types`](https://www.npmjs.com/package/@cognipipe/types) · [`@cognipipe/core`](https://www.npmjs.com/package/@cognipipe/core) · [`cognipipe`](https://www.npmjs.com/package/cognipipe) (CLI)

## License

MIT © [Aakif Kohari](https://github.com/Aakif-Kohari)

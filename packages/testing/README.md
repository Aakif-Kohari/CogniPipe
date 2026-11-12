# @cognipipe/testing

Test utilities for [CogniPipe](https://github.com/Aakif-Kohari/CogniPipe) node authors:

- **`MockContext`** — a ready-made `IExecutionContext`, so tests stop hand-rolling inline mocks.
- **`NodeTestRunner`** — runs a node through the same lifecycle `WorkflowExecutor` uses, **without** the engine, and isolates `process.env` and `fetch` for you.

Requires Node.js >= 22.14. Ships ESM and CommonJS builds, so it works from `ts-jest` suites compiled to CommonJS. It depends only on `@cognipipe/types` and never on `@cognipipe/core`. The package is private to this monorepo and is not published to npm.

## Use it in a node package

Add it as a workspace dev dependency of your node package (`nodes/node-<service>/package.json`) and run `pnpm install`:

```json
{
  "devDependencies": {
    "@cognipipe/testing": "workspace:*"
  }
}
```

`pnpm test` builds it for you (Turborepo's `test` task depends on `^build`). To build it by hand: `pnpm --filter @cognipipe/testing build`, which emits `dist/` (ESM) and `dist/cjs/` (CommonJS).

## `MockContext`

A dependency-free, in-memory `IExecutionContext`. `set()` returns a **new** context, like the production `ExecutionContext`.

```ts
import { MockContext } from '@cognipipe/testing';

const ctx = new MockContext({ steps: { auth: { output: { token: 'abc' } } } });

ctx.get('steps'); // { auth: { output: { token: 'abc' } } }
ctx.interpolate('Bearer {{ steps.auth.output.token }}'); // 'Bearer abc'
ctx.set('extra', 1).get('extra'); // 1 (ctx itself is untouched)
```

`interpolate()` supports dot-notation only (`{{ a.b.c }}`), not array brackets (`[0]`). An unresolvable token throws a plain `Error`.

## `NodeTestRunner`

Give it a node class; `run(config, options?)` performs one isolated run and returns a result object.

```ts
import { NodeTestRunner } from '@cognipipe/testing';
import { WeatherNode } from '../src/index';

describe('WeatherNode', () => {
  it('calls the API with the token from the previous step', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));

    const result = await new NodeTestRunner(WeatherNode).run(
      { city: 'Pune', token: '{{ steps.auth.output.token }}' },
      {
        context: { steps: { auth: { output: { token: 'abc' } } } },
        env: { WEATHER_API_BASE: 'https://api.example.test' },
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      },
    );

    if (!result.ok) throw result.error; // narrows `result` to the success shape
    expect(result.resolvedConfig).toEqual({ city: 'Pune', token: 'abc' });
    expect(result.calls).toEqual(['beforeExecute', 'execute', 'afterExecute']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports failures instead of rejecting', async () => {
    const result = await new NodeTestRunner(WeatherNode).run({ city: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.calls).toEqual(['beforeExecute']); // execute() never ran
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});
```

### Lifecycle

Identical to the executor: interpolate config, then `beforeExecute` (if defined), `execute`, and `afterExecute` (if defined, only after a successful `execute`). Every `run()` constructs a **fresh node instance** and a fresh `MockContext`.

### Options

| Option        | Type                                  | Description                                                                                            |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `context`     | `Record<string, unknown>`             | Seed data for the `MockContext`, e.g. `{ steps: { auth: { output: { token: 'abc' } } } }`.             |
| `env`         | `Record<string, string \| undefined>` | Env vars set for the duration of the run, then restored. `undefined` makes sure the variable is unset. |
| `fetch`       | `typeof globalThis.fetch`             | Replaces `globalThis.fetch` for the duration of the run, then restores the original.                   |
| `interpolate` | `boolean`                             | Resolve `{{ }}` in every string leaf of `config` via the `MockContext`. Defaults to `true`.            |

### Result

`run()` never rejects because of a node failure. Narrow on `ok`:

- `ok: true` gives you `output` (what `execute()` returned) and `resolvedConfig`.
- `ok: false` gives you `error` — the **exact value thrown**, same reference, never wrapped — and `resolvedConfig`, which is `undefined` if the constructor or config interpolation failed.
- Both carry `calls` (the lifecycle methods that were **invoked**, in order — a hook that threw is still listed), `durationMs`, and `context` (the seeded `MockContext` the node received).

A constructor that throws, or a `{{ }}` token that cannot be resolved, also comes back as `{ ok: false }` with `calls: []`.

### Isolation rules

- `env` and `fetch` overrides are restored in a `finally`, so they never leak — even when the node throws. A variable that did not exist before is **deleted**, not set to the string `"undefined"`.
- The node is constructed inside the override window, so constructors and field initializers that read `process.env` see the overrides.
- Overrides mutate process-wide state, so two overlapping `run()` calls that use `env` or `fetch` are rejected: the second `run()` rejects with a plain `Error`. Jest runs the tests of one file sequentially, so `await` each `run()` and you will never hit this.

### Asserting on `CogniPipeError`

Config interpolation failures from `MockContext` are plain `Error`s, because this package has no dependency on `@cognipipe/core`. To assert on a `CogniPipeError` thrown by your own node, check it in your test with the core helper:

```ts
import { isCogniPipeError } from '@cognipipe/core';

if (!result.ok) {
  expect(isCogniPipeError(result.error)).toBe(true);
}
```

### Good to know

`MockContext` is a plain seeded store. The context handed to `afterExecute()` is that same seeded instance; unlike in the real executor, it does not additionally contain the step's own result.

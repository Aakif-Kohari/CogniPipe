# @cognipipe/core

## 0.6.0

### Minor Changes

- 6508d94: Add live per-step execution events to the workflow engine. `WorkflowExecutor` now has typed `on()` and `off()` methods for the `step:start`, `step:complete` and `step:error` events, so you can build logging, progress output and metrics without waiting for `run()` to finish. `on()` returns an unsubscribe function. Events carry the workflow name, step name, node type and ISO 8601 timestamps. `step:complete` carries the exact output, duration and retry count stored in the context, and `step:error` carries the original error plus whether the workflow carried on (`continueOnError`). Listeners can never fail or change a run (async listeners are never awaited, so keep synchronous listeners fast): listener errors are reported as `CogniPipeListenerWarning` process warnings. The event payload types (`StepStartEvent`, `StepCompleteEvent`, `StepErrorEvent`, `ExecutionEventMap`, `ExecutionEventName`, `ExecutionEventListener`) are exported from `@cognipipe/types`. Behavior is unchanged when no listeners are registered.

### Patch Changes

- Updated dependencies [6508d94]
  - @cognipipe/types@0.2.0

## 0.5.0

### Minor Changes

- 1b0ffbd: Add `WorkflowScheduler` for cron-based workflow triggering. Schedule any validated workflow with a standard 5-field cron expression and it runs automatically through a `WorkflowExecutor`:

  ```ts
  import { WorkflowScheduler } from '@cognipipe/core';

  const scheduler = new WorkflowScheduler(executor);
  scheduler.schedule(config, '0 9 * * 1-5', { id: 'weekday-report' });
  ```

  Every scheduled run receives a reserved `trigger` value (`{ type: 'schedule', cron, scheduledAt }`), so steps can use `{{ trigger.scheduledAt }}`. The scheduler ships with a zero-dependency cron parser (`parseCron` and `nextCronRun`), UTC or host-local time, overlap control (`skip` or `allow`), per-job `onComplete` and `onError` callbacks (sync or async), and a new `SCHEDULE_INVALID` error code. Options are captured when `schedule()` is called. A failed run is reported but never stops the schedule. Missed runs are not backfilled: if the process was suspended, at most one overdue run is dispatched on resumption (for the first missed tick, with its original `scheduledAt`) and the other missed ticks are skipped. In host-local mode, a daylight-saving gap shifts a skipped wall time forward by the gap, and the repeated hour of a fall-back is not run twice, so a sub-hourly local schedule pauses during it. Use UTC when you need a steady cadence.

## 0.4.2

### Patch Changes

- 8f7a64b: Fix `WorkflowExecutor` config interpolation mangling non-plain objects. A `Date`, `Map`, `Set`, `RegExp`, typed array or class instance in a step's config used to be rebuilt as a plain object from its own enumerable entries (empty for a `Date`, `Map`, `Set` or `RegExp`, index keys for a typed array), losing its prototype and methods. It now reaches the node unchanged, by reference. Only plain objects and arrays are walked, so `{{ }}` tokens inside a non-plain object's own fields are no longer interpolated: move token-bearing fields into a plain config object, or resolve them before constructing the instance. This affects configs built in code and YAML parsed with a schema that yields non-plain values (e.g. js-yaml's `YAML11_SCHEMA`, which parses timestamps as `Date`; the default schema leaves them as strings).

## 0.4.1

### Patch Changes

- 3d877ba: Add regression coverage for `WorkflowExecutor` `continueOnError` semantics across lifecycle hooks, error ordering, explicit false values, and upfront failures.

## 0.4.0

### Minor Changes

- 394f36a: **Breaking (minor while pre-1.0):** `@cognipipe/core` now rejects duplicate step names and dangling `dependsOn` references at validation time, and interpolation inserts objects/arrays as JSON (previously `"[object Object]"` / comma-joined values).

  Also: add READMEs, LICENSE files and npm metadata (homepage, bugs, keywords) so package pages render on npm. core/cli: fix quadratic memory use in cycle detection. node-http: enforce http(s) URLs and correct README examples and error documentation.

### Patch Changes

- Updated dependencies [394f36a]
  - @cognipipe/types@0.1.2

## 0.3.1

### Patch Changes

- fe249df: Bump minimum `pnpm` engine requirement to >=11.10.0.
- Updated dependencies [fe249df]
  - @cognipipe/types@0.1.1

## 0.3.0

### Minor Changes

- 75137a0: Implement DAG-based parallel step execution. Steps without unmet `dependsOn` entries now run concurrently.

## 0.2.1

### Patch Changes

- 0955fae: Close remaining test coverage gaps; no runtime behavior change.

## 0.2.0

### Minor Changes

- 2390241: Implement circular dependency detection for the DAG executor.

## 0.1.1

### Patch Changes

- 3dcf01f: Add fast-check property-based fuzz tests for interpolation engine.

## 0.1.0

### Minor Changes

- b46a784: Add 'WorkflowExecutor' for sequential workflow execution with context passing.

  This introduces the core runtime responsible for executing validated workflows step by step. The executor performs upfront node validation, interpolates step configuration using the execution context, executes node lifecycle hooks, stores step outputs for downstream steps, and supports 'continueOnError' with structured per-step error reporting.

  Also exports the new 'WorkflowExecutor', 'ExecutionResult', and 'StepError' APIs, with comprehensive test coverage for sequential execution, interpolation, lifecycle hooks, validation, and error handling.

- 52aeea5: Add WorkflowParser. Read .yaml/.yml/.json file or string, make unknown object. Throw CogniPipeError (WORKFLOW_PARSE_ERROR) on bad ext, missing file, empty content, bad syntax, null doc.
- d3b0a0a: Add RetryConfig-driven step retry to WorkflowExecutor

  WorkflowExecutor now reads 'StepConfig.retry' and retries a step's 'execute()' call up to 'retry.attempts' times on failure, waiting 'retry.delayMs' between attempts (constant for 'linear'/omitted backoff, doubling per attempt for 'exponential'). Retry is fully opt-in — steps without a 'retry' block behave exactly as before.

  'StepResult' gains a new required field 'retryCount: number', recording how many retries occurred before the step's final outcome ('0' = succeeded on first try).

  **Breaking:** 'StepResult.retryCount' is required. Any code constructing 'StepResult' object literals directly (outside 'WorkflowExecutor') must add this field.

- 74f9a19: Add the IExecutionContext interface and introduce an immutable ExecutionContext with interpolation utilities.
- 31e1750: Implement CogniPipeError custom error class with error codes
- 7e35b4c: Implemented WorkflowValidator with Zod schema validation
- 41e4c4a: Add NodeRegistry. Registers, resolves, and instantiates node constructors by type string. Throws CogniPipeError (NODE_NOT_REGISTERED / NODE_INSTANTIATION_FAILED) on bad lookups or constructor failures.

### Patch Changes

- 0cdaffc: Add WorkflowParser → WorkflowValidator integration tests covering the parse-then-validate pipeline with spy assertions and no module mocks.
- 35fe8b6: Expand ExecutionContext test suite to cover has() truthy branch, get() missing-key undefined, toJSON() of empty/accumulated state, and multi-step accumulation under the steps namespace.
- b98eacb: Expanded WorkflowValidator test suite with edge-case and error structure coverage.
- 5a956ab: Add engines field declaring Node.js >=22.0.0 and pnpm >=9.0.0 requirements to match root package.json
- d28df2f: Fix ERR_MODULE_NOT_FOUND when consuming compiled ESM output under Node's native module loader. Relative imports across all packages were missing explicit .js extensions — TypeScript's `bundler` moduleResolution compiled these without error, but Node's native ESM resolver requires an exact extension on every relative specifier and has no fallback. Jest's more lenient resolver masked this in every test run, so it was never caught until a real `node dist/index.js` invocation surfaced it. Fixed by adding .js extensions to all relative imports and adding a `moduleNameMapper` to each ESM-mode/CJS-transform Jest config so `ts-jest` can still resolve the real .ts source files despite the literal .js specifiers.
- 44adfa0: Configured OIDC trusted publishing infrastructure

  - Bump pnpm to v10.34.5 and pin Node to v22.14.0 across CI and .nvmrc
  - Add publishConfig.access and files field to all publishable packages
  - Mark stub node packages as private to prevent accidental publishing
  - Update release.yml to use OIDC id-token auth instead of NPM_TOKEN
  - Force npm CLI upgrade in CI to fix known OIDC fallback bug

- 8ed1c97: Add a CommonJS build ('dist/cjs') alongside the existing ESM build, with a 'require' condition in 'exports'. '@cognipipe/core''s 'package.json' previously only exported an 'import' condition, so any consumer using CommonJS-style 'require()' — including Jest tests compiled by 'ts-jest' to CommonJS — failed to resolve the package. '@cognipipe/sdk''s new 'BaseNode' (added in this PR) is the first in-repo consumer to hit this via a real runtime import.
- ab19f15: Fix ReDoS vulnerability in template interpolation regex (CWE-1333)
- Updated dependencies [7c76492]
- Updated dependencies [5c2b7a8]
- Updated dependencies [d3b0a0a]
- Updated dependencies [74f9a19]
- Updated dependencies [5a956ab]
- Updated dependencies [b239f6b]
- Updated dependencies [d28df2f]
- Updated dependencies [44adfa0]
- Updated dependencies [15ed5ed]
- Updated dependencies [7e35b4c]
- Updated dependencies [8ed1c97]
  - @cognipipe/types@0.1.0

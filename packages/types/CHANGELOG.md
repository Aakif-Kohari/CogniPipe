# @cognipipe/types

## 0.1.0

### Minor Changes

- 5c2b7a8: Add AiNodeOutput interface with standard token usage and latency metadata for AI provider nodes.
- d3b0a0a: Add RetryConfig-driven step retry to WorkflowExecutor

  WorkflowExecutor now reads 'StepConfig.retry' and retries a step's 'execute()' call up to 'retry.attempts' times on failure, waiting 'retry.delayMs' between attempts (constant for 'linear'/omitted backoff, doubling per attempt for 'exponential'). Retry is fully opt-in — steps without a 'retry' block behave exactly as before.

  'StepResult' gains a new required field 'retryCount: number', recording how many retries occurred before the step's final outcome ('0' = succeeded on first try).

  **Breaking:** 'StepResult.retryCount' is required. Any code constructing 'StepResult' object literals directly (outside 'WorkflowExecutor') must add this field.

- 74f9a19: Add the IExecutionContext interface and introduce an immutable ExecutionContext with interpolation utilities.
- b239f6b: Add 'AiProviderConfig', 'AiRateLimitPolicy', and 'AiProviderCapability' shared interfaces for AI provider nodes.
- 7e35b4c: Implemented WorkflowValidator with Zod schema validation
- 8ed1c97: Add 'BaseNode' abstract class to '@cognipipe/sdk' and the 'IBaseNode'/'CogniNodeMeta' contract to '@cognipipe/types'.

  Every node package under 'nodes/*' can now extend 'BaseNode' and implement 'execute()', with optional 'beforeExecute'/'afterExecute' lifecycle hooks. The protected 'validateConfig()' helper wraps Zod's '.safeParse()' and throws a consistent 'CogniPipeError(NODE_CONFIG_INVALID)' instead of a raw 'ZodError', matching 'WorkflowValidator''s existing error-formatting convention.

  'IBaseNode' lives in '@cognipipe/types' (not '@cognipipe/sdk') so '@cognipipe/core''s future 'NodeRegistry' can type-check node instances without creating a circular 'types ← core ← sdk ← core' dependency.

### Patch Changes

- 7c76492: add "type": "module" for ESM consistency
- 5a956ab: Add engines field declaring Node.js >=22.0.0 and pnpm >=9.0.0 requirements to match root package.json
- d28df2f: Fix ERR_MODULE_NOT_FOUND when consuming compiled ESM output under Node's native module loader. Relative imports across all packages were missing explicit .js extensions — TypeScript's `bundler` moduleResolution compiled these without error, but Node's native ESM resolver requires an exact extension on every relative specifier and has no fallback. Jest's more lenient resolver masked this in every test run, so it was never caught until a real `node dist/index.js` invocation surfaced it. Fixed by adding .js extensions to all relative imports and adding a `moduleNameMapper` to each ESM-mode/CJS-transform Jest config so `ts-jest` can still resolve the real .ts source files despite the literal .js specifiers.
- 44adfa0: Configured OIDC trusted publishing infrastructure

  - Bump pnpm to v10.34.5 and pin Node to v22.14.0 across CI and .nvmrc
  - Add publishConfig.access and files field to all publishable packages
  - Mark stub node packages as private to prevent accidental publishing
  - Update release.yml to use OIDC id-token auth instead of NPM_TOKEN
  - Force npm CLI upgrade in CI to fix known OIDC fallback bug

- 15ed5ed: Adds comprehensive JSDoc documentation to every exported symbol in `packages/types/src/`. Before this PR, contributors implementing `WorkflowExecutor`, `WorkflowValidator`, or any new node package had noinline hover documentation — they had to read raw TypeScript and guessintent. After this PR, every IDE user across the monorepo gets accuratedocumentation on every interface, type, and field immediately.This is a **documentation-only change** — no runtime behaviour, no newexports, no dependencies added.

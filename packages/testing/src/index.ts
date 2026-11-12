/**
 * @module @cognipipe/testing
 *
 * Shared test utilities for CogniPipe node and workflow authors.
 * Ships ESM and CommonJS builds, so node test suites compiled to CommonJS by
 * ts-jest can `require('@cognipipe/testing')`. Depends only on
 * `@cognipipe/types` — never on `@cognipipe/core`.
 *
 * - {@link MockContext} — a pre-built IExecutionContext implementation for use
 *   in node test suites without hand-rolling inline mocks.
 * - {@link NodeTestRunner} — runs a node through the executor's lifecycle
 *   (interpolate, beforeExecute, execute, afterExecute) in full isolation,
 *   with temporary `process.env` and `fetch` overrides.
 */

export { MockContext } from './MockContext.js';
export { NodeTestRunner } from './NodeTestRunner.js';
export type {
  NodeLifecycleCall,
  NodeTestRunnerOptions,
  NodeTestRunResult,
} from './NodeTestRunner.js';

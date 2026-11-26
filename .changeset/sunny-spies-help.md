---
'@cognipipe/core': minor
'@cognipipe/types': minor
---

Add live per-step execution events to the workflow engine. `WorkflowExecutor` now has typed `on()` and `off()` methods for the `step:start`, `step:complete` and `step:error` events, so you can build logging, progress output and metrics without waiting for `run()` to finish. `on()` returns an unsubscribe function. Events carry the workflow name, step name, node type and ISO 8601 timestamps. `step:complete` carries the exact output, duration and retry count stored in the context, and `step:error` carries the original error plus whether the workflow carried on (`continueOnError`). Listeners can never fail or change a run (async listeners are never awaited, so keep synchronous listeners fast): listener errors are reported as `CogniPipeListenerWarning` process warnings. The event payload types (`StepStartEvent`, `StepCompleteEvent`, `StepErrorEvent`, `ExecutionEventMap`, `ExecutionEventName`, `ExecutionEventListener`) are exported from `@cognipipe/types`. Behavior is unchanged when no listeners are registered.

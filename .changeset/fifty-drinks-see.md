---
'@cognipipe/core': minor
---

Add 'WorkflowExecutor' for sequential workflow execution with context passing.

This introduces the core runtime responsible for executing validated workflows step by step. The executor performs upfront node validation, interpolates step configuration using the execution context, executes node lifecycle hooks, stores step outputs for downstream steps, and supports 'continueOnError' with structured per-step error reporting.

Also exports the new 'WorkflowExecutor', 'ExecutionResult', and 'StepError' APIs, with comprehensive test coverage for sequential execution, interpolation, lifecycle hooks, validation, and error handling.

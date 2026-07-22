---
'@cognipipe/types': minor
'@cognipipe/core': minor
---

Add RetryConfig-driven step retry to WorkflowExecutor

WorkflowExecutor now reads 'StepConfig.retry' and retries a step's 'execute()' call up to 'retry.attempts' times on failure, waiting 'retry.delayMs' between attempts (constant for 'linear'/omitted backoff, doubling per attempt for 'exponential'). Retry is fully opt-in — steps without a 'retry' block behave exactly as before.

'StepResult' gains a new required field 'retryCount: number', recording how many retries occurred before the step's final outcome ('0' = succeeded on first try).

**Breaking:** 'StepResult.retryCount' is required. Any code constructing 'StepResult' object literals directly (outside 'WorkflowExecutor') must add this field.

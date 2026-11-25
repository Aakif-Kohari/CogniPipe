/**
 * @module WorkflowExecutor.events.test
 *
 * Tests for WorkflowExecutor's live execution events: on() / off() and the
 * step:start, step:complete and step:error payloads. Lives in its own file so
 * the large WorkflowExecutor.test.ts stays untouched and doubles as the
 * backward-compatibility baseline. Uses inline test doubles only — it must not
 * import from @cognipipe/sdk.
 */

import type {
  ExecutionEventMap,
  ExecutionEventName,
  IBaseNode,
  IExecutionContext,
  NodeConfig,
  NodeOutput,
  StepCompleteEvent,
  StepErrorEvent,
  StepResult,
  StepStartEvent,
  WorkflowConfig,
} from '@cognipipe/types';
import { WorkflowExecutor } from '../../engine/WorkflowExecutor';
import type { ExecutionResult } from '../../engine/WorkflowExecutor';
import { NodeRegistry } from '../../engine/NodeRegistry';
import { isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

// ---- Inline test doubles — do not import from @cognipipe/sdk ----

class EchoNode implements IBaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    return { echoed: config };
  }
}

class FailNode implements IBaseNode {
  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    throw new Error('node failed');
  }
}

// ---- Helpers ----

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Builds a minimal valid WorkflowConfig with the given steps. */
function buildWorkflow(steps: WorkflowConfig['steps']): WorkflowConfig {
  return { name: 'test-workflow', version: '1.0.0', steps };
}

/** Returns the item at `index`, throwing when absent so tests need no `!` assertions. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index}, but only ${items.length} exist`);
  }
  return item;
}

/** Reads the StepResult stored under `steps.<name>`, throwing when absent. */
function getStepResult(result: ExecutionResult, name: string): StepResult {
  const steps = result.context.get('steps') as Record<string, StepResult> | undefined;
  const stepResult = steps?.[name];
  if (stepResult === undefined) {
    throw new Error(`Expected a StepResult for "${name}" in the context`);
  }
  return stepResult;
}

type LoggedEvent =
  | { type: 'step:start'; payload: StepStartEvent }
  | { type: 'step:complete'; payload: StepCompleteEvent }
  | { type: 'step:error'; payload: StepErrorEvent };

/** Subscribes to all three events and returns the shared, ordered event log. */
function recordEvents(executor: WorkflowExecutor): LoggedEvent[] {
  const events: LoggedEvent[] = [];
  executor.on('step:start', payload => {
    events.push({ type: 'step:start', payload });
  });
  executor.on('step:complete', payload => {
    events.push({ type: 'step:complete', payload });
  });
  executor.on('step:error', payload => {
    events.push({ type: 'step:error', payload });
  });
  return events;
}

/** Compact `type:stepName` labels, for ordering assertions. */
function labels(events: LoggedEvent[]): string[] {
  return events.map(event => `${event.type}:${event.payload.stepName}`);
}

/** Returns the payloads of one event type, in the order they were emitted. */
function payloadsOf<K extends ExecutionEventName>(
  events: LoggedEvent[],
  type: K,
): ExecutionEventMap[K][] {
  return events
    .filter(event => event.type === type)
    .map(event => event.payload as ExecutionEventMap[K]);
}

/** Lets pending timers and microtasks run, so concurrently scheduled work can progress. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Polls (one macrotask at a time) until `condition` holds, failing loudly on timeout. */
async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }
    await tick();
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

/** A node whose execute() blocks until the test calls `release()`. */
function createGatedNode(): {
  node: new () => IBaseNode;
  release: () => void;
  started: () => boolean;
} {
  let release: () => void = () => {};
  let hasStarted = false;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });

  class GatedNode implements IBaseNode {
    async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
      hasStarted = true;
      await gate;
      return { gated: true };
    }
  }

  return { node: GatedNode, release: () => release(), started: () => hasStarted };
}

describe('WorkflowExecutor events', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('step:start and step:complete', () => {
    it('emits step:start then step:complete with the documented payload for a single successful step', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const result = await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: { value: 1 } }]),
      );

      expect(labels(events)).toEqual(['step:start:step-a', 'step:complete:step-a']);

      const start = at(payloadsOf(events, 'step:start'), 0);
      expect(start).toEqual({
        workflowName: 'test-workflow',
        stepName: 'step-a',
        uses: '@cognipipe/node-echo',
        startedAt: expect.stringMatching(ISO_8601),
      });

      const complete = at(payloadsOf(events, 'step:complete'), 0);
      const stored = getStepResult(result, 'step-a');
      expect(complete).toEqual({
        workflowName: 'test-workflow',
        stepName: 'step-a',
        uses: '@cognipipe/node-echo',
        output: { echoed: { value: 1 } },
        durationMs: stored.durationMs,
        retryCount: 0,
        completedAt: stored.completedAt,
      });
      // Identity, not just equality: listeners see the very object stored in the context.
      expect(complete.output).toBe(stored.output);
      expect(complete.completedAt).toMatch(ISO_8601);
      expect(complete.retryCount).toBe(stored.retryCount);
      expect(complete.durationMs).toBe(stored.durationMs);
    });

    it('emits step:start before beforeExecute and step:complete after afterExecute', async () => {
      const registry = new NodeRegistry();
      const order: string[] = [];

      class TrackedNode implements IBaseNode {
        async beforeExecute(_config: NodeConfig, _ctx: IExecutionContext): Promise<void> {
          order.push('beforeExecute');
        }
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          order.push('execute');
          return { done: true };
        }
        async afterExecute(_output: NodeOutput, _ctx: IExecutionContext): Promise<void> {
          order.push('afterExecute');
        }
      }

      registry.register('@cognipipe/node-tracked', TrackedNode);
      const executor = new WorkflowExecutor(registry);
      executor.on('step:start', () => {
        order.push('step:start');
      });
      executor.on('step:complete', () => {
        order.push('step:complete');
      });

      await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-tracked', config: {} }]),
      );

      expect(order).toEqual([
        'step:start',
        'beforeExecute',
        'execute',
        'afterExecute',
        'step:complete',
      ]);
    });

    it('emits step:complete only after the result is written to the context', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const stepsSeenByListener: unknown[] = [];

      // The context is only returned by run(), so a listener cannot read it directly.
      // Instead, a dependent step reads the output through interpolation: it must
      // already be there by the time the first step's step:complete has fired.
      executor.on('step:complete', event => {
        stepsSeenByListener.push(event.stepName);
      });

      const result = await executor.run(
        buildWorkflow([
          { name: 'first', uses: '@cognipipe/node-echo', config: { value: 'x' } },
          {
            name: 'second',
            uses: '@cognipipe/node-echo',
            config: { seen: '{{ steps.first.output.echoed.value }}' },
            dependsOn: ['first'],
          },
        ]),
      );

      expect(stepsSeenByListener).toEqual(['first', 'second']);
      expect(getStepResult(result, 'second').output).toEqual({ echoed: { seen: 'x' } });
    });
  });

  describe('retries', () => {
    it('emits one step:start and one step:complete with retryCount 2 when a step fails twice then succeeds', async () => {
      const registry = new NodeRegistry();
      let calls = 0;

      class FlakyNode implements IBaseNode {
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          calls++;
          if (calls <= 2) {
            throw new Error(`attempt ${calls} failed`);
          }
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-flaky', FlakyNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const result = await executor.run(
        buildWorkflow([
          {
            name: 'step-a',
            uses: '@cognipipe/node-flaky',
            config: {},
            retry: { attempts: 3, delayMs: 0 },
          },
        ]),
      );

      expect(calls).toBe(3);
      // step:start is NOT re-emitted per retry attempt.
      expect(labels(events)).toEqual(['step:start:step-a', 'step:complete:step-a']);
      const complete = at(payloadsOf(events, 'step:complete'), 0);
      const stored = getStepResult(result, 'step-a');
      expect(complete.retryCount).toBe(2);
      expect(complete.retryCount).toBe(stored.retryCount);
      expect(complete.durationMs).toBe(stored.durationMs);
    });

    it('emits one step:start and one step:error once all retry attempts are exhausted', async () => {
      const registry = new NodeRegistry();
      let calls = 0;

      class AlwaysFailNode implements IBaseNode {
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          calls++;
          throw new Error('always fails');
        }
      }

      registry.register('@cognipipe/node-always-fail', AlwaysFailNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await expect(
        executor.run(
          buildWorkflow([
            {
              name: 'step-a',
              uses: '@cognipipe/node-always-fail',
              config: {},
              retry: { attempts: 3, delayMs: 0 },
            },
          ]),
        ),
      ).rejects.toThrow();

      expect(calls).toBe(3);
      expect(labels(events)).toEqual(['step:start:step-a', 'step:error:step-a']);
      const errorEvent = at(payloadsOf(events, 'step:error'), 0);
      expect(errorEvent.error.message).toBe('always fails');
      expect(errorEvent.continued).toBe(false);
    });
  });

  describe('concurrency', () => {
    it('emits both step:start events before either step:complete for independent steps', async () => {
      const registry = new NodeRegistry();
      const gateA = createGatedNode();
      const gateB = createGatedNode();
      registry.register('@cognipipe/node-gate-a', gateA.node);
      registry.register('@cognipipe/node-gate-b', gateB.node);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const runPromise = executor.run(
        buildWorkflow([
          { name: 'a', uses: '@cognipipe/node-gate-a', config: {} },
          { name: 'b', uses: '@cognipipe/node-gate-b', config: {} },
        ]),
      );

      // Both nodes are blocked inside execute(), so no terminal event can exist yet.
      await waitFor(() => gateA.started() && gateB.started(), 'both nodes to start');
      expect(labels(events)).toEqual(['step:start:a', 'step:start:b']);

      gateA.release();
      gateB.release();
      await runPromise;

      const log = labels(events);
      expect(log).toHaveLength(4);
      expect(log.slice(0, 2)).toEqual(['step:start:a', 'step:start:b']);
      // Per-step ordering holds even though the two steps interleave.
      expect(log.indexOf('step:start:a')).toBeLessThan(log.indexOf('step:complete:a'));
      expect(log.indexOf('step:start:b')).toBeLessThan(log.indexOf('step:complete:b'));
    });

    it("emits d's step:start only after both b's and c's step:complete in a diamond", async () => {
      const registry = new NodeRegistry();
      const gateB = createGatedNode();
      const gateC = createGatedNode();
      registry.register('@cognipipe/node-echo', EchoNode);
      registry.register('@cognipipe/node-gate-b', gateB.node);
      registry.register('@cognipipe/node-gate-c', gateC.node);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const runPromise = executor.run(
        buildWorkflow([
          { name: 'a', uses: '@cognipipe/node-echo', config: {} },
          { name: 'b', uses: '@cognipipe/node-gate-b', config: {}, dependsOn: ['a'] },
          { name: 'c', uses: '@cognipipe/node-gate-c', config: {}, dependsOn: ['a'] },
          { name: 'd', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['b', 'c'] },
        ]),
      );

      await waitFor(() => gateB.started() && gateC.started(), 'b and c to start');
      expect(labels(events)).not.toContain('step:start:d');

      // Release only b: d must keep waiting for c.
      gateB.release();
      await waitFor(() => labels(events).includes('step:complete:b'), "b's step:complete");
      await tick();
      expect(labels(events)).not.toContain('step:start:d');

      gateC.release();
      await runPromise;

      const log = labels(events);
      expect(log.indexOf('step:start:d')).toBeGreaterThan(log.indexOf('step:complete:b'));
      expect(log.indexOf('step:start:d')).toBeGreaterThan(log.indexOf('step:complete:c'));
      expect(log[log.length - 1]).toBe('step:complete:d');
    });
  });

  describe('listener management', () => {
    it('calls multiple listeners in registration order', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const calls: string[] = [];
      executor.on('step:start', () => {
        calls.push('first');
      });
      executor.on('step:start', () => {
        calls.push('second');
      });
      executor.on('step:start', () => {
        calls.push('third');
      });

      await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]),
      );

      expect(calls).toEqual(['first', 'second', 'third']);
    });

    it('stops delivery through the unsubscribe function returned by on()', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const delivered: string[] = [];
      const unsubscribe = executor.on('step:start', () => {
        delivered.push('unsubscribed');
      });
      executor.on('step:start', () => {
        delivered.push('kept');
      });

      unsubscribe();
      unsubscribe(); // idempotent: a second call is a no-op

      await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]),
      );

      expect(delivered).toEqual(['kept']);
    });

    it('stops delivery through off() and ignores unknown listeners and events', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const delivered: string[] = [];
      const listener = (): void => {
        delivered.push('removed');
      };
      executor.on('step:start', listener);
      executor.off('step:start', listener);

      // off() for an event nobody subscribed to, or a function never registered, is a no-op.
      expect(() => executor.off('step:complete', () => {})).not.toThrow();
      expect(() => executor.off('step:start', () => {})).not.toThrow();

      await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]),
      );

      expect(delivered).toEqual([]);
    });

    it('registers the same function only once per event', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      let count = 0;
      const listener = (): void => {
        count++;
      };
      executor.on('step:start', listener);
      executor.on('step:start', listener);

      await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]),
      );

      expect(count).toBe(1);
    });

    it('still delivers to the same function registered under two different events', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const seen: string[] = [];
      const listener = (event: StepStartEvent | StepCompleteEvent): void => {
        seen.push(event.stepName);
      };
      executor.on('step:start', listener);
      executor.on('step:complete', listener);

      await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]),
      );

      expect(seen).toEqual(['step-a', 'step-a']);
    });

    it('does not skip the next listener when one unsubscribes another mid-emission', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const calls: string[] = [];
      let unsubscribeB: () => void = () => {};
      executor.on('step:start', () => {
        calls.push('a');
        unsubscribeB();
      });
      unsubscribeB = executor.on('step:start', () => {
        calls.push('b');
      });

      await executor.run(
        buildWorkflow([
          { name: 'first', uses: '@cognipipe/node-echo', config: {} },
          { name: 'second', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['first'] },
        ]),
      );

      // Snapshot semantics: b still receives the emission already in progress
      // ('first'), and is gone for the next one ('second').
      expect(calls).toEqual(['a', 'b', 'a']);
    });

    it('does not deliver the current emission to a listener added during it', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const calls: string[] = [];
      let added = false;
      executor.on('step:start', event => {
        calls.push(`a:${event.stepName}`);
        if (!added) {
          added = true;
          executor.on('step:start', late => {
            calls.push(`late:${late.stepName}`);
          });
        }
      });

      await executor.run(
        buildWorkflow([
          { name: 'first', uses: '@cognipipe/node-echo', config: {} },
          { name: 'second', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['first'] },
        ]),
      );

      expect(calls).toEqual(['a:first', 'a:second', 'late:second']);
    });

    it('keeps listener bookkeeping in #-private fields', () => {
      const executor = new WorkflowExecutor(new NodeRegistry());
      executor.on('step:start', () => {});

      // A TypeScript `private` field would show up as an own property at runtime.
      expect(Object.getOwnPropertyNames(executor)).toEqual([]);
    });
  });

  describe('step:error', () => {
    it('emits step:error with the original error and continued: false before run() rejects', async () => {
      const registry = new NodeRegistry();
      const originalError = new Error('original boom');

      class FatalNode implements IBaseNode {
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          throw originalError;
        }
      }

      registry.register('@cognipipe/node-fatal', FatalNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);
      const order: string[] = [];
      executor.on('step:error', () => {
        order.push('step:error');
      });

      let thrown: unknown;
      await executor
        .run(buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-fatal', config: {} }]))
        .catch((err: unknown) => {
          order.push('run rejected');
          thrown = err;
        });

      expect(order).toEqual(['step:error', 'run rejected']);
      expect(labels(events)).toEqual(['step:start:step-a', 'step:error:step-a']);

      const errorEvent = at(payloadsOf(events, 'step:error'), 0);
      expect(errorEvent).toEqual({
        workflowName: 'test-workflow',
        stepName: 'step-a',
        uses: '@cognipipe/node-fatal',
        error: originalError,
        continued: false,
        durationMs: expect.any(Number),
        failedAt: expect.stringMatching(ISO_8601),
      });
      // The event carries the ORIGINAL error, not the STEP_EXECUTION_FAILED wrapper.
      expect(errorEvent.error).toBe(originalError);
      expect(isCogniPipeError(errorEvent.error)).toBe(false);
      expect(errorEvent.durationMs).toBeGreaterThanOrEqual(0);

      // run() itself still rejects with the wrapper, whose cause is that same error.
      if (!isCogniPipeError(thrown)) {
        throw new Error('Expected run() to reject with a CogniPipeError');
      }
      expect(thrown.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      expect(thrown.cause).toBe(originalError);
    });

    it('emits step:error with continued: true for continueOnError, and downstream steps still emit events', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const result = await executor.run(
        buildWorkflow([
          { name: 'soft-fail', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
          {
            name: 'downstream',
            uses: '@cognipipe/node-echo',
            config: { value: 7 },
            dependsOn: ['soft-fail'],
          },
        ]),
      );

      expect(result.stepErrors).toHaveLength(1);
      const errorEvent = at(payloadsOf(events, 'step:error'), 0);
      expect(errorEvent.stepName).toBe('soft-fail');
      expect(errorEvent.continued).toBe(true);
      expect(errorEvent.error.message).toBe('node failed');
      // The event's error is the very object collected in stepErrors.
      expect(errorEvent.error).toBe(at(result.stepErrors, 0).error);
      expect(labels(events)).toEqual([
        'step:start:soft-fail',
        'step:error:soft-fail',
        'step:start:downstream',
        'step:complete:downstream',
      ]);
    });

    it('emits step:error when beforeExecute throws, without calling execute', async () => {
      const registry = new NodeRegistry();
      const originalError = new Error('beforeExecute failed');
      let executeCalled = false;

      class BeforeFailNode implements IBaseNode {
        async beforeExecute(_config: NodeConfig, _ctx: IExecutionContext): Promise<void> {
          throw originalError;
        }
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          executeCalled = true;
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-before-fail', BeforeFailNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await expect(
        executor.run(
          buildWorkflow([{ name: 'before-fail', uses: '@cognipipe/node-before-fail', config: {} }]),
        ),
      ).rejects.toThrow();

      expect(executeCalled).toBe(false);
      expect(labels(events)).toEqual(['step:start:before-fail', 'step:error:before-fail']);
      const errorEvent = at(payloadsOf(events, 'step:error'), 0);
      expect(errorEvent.error).toBe(originalError);
      expect(errorEvent.continued).toBe(false);
    });

    it('emits step:error when config interpolation fails, without calling execute', async () => {
      const registry = new NodeRegistry();
      let executeCalled = false;

      class SpyNode implements IBaseNode {
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          executeCalled = true;
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-spy', SpyNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const result = await executor.run(
        buildWorkflow([
          {
            name: 'bad-config',
            uses: '@cognipipe/node-spy',
            config: { value: '{{ steps.nope.output.x }}' },
            continueOnError: true,
          },
        ]),
      );

      expect(result.stepErrors).toHaveLength(1);
      expect(executeCalled).toBe(false);
      expect(labels(events)).toEqual(['step:start:bad-config', 'step:error:bad-config']);
      const errorEvent = at(payloadsOf(events, 'step:error'), 0);
      expect(errorEvent.continued).toBe(true);
      // The ORIGINAL interpolation error, not a STEP_EXECUTION_FAILED wrapper.
      if (!isCogniPipeError(errorEvent.error)) {
        throw new Error('Expected the original INTERPOLATION_ERROR CogniPipeError on the event');
      }
      expect(errorEvent.error.code).toBe(COGNIPIPE_ERROR_CODES.INTERPOLATION_ERROR);
    });

    it('emits step:error and no step:complete when afterExecute throws', async () => {
      const registry = new NodeRegistry();
      const afterError = new Error('afterExecute failed');

      class AfterFailNode implements IBaseNode {
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          return { persisted: true };
        }
        async afterExecute(_output: NodeOutput, _ctx: IExecutionContext): Promise<void> {
          throw afterError;
        }
      }

      registry.register('@cognipipe/node-after-fail', AfterFailNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const result = await executor.run(
        buildWorkflow([
          {
            name: 'after-fail',
            uses: '@cognipipe/node-after-fail',
            config: {},
            continueOnError: true,
          },
        ]),
      );

      expect(labels(events)).toEqual(['step:start:after-fail', 'step:error:after-fail']);
      expect(payloadsOf(events, 'step:complete')).toHaveLength(0);
      expect(at(payloadsOf(events, 'step:error'), 0).error).toBe(afterError);
      // Unchanged executor behaviour: the context write happens before afterExecute().
      expect(getStepResult(result, 'after-fail').output).toEqual({ persisted: true });
    });

    it('measures step:error durationMs from step:start, including beforeExecute', async () => {
      const registry = new NodeRegistry();

      class SlowBeforeFailNode implements IBaseNode {
        async beforeExecute(_config: NodeConfig, _ctx: IExecutionContext): Promise<void> {
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          throw new Error('after the slow hook');
        }
      }

      registry.register('@cognipipe/node-slow-before', SlowBeforeFailNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await executor.run(
        buildWorkflow([
          {
            name: 'slow',
            uses: '@cognipipe/node-slow-before',
            config: {},
            continueOnError: true,
          },
        ]),
      );

      // Timers can fire slightly early, so assert a margin below the 30ms wait.
      expect(at(payloadsOf(events, 'step:error'), 0).durationMs).toBeGreaterThanOrEqual(25);
    });

    it('normalizes a non-Error thrown value to an Error on the event payload', async () => {
      const registry = new NodeRegistry();

      class ThrowsNonErrorNode implements IBaseNode {
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          throw 'raw string failure';
        }
      }

      registry.register('@cognipipe/node-throw-raw', ThrowsNonErrorNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await executor.run(
        buildWorkflow([
          { name: 'step-a', uses: '@cognipipe/node-throw-raw', config: {}, continueOnError: true },
        ]),
      );

      const errorEvent = at(payloadsOf(events, 'step:error'), 0);
      expect(errorEvent.error).toBeInstanceOf(Error);
      expect(errorEvent.error.message).toBe('raw string failure');
    });
  });

  describe('steps that never start', () => {
    it('emits no events for a step whose dependency failed fatally', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await expect(
        executor.run(
          buildWorkflow([
            { name: 'fail-step', uses: '@cognipipe/node-fail', config: {} },
            {
              name: 'dependent',
              uses: '@cognipipe/node-echo',
              config: {},
              dependsOn: ['fail-step'],
            },
          ]),
        ),
      ).rejects.toThrow();

      expect(labels(events)).toEqual(['step:start:fail-step', 'step:error:fail-step']);
    });

    it('emits no events for a step still waiting on a slow dependency when another branch fails', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      registry.register('@cognipipe/node-echo', EchoNode);
      const slow = createGatedNode();
      registry.register('@cognipipe/node-slow', slow.node);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      const runPromise = executor.run(
        buildWorkflow([
          { name: 'fail-step', uses: '@cognipipe/node-fail', config: {} },
          { name: 'slow', uses: '@cognipipe/node-slow', config: {} },
          { name: 'late', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['slow'] },
        ]),
      );
      // Settle the outcome now so a rejection is never left unobserved while we wait.
      const outcome = runPromise.then(
        () => 'resolved',
        () => 'rejected',
      );

      // fail-step has failed fatally while `slow` is still blocked inside execute().
      await waitFor(
        () => labels(events).includes('step:error:fail-step') && slow.started(),
        'fail-step to fail while slow is in flight',
      );
      slow.release();
      expect(await outcome).toBe('rejected');

      const log = labels(events);
      expect(log.filter(label => label.endsWith(':late'))).toEqual([]);
      // The unrelated in-flight branch is still allowed to settle, and emits normally.
      expect(log).toContain('step:start:slow');
      expect(log).toContain('step:complete:slow');
    });

    it('emits no events at all for an upfront NODE_NOT_REGISTERED failure', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await expect(
        executor.run(
          buildWorkflow([
            { name: 'ok', uses: '@cognipipe/node-echo', config: {} },
            { name: 'missing', uses: '@cognipipe/node-missing', config: {} },
          ]),
        ),
      ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_NOT_REGISTERED });

      expect(events).toEqual([]);
    });

    it('emits no events at all for an upfront CIRCULAR_DEPENDENCY failure', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await expect(
        executor.run(
          buildWorkflow([
            { name: 'a', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['b'] },
            { name: 'b', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['a'] },
          ]),
        ),
      ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.CIRCULAR_DEPENDENCY });

      expect(events).toEqual([]);
    });

    it('emits no events when node instantiation fails, even with continueOnError', async () => {
      const registry = new NodeRegistry();

      class ConstructorFailNode implements IBaseNode {
        constructor() {
          throw new Error('constructor failed');
        }
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          return { unreachable: true };
        }
      }

      registry.register('@cognipipe/node-constructor-fail', ConstructorFailNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await expect(
        executor.run(
          buildWorkflow([
            {
              name: 'constructor-fail',
              uses: '@cognipipe/node-constructor-fail',
              config: {},
              continueOnError: true,
            },
          ]),
        ),
      ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_INSTANTIATION_FAILED });

      expect(events).toEqual([]);
    });
  });

  describe('per-step invariant', () => {
    it('gives every started step exactly one terminal event in a mixed workflow', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);
      const events = recordEvents(executor);

      await expect(
        executor.run(
          buildWorkflow([
            { name: 'ok', uses: '@cognipipe/node-echo', config: { value: 1 } },
            { name: 'soft', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
            { name: 'fatal', uses: '@cognipipe/node-fail', config: {} },
            { name: 'never', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['fatal'] },
          ]),
        ),
      ).rejects.toThrow();

      const log = labels(events);
      // 'never' is gated on the fatally-failed step, so it emits nothing.
      expect(log.filter(label => label.endsWith(':never'))).toEqual([]);

      const started = payloadsOf(events, 'step:start')
        .map(payload => payload.stepName)
        .sort();
      expect(started).toEqual(['fatal', 'ok', 'soft']);

      for (const stepName of started) {
        const terminals = events.filter(
          event => event.type !== 'step:start' && event.payload.stepName === stepName,
        );
        expect(terminals).toHaveLength(1);
        expect(log.indexOf(`step:start:${stepName}`)).toBeLessThan(
          log.indexOf(`${at(terminals, 0).type}:${stepName}`),
        );
      }

      expect(payloadsOf(events, 'step:complete').map(payload => payload.stepName)).toEqual(['ok']);
      const continuedByStep = new Map(
        payloadsOf(events, 'step:error').map(payload => [payload.stepName, payload.continued]),
      );
      expect(continuedByStep.get('soft')).toBe(true);
      expect(continuedByStep.get('fatal')).toBe(false);
    });
  });

  describe('listener isolation', () => {
    it('keeps the result identical when a listener throws, warns, and still reaches later listeners', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-echo', config: { value: 1 } },
        {
          name: 'b',
          uses: '@cognipipe/node-echo',
          config: { seen: '{{ steps.a.output.echoed.value }}' },
          dependsOn: ['a'],
        },
      ]);

      const baseline = await new WorkflowExecutor(registry).run(config);

      const executor = new WorkflowExecutor(registry);
      const warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
      const seenBySecond: string[] = [];
      executor.on('step:start', () => {
        throw new Error('listener exploded');
      });
      executor.on('step:start', event => {
        seenBySecond.push(event.stepName);
      });

      const result = await executor.run(config);

      expect(getStepResult(result, 'a').output).toEqual(getStepResult(baseline, 'a').output);
      expect(getStepResult(result, 'b').output).toEqual(getStepResult(baseline, 'b').output);
      expect(result.stepErrors).toEqual([]);
      // A throwing listener neither skips its successor nor silences later emissions.
      expect(seenBySecond).toEqual(['a', 'b']);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('listener exploded'),
        'CogniPipeListenerWarning',
      );
    });

    it('does not turn a throwing step:error listener into a different failure', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);
      const warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
      executor.on('step:error', () => {
        throw new Error('error listener exploded');
      });

      // run() must still reject with the ordinary STEP_EXECUTION_FAILED wrapper.
      await expect(
        executor.run(buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-fail', config: {} }])),
      ).rejects.toMatchObject({
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        message: expect.stringContaining('node failed'),
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('error listener exploded'),
        'CogniPipeListenerWarning',
      );
    });

    it('contains an async listener rejection: identical result, a warning, no unhandled rejection', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-echo', config: { value: 1 } },
      ]);

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const baseline = await new WorkflowExecutor(registry).run(config);

        const executor = new WorkflowExecutor(registry);
        const warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
        executor.on('step:complete', () => Promise.reject(new Error('async listener rejected')));

        const result = await executor.run(config);
        // Let the fire-and-forget rejection handler run before asserting.
        await tick();

        expect(getStepResult(result, 'step-a').output).toEqual(
          getStepResult(baseline, 'step-a').output,
        );
        expect(result.stepErrors).toEqual([]);
        // Only the executor's own .catch handler emits this warning, so receiving it
        // proves the rejection was handled rather than left unhandled.
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('async listener rejected'),
          'CogniPipeListenerWarning',
        );
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('does not await async listeners: run() resolves even if a listener never settles', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      let completeListenerCalled = false;
      executor.on('step:start', () => new Promise<void>(() => {}));
      executor.on('step:complete', () => {
        completeListenerCalled = true;
        return new Promise<void>(() => {});
      });

      const result = await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]),
      );

      expect(completeListenerCalled).toBe(true);
      expect(getStepResult(result, 'step-a').output).toEqual({ echoed: {} });
    });

    it('reports a non-Error async rejection reason in the warning', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);
      const warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
      executor.on('step:start', () => Promise.reject('raw listener reason'));

      await executor.run(
        buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]),
      );
      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('raw listener reason'),
        'CogniPipeListenerWarning',
      );
    });
  });

  describe('backward compatibility', () => {
    it('produces the unchanged execution result with no listeners registered', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);

      const result = await executor.run(
        buildWorkflow([
          { name: 'a', uses: '@cognipipe/node-echo', config: { value: 1 } },
          { name: 'soft', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
          {
            name: 'b',
            uses: '@cognipipe/node-echo',
            config: { seen: '{{ steps.a.output.echoed.value }}' },
            dependsOn: ['a'],
          },
        ]),
      );

      expect(result.stepErrors).toHaveLength(1);
      expect(at(result.stepErrors, 0).stepName).toBe('soft');
      expect(getStepResult(result, 'a').output).toEqual({ echoed: { value: 1 } });
      expect(getStepResult(result, 'b').output).toEqual({ echoed: { seen: '1' } });
      expect(getStepResult(result, 'a').completedAt).toMatch(ISO_8601);
    });
  });
});

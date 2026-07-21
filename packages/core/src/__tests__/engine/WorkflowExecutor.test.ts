import type {
  IBaseNode,
  IExecutionContext,
  NodeConfig,
  NodeOutput,
  WorkflowConfig,
} from '@cognipipe/types';
import { WorkflowExecutor } from '../../engine/WorkflowExecutor';
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

/** Throws a non-Error value, to exercise the defensive `err instanceof Error` narrowing. */
class ThrowsNonErrorNode implements IBaseNode {
  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    throw 'raw string failure';
  }
}

/** Tracks the call order of its lifecycle hooks for ordering assertions. */
class TrackingNode implements IBaseNode {
  public readonly calls: string[] = [];

  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    this.calls.push('execute');
    return { done: true };
  }

  async beforeExecute(_config: NodeConfig, _ctx: IExecutionContext): Promise<void> {
    this.calls.push('beforeExecute');
  }

  async afterExecute(_output: NodeOutput, _ctx: IExecutionContext): Promise<void> {
    this.calls.push('afterExecute');
  }
}

/** TrackingNode variant whose execute() always throws, to verify afterExecute is skipped. */
class TrackingFailNode implements IBaseNode {
  public readonly calls: string[] = [];

  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    this.calls.push('execute');
    throw new Error('boom');
  }

  async beforeExecute(_config: NodeConfig, _ctx: IExecutionContext): Promise<void> {
    this.calls.push('beforeExecute');
  }

  async afterExecute(_output: NodeOutput, _ctx: IExecutionContext): Promise<void> {
    this.calls.push('afterExecute');
  }
}

/** Builds a minimal valid WorkflowConfig with the given steps. */
function buildWorkflow(steps: WorkflowConfig['steps']): WorkflowConfig {
  return { name: 'test-workflow', version: '1.0.0', steps };
}

describe('WorkflowExecutor', () => {
  describe('happy path', () => {
    it('runs a single-step workflow and stores the result under steps.<name>', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-echo', config: { value: 1 } },
      ]);

      const result = await executor.run(config);

      const steps = result.context.get('steps') as Record<string, { output: unknown }>;
      expect(steps['step-a'].output).toEqual({ echoed: { value: 1 } });
    });

    it('makes the first step output available to the second step via {{ steps.<name>.output.<path> }}', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-echo', config: { value: 'hello' } },
        {
          name: 'step-b',
          uses: '@cognipipe/node-echo',
          config: { received: '{{ steps.step-a.output.echoed.value }}' },
        },
      ]);

      const result = await executor.run(config);

      const steps = result.context.get('steps') as Record<string, { output: unknown }>;
      expect(steps['step-b'].output).toEqual({ echoed: { received: 'hello' } });
    });

    it('returns an empty stepErrors array when all steps succeed', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]);

      const result = await executor.run(config);

      expect(result.stepErrors).toEqual([]);
    });

    it('produces a StepResult with output, an ISO 8601 completedAt, and a non-negative durationMs', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]);

      const result = await executor.run(config);

      const steps = result.context.get('steps') as Record<
        string,
        { output: unknown; completedAt: string; durationMs: number }
      >;
      const stepResult = steps['step-a'];
      expect(stepResult.output).toEqual({ echoed: {} });
      expect(stepResult.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(stepResult.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('calls lifecycle hooks in order: beforeExecute → execute → afterExecute', async () => {
      const registry = new NodeRegistry();
      let created: TrackingNode | undefined;

      class TrackingNodeFactory implements IBaseNode {
        // Delegate to a lazily-created TrackingNode instance so the test can
        // inspect `.calls` after the run.
        readonly #inner: TrackingNode;
        constructor() {
          this.#inner = new TrackingNode();
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
        beforeExecute(config: NodeConfig, ctx: IExecutionContext): Promise<void> {
          return this.#inner.beforeExecute(config, ctx);
        }
        afterExecute(output: NodeOutput, ctx: IExecutionContext): Promise<void> {
          return this.#inner.afterExecute(output, ctx);
        }
      }

      registry.register('@cognipipe/node-track', TrackingNodeFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-track', config: {} }]);
      await executor.run(config);

      expect(created?.calls).toEqual(['beforeExecute', 'execute', 'afterExecute']);
    });

    it('does not call afterExecute if execute() throws', async () => {
      const registry = new NodeRegistry();
      let created: TrackingFailNode | undefined;

      class TrackingFailFactory implements IBaseNode {
        readonly #inner: TrackingFailNode;
        constructor() {
          this.#inner = new TrackingFailNode();
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
        beforeExecute(config: NodeConfig, ctx: IExecutionContext): Promise<void> {
          return this.#inner.beforeExecute(config, ctx);
        }
        afterExecute(output: NodeOutput, ctx: IExecutionContext): Promise<void> {
          return this.#inner.afterExecute(output, ctx);
        }
      }

      registry.register('@cognipipe/node-track-fail', TrackingFailFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-track-fail', config: {} },
      ]);

      await expect(executor.run(config)).rejects.toThrow();
      expect(created?.calls).toEqual(['beforeExecute', 'execute']);
    });

    it('makes `initial` seed data available in context from the first step', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-echo', config: { seen: '{{ trigger.payload }}' } },
      ]);

      const result = await executor.run(config, { trigger: { payload: 'seed-value' } });

      expect(result.context.get('trigger')).toEqual({ payload: 'seed-value' });
      const steps = result.context.get('steps') as Record<string, { output: unknown }>;
      expect(steps['step-a'].output).toEqual({ echoed: { seen: 'seed-value' } });
    });
  });

  describe('continueOnError', () => {
    it('continues the workflow and records the error when a step with continueOnError: true throws', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
        { name: 'step-b', uses: '@cognipipe/node-echo', config: { value: 2 } },
      ]);

      const result = await executor.run(config);

      expect(result.stepErrors).toHaveLength(1);
      expect(result.stepErrors[0].stepName).toBe('step-a');
      expect(result.stepErrors[0].error.message).toBe('node failed');

      const steps = result.context.get('steps') as Record<string, { output: unknown }>;
      expect(steps['step-b'].output).toEqual({ echoed: { value: 2 } });
    });

    it('does not store a StepResult for the failed step', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
      ]);

      const result = await executor.run(config);

      const steps = result.context.get('steps') as Record<string, unknown> | undefined;
      expect(steps?.['step-a']).toBeUndefined();
    });

    it('wraps a non-Error thrown value in an Error for stepErrors', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-throw-raw', ThrowsNonErrorNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-throw-raw', config: {}, continueOnError: true },
      ]);

      const result = await executor.run(config);

      expect(result.stepErrors).toHaveLength(1);
      expect(result.stepErrors[0].error).toBeInstanceOf(Error);
      expect(result.stepErrors[0].error.message).toBe('raw string failure');
    });

    it('accumulates errors from multiple continueOnError steps', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
        { name: 'step-b', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
      ]);

      const result = await executor.run(config);

      expect(result.stepErrors).toHaveLength(2);
      expect(result.stepErrors.map(e => e.stepName)).toEqual(['step-a', 'step-b']);
    });
  });

  describe('upfront validation', () => {
    it('throws NODE_NOT_REGISTERED before any step runs when a step uses an unregistered node', async () => {
      const registry = new NodeRegistry();
      let executeCalled = false;

      class SpyNode implements IBaseNode {
        async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          executeCalled = true;
          return {};
        }
      }
      registry.register('@cognipipe/node-spy', SpyNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-spy', config: {} },
        { name: 'step-b', uses: '@cognipipe/node-missing', config: {} },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe(COGNIPIPE_ERROR_CODES.NODE_NOT_REGISTERED);
      expect(executeCalled).toBe(false);
    });

    it('names the unregistered uses value and the step name in the error message', async () => {
      const registry = new NodeRegistry();
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'fetch-data', uses: '@cognipipe/node-ghost', config: {} },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      const message = (thrown as Error).message;
      expect(message).toContain('@cognipipe/node-ghost');
      expect(message).toContain('fetch-data');
    });
  });

  describe('error handling', () => {
    it('throws CogniPipeError(STEP_EXECUTION_FAILED) with the step name and original error as .cause when a step throws without continueOnError', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-fail', config: {} }]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      const err = thrown as { code: string; message: string; cause?: unknown };
      expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      expect(err.message).toContain('step-a');
      expect((err.cause as Error).message).toBe('node failed');
    });

    it('wraps a non-Error thrown value in STEP_EXECUTION_FAILED with cause undefined', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-throw-raw', ThrowsNonErrorNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-throw-raw', config: {} },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      const err = thrown as { code: string; message: string; cause?: unknown };
      expect(err.code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      expect(err.message).toContain('raw string failure');
      expect(err.cause).toBeUndefined();
    });

    it('propagates interpolateConfig INTERPOLATION_ERROR (non-existent step reference) as STEP_EXECUTION_FAILED', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-echo',
          config: { value: '{{ steps.non-existent.output.x }}' },
        },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
    });
  });

  describe('interpolateConfig (via run())', () => {
    it('resolves a string value referencing a prior step output', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'prev', uses: '@cognipipe/node-echo', config: { value: 42 } },
        {
          name: 'next',
          uses: '@cognipipe/node-echo',
          config: { x: '{{ steps.prev.output.echoed.value }}' },
        },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<string, { output: unknown }>;
      expect(steps['next'].output).toEqual({ echoed: { x: '42' } });
    });

    it('passes number values through unchanged', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-echo', config: { timeout: 5000 } },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<string, { output: { echoed: unknown } }>;
      expect(steps['step-a'].output.echoed).toEqual({ timeout: 5000 });
    });

    it('passes boolean values through unchanged', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-echo', config: { enabled: true } },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<string, { output: { echoed: unknown } }>;
      expect(steps['step-a'].output.echoed).toEqual({ enabled: true });
    });

    it('resolves a nested string inside a nested object', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'auth', uses: '@cognipipe/node-echo', config: { token: 'secret-token' } },
        {
          name: 'call',
          uses: '@cognipipe/node-echo',
          config: { headers: { 'x-token': '{{ steps.auth.output.echoed.token }}' } },
        },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<
        string,
        { output: { echoed: { headers: { 'x-token': string } } } }
      >;
      expect(steps['call'].output.echoed.headers['x-token']).toBe('secret-token');
    });

    it('resolves the first element of an array, leaves the second (a literal) unchanged', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-echo', config: { x: 'resolved-x' } },
        {
          name: 'b',
          uses: '@cognipipe/node-echo',
          config: { list: ['{{ steps.a.output.echoed.x }}', 'literal'] },
        },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<
        string,
        { output: { echoed: { list: string[] } } }
      >;
      expect(steps['b'].output.echoed.list).toEqual(['resolved-x', 'literal']);
    });
  });

  describe('retry behaviour', () => {
    /** Fails `failCount` times then succeeds. Tracks total call count. */
    class FlakyNode implements IBaseNode {
      public calls = 0;
      constructor(private readonly failCount: number) {}
      async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
        this.calls++;
        if (this.calls <= this.failCount) {
          throw new Error(`attempt ${this.calls} failed`);
        }
        return { ok: true };
      }
    }

    /** Always fails. Tracks total call count. */
    class AlwaysFailNode implements IBaseNode {
      public calls = 0;
      async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
        this.calls++;
        throw new Error('always fails');
      }
    }

    it('retries a step that fails twice then succeeds: execute() called 3 times, retryCount === 2', async () => {
      const registry = new NodeRegistry();
      let created: FlakyNode | undefined;

      class FlakyFactory implements IBaseNode {
        readonly #inner: FlakyNode;
        constructor() {
          this.#inner = new FlakyNode(2);
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-flaky', FlakyFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-flaky',
          config: {},
          retry: { attempts: 3, delayMs: 0 },
        },
      ]);

      const result = await executor.run(config);

      expect(created?.calls).toBe(3);
      const steps = result.context.get('steps') as Record<string, { retryCount: number }>;
      expect(steps['step-a'].retryCount).toBe(2);
    });

    it('does not retry when retry.attempts is 1: execute() called once, STEP_EXECUTION_FAILED thrown', async () => {
      const registry = new NodeRegistry();
      let created: AlwaysFailNode | undefined;

      class AlwaysFailFactory implements IBaseNode {
        readonly #inner: AlwaysFailNode;
        constructor() {
          this.#inner = new AlwaysFailNode();
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-always-fail', AlwaysFailFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-always-fail',
          config: {},
          retry: { attempts: 1, delayMs: 0 },
        },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      expect(created?.calls).toBe(1);
    });

    it('does not retry a step with no retry block at all: execute() called once', async () => {
      const registry = new NodeRegistry();
      let created: AlwaysFailNode | undefined;

      class AlwaysFailFactory implements IBaseNode {
        readonly #inner: AlwaysFailNode;
        constructor() {
          this.#inner = new AlwaysFailNode();
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-always-fail', AlwaysFailFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-always-fail', config: {} },
      ]);

      await expect(executor.run(config)).rejects.toThrow();
      expect(created?.calls).toBe(1);
    });

    it('succeeds on the first attempt: execute() called once, retryCount === 0', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-echo',
          config: { value: 1 },
          retry: { attempts: 3, delayMs: 0 },
        },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<string, { retryCount: number }>;
      expect(steps['step-a'].retryCount).toBe(0);
    });

    it('throws STEP_EXECUTION_FAILED only after all 3 attempts fail, not after the 1st', async () => {
      const registry = new NodeRegistry();
      let created: AlwaysFailNode | undefined;

      class AlwaysFailFactory implements IBaseNode {
        readonly #inner: AlwaysFailNode;
        constructor() {
          this.#inner = new AlwaysFailNode();
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-always-fail', AlwaysFailFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-always-fail',
          config: {},
          retry: { attempts: 3, delayMs: 0 },
        },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      expect(created?.calls).toBe(3);
    });

    it('with continueOnError: true, records the error in stepErrors only after all retries are exhausted', async () => {
      const registry = new NodeRegistry();
      let created: AlwaysFailNode | undefined;

      class AlwaysFailFactory implements IBaseNode {
        readonly #inner: AlwaysFailNode;
        constructor() {
          this.#inner = new AlwaysFailNode();
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-always-fail', AlwaysFailFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-always-fail',
          config: {},
          retry: { attempts: 3, delayMs: 0 },
          continueOnError: true,
        },
      ]);

      const result = await executor.run(config);

      expect(result.stepErrors).toHaveLength(1);
      expect(result.stepErrors[0].stepName).toBe('step-a');
      expect(created?.calls).toBe(3);
    });

    it('calls beforeExecute() exactly once even when execute() retries 3 times', async () => {
      const registry = new NodeRegistry();
      let created: TrackingNode | undefined;

      class RetryingTrackingFactory implements IBaseNode {
        readonly #inner: TrackingNode;
        #calls = 0;
        constructor() {
          this.#inner = new TrackingNode();
          created = this.#inner;
        }
        beforeExecute(config: NodeConfig, ctx: IExecutionContext): Promise<void> {
          return this.#inner.beforeExecute(config, ctx);
        }
        async execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          this.#calls++;
          if (this.#calls < 3) {
            this.#inner.calls.push('execute');
            throw new Error('boom');
          }
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-retry-track', RetryingTrackingFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-retry-track',
          config: {},
          retry: { attempts: 3, delayMs: 0 },
        },
      ]);

      await executor.run(config);

      const beforeExecuteCalls = created?.calls.filter(c => c === 'beforeExecute').length;
      expect(beforeExecuteCalls).toBe(1);
    });

    it('interpolates config exactly once even when execute() retries — resolved config reference is identical across attempts', async () => {
      const registry = new NodeRegistry();
      const seenConfigs: NodeConfig[] = [];

      class ConfigSpyNode implements IBaseNode {
        #calls = 0;
        async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          this.#calls++;
          seenConfigs.push(config);
          if (this.#calls < 2) {
            throw new Error('fail once');
          }
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-config-spy', ConfigSpyNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-config-spy',
          config: { value: '{{ trigger.payload }}' },
          retry: { attempts: 2, delayMs: 0 },
        },
      ]);

      await executor.run(config, { trigger: { payload: 'seed' } });

      expect(seenConfigs).toHaveLength(2);
      expect(seenConfigs[0]).toBe(seenConfigs[1]);
    });

    it('does not call afterExecute() when all retry attempts fail', async () => {
      const registry = new NodeRegistry();
      let created: TrackingFailNode | undefined;

      class RetryingTrackingFailFactory implements IBaseNode {
        readonly #inner: TrackingFailNode;
        constructor() {
          this.#inner = new TrackingFailNode();
          created = this.#inner;
        }
        beforeExecute(config: NodeConfig, ctx: IExecutionContext): Promise<void> {
          return this.#inner.beforeExecute(config, ctx);
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
        afterExecute(output: NodeOutput, ctx: IExecutionContext): Promise<void> {
          return this.#inner.afterExecute(output, ctx);
        }
      }

      registry.register('@cognipipe/node-retry-track-fail', RetryingTrackingFailFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-retry-track-fail',
          config: {},
          retry: { attempts: 3, delayMs: 0 },
        },
      ]);

      await expect(executor.run(config)).rejects.toThrow();

      expect(created?.calls.filter(c => c === 'afterExecute')).toHaveLength(0);
      expect(created?.calls.filter(c => c === 'execute')).toHaveLength(3);
    });
  });

  describe('backoff timing', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** Fails `failCount` times then succeeds. Tracks total call count. */
    class FlakyNode implements IBaseNode {
      public calls = 0;
      constructor(private readonly failCount: number) {}
      async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
        this.calls++;
        if (this.calls <= this.failCount) {
          throw new Error(`attempt ${this.calls} failed`);
        }
        return { ok: true };
      }
    }

    it('waits a constant delayMs between attempts for linear backoff', async () => {
      const registry = new NodeRegistry();
      let created: FlakyNode | undefined;

      class FlakyFactory implements IBaseNode {
        readonly #inner: FlakyNode;
        constructor() {
          this.#inner = new FlakyNode(2);
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-flaky', FlakyFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-flaky',
          config: {},
          retry: { attempts: 3, delayMs: 1000, backoff: 'linear' },
        },
      ]);

      const runPromise = executor.run(config);
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(1000);
      await runPromise;

      expect(created?.calls).toBe(3);
    });

    it('doubles delayMs on each retry for exponential backoff', async () => {
      const registry = new NodeRegistry();
      let created: FlakyNode | undefined;

      class FlakyFactory implements IBaseNode {
        readonly #inner: FlakyNode;
        constructor() {
          this.#inner = new FlakyNode(2);
          created = this.#inner;
        }
        execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute(config, ctx);
        }
      }

      registry.register('@cognipipe/node-flaky', FlakyFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'step-a',
          uses: '@cognipipe/node-flaky',
          config: {},
          retry: { attempts: 3, delayMs: 1000, backoff: 'exponential' },
        },
      ]);

      const runPromise = executor.run(config);
      await jest.advanceTimersByTimeAsync(1000); // delay after attempt 0: 1000 * 2^0
      await jest.advanceTimersByTimeAsync(2000); // delay after attempt 1: 1000 * 2^1
      await runPromise;

      expect(created?.calls).toBe(3);
    });
  });
});

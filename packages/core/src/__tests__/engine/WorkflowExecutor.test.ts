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
          // Reading step-a's output requires an explicit dependency under
          // the DAG scheduler — a step with no `dependsOn` is eligible to
          // run immediately, concurrently with step-a, not "after" it.
          dependsOn: ['step-a'],
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

  describe('circular dependency', () => {
    it('throws CIRCULAR_DEPENDENCY before run() does anything else', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['b'] },
        { name: 'b', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['a'] },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe(COGNIPIPE_ERROR_CODES.CIRCULAR_DEPENDENCY);
    });

    it('zero nodes are instantiated when a cycle is detected', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const instantiateSpy = jest.spyOn(registry, 'instantiate');
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['b'] },
        { name: 'b', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['a'] },
      ]);

      try {
        await executor.run(config);
      } catch {
        // expected
      }

      expect(instantiateSpy).not.toHaveBeenCalled();
      instantiateSpy.mockRestore();
    });

    it('error message contains the cycle path', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['b'] },
        { name: 'b', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['a'] },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      const message = (thrown as Error).message;
      expect(message).toContain('a → b → a');
    });

    it('a valid (acyclic) workflow is unaffected by the new check', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-echo', config: {} },
        { name: 'b', uses: '@cognipipe/node-echo', config: {}, dependsOn: ['a'] },
      ]);

      const result = await executor.run(config);
      expect(result.stepErrors).toEqual([]);
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
          dependsOn: ['prev'],
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
          dependsOn: ['auth'],
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
          dependsOn: ['a'],
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

  describe('parallel execution (DAG-based)', () => {
    it('runs two independent steps concurrently — both start before either completes', async () => {
      const registry = new NodeRegistry();
      const callOrder: string[] = [];
      const resolvers: Array<() => void> = [];

      class DelayedNodeA implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          callOrder.push('start-a');
          await new Promise<void>(resolve => resolvers.push(resolve));
          callOrder.push('end-a');
          return { ok: true };
        }
      }

      class DelayedNodeB implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          callOrder.push('start-b');
          await new Promise<void>(resolve => resolvers.push(resolve));
          callOrder.push('end-b');
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-delayed-a', DelayedNodeA);
      registry.register('@cognipipe/node-delayed-b', DelayedNodeB);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-delayed-a', config: {} },
        { name: 'b', uses: '@cognipipe/node-delayed-b', config: {} },
      ]);

      const runPromise = executor.run(config);

      // Wait (via microtask flushes) until both nodes have started, without
      // resolving either — a sequential executor would never reach 'start-b'
      // until node A's execute() had already resolved.
      for (let i = 0; i < 50 && resolvers.length < 2; i++) {
        await Promise.resolve();
      }

      expect(callOrder).toContain('start-a');
      expect(callOrder).toContain('start-b');
      expect(callOrder.filter(c => c.startsWith('end'))).toHaveLength(0);

      resolvers.forEach(r => r());
      await runPromise;
    });

    it('a step with dependsOn: ["a"] does not start until "a" completes', async () => {
      const registry = new NodeRegistry();
      const timestamps: Record<string, number> = {};

      class TimedNodeA implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          timestamps['start-a'] = Date.now();
          await new Promise(resolve => setTimeout(resolve, 50));
          timestamps['end-a'] = Date.now();
          return { ok: true };
        }
      }

      class TimedNodeB implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          timestamps['start-b'] = Date.now();
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-timed-a', TimedNodeA);
      registry.register('@cognipipe/node-timed-b', TimedNodeB);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-timed-a', config: {} },
        { name: 'b', uses: '@cognipipe/node-timed-b', config: {}, dependsOn: ['a'] },
      ]);

      await executor.run(config);

      expect(timestamps['start-b']).toBeGreaterThanOrEqual(timestamps['end-a']);
    });

    it('a dependsOn entry may name a step declared LATER in the array', async () => {
      // "b" is declared FIRST but depends on "a", which is declared SECOND.
      // Regression test: a naive scheduler that builds its completion map by
      // walking `config.steps` in order and looking up `completions.get(dep)`
      // as it goes would find nothing for "a" here and treat "b" as having no
      // real dependency, letting it run before "a".
      const registry = new NodeRegistry();
      const timestamps: Record<string, number> = {};

      class TimedNodeA implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          timestamps['start-a'] = Date.now();
          await new Promise(resolve => setTimeout(resolve, 50));
          timestamps['end-a'] = Date.now();
          return { ok: true };
        }
      }

      class TimedNodeB implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          timestamps['start-b'] = Date.now();
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-timed-a', TimedNodeA);
      registry.register('@cognipipe/node-timed-b', TimedNodeB);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'b', uses: '@cognipipe/node-timed-b', config: {}, dependsOn: ['a'] },
        { name: 'a', uses: '@cognipipe/node-timed-a', config: {} },
      ]);

      await executor.run(config);

      expect(timestamps['start-b']).toBeGreaterThanOrEqual(timestamps['end-a']);
    });

    it('diamond dependency (a → b, a → c, b and c → d): d does not start until BOTH b and c complete', async () => {
      const registry = new NodeRegistry();
      const timestamps: Record<string, number> = {};

      class TimedNode implements IBaseNode {
        constructor(
          private readonly key: string,
          private readonly delayMs: number,
        ) {}
        async execute(): Promise<NodeOutput> {
          timestamps[`start-${this.key}`] = Date.now();
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
          timestamps[`end-${this.key}`] = Date.now();
          return { ok: true };
        }
      }

      class NodeAFactory implements IBaseNode {
        #inner = new TimedNode('a', 10);
        execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute();
        }
      }
      class NodeBFactory implements IBaseNode {
        #inner = new TimedNode('b', 50);
        execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute();
        }
      }
      class NodeCFactory implements IBaseNode {
        #inner = new TimedNode('c', 20);
        execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute();
        }
      }
      class NodeDFactory implements IBaseNode {
        #inner = new TimedNode('d', 10);
        execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
          return this.#inner.execute();
        }
      }

      registry.register('@cognipipe/node-a', NodeAFactory);
      registry.register('@cognipipe/node-b', NodeBFactory);
      registry.register('@cognipipe/node-c', NodeCFactory);
      registry.register('@cognipipe/node-d', NodeDFactory);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'a', uses: '@cognipipe/node-a', config: {} },
        { name: 'b', uses: '@cognipipe/node-b', config: {}, dependsOn: ['a'] },
        { name: 'c', uses: '@cognipipe/node-c', config: {}, dependsOn: ['a'] },
        { name: 'd', uses: '@cognipipe/node-d', config: {}, dependsOn: ['b', 'c'] },
      ]);

      await executor.run(config);

      expect(timestamps['start-d']).toBeGreaterThanOrEqual(timestamps['end-b']);
      expect(timestamps['start-d']).toBeGreaterThanOrEqual(timestamps['end-c']);
    });

    it('the final ExecutionContext contains results from ALL steps regardless of completion order', async () => {
      const registry = new NodeRegistry();

      class DelayedNode implements IBaseNode {
        constructor(
          private readonly value: string,
          private readonly delayMs: number,
        ) {}
        async execute(): Promise<NodeOutput> {
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
          return { value: this.value };
        }
      }

      class SlowFactory implements IBaseNode {
        #inner = new DelayedNode('slow', 50);
        execute() {
          return this.#inner.execute();
        }
      }
      class FastFactory implements IBaseNode {
        #inner = new DelayedNode('fast', 5);
        execute() {
          return this.#inner.execute();
        }
      }

      registry.register('@cognipipe/node-slow', SlowFactory);
      registry.register('@cognipipe/node-fast', FastFactory);
      const executor = new WorkflowExecutor(registry);

      // "slow" is declared FIRST but finishes LAST.
      const config = buildWorkflow([
        { name: 'slow', uses: '@cognipipe/node-slow', config: {} },
        { name: 'fast', uses: '@cognipipe/node-fast', config: {} },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<string, { output: { value: string } }>;

      expect(steps['fast'].output.value).toBe('fast');
      expect(steps['slow'].output.value).toBe('slow');
    });

    it('retry still works correctly on a step running in the concurrent scheduler', async () => {
      const registry = new NodeRegistry();
      let calls = 0;

      class FlakyConcurrentNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          calls++;
          if (calls < 3) {
            throw new Error('flaky');
          }
          return { ok: true };
        }
      }

      registry.register('@cognipipe/node-flaky-concurrent', FlakyConcurrentNode);
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'independent',
          uses: '@cognipipe/node-flaky-concurrent',
          config: {},
          retry: { attempts: 3, delayMs: 0 },
        },
        { name: 'echo', uses: '@cognipipe/node-echo', config: { v: 1 } },
      ]);

      const result = await executor.run(config);

      expect(calls).toBe(3);
      const steps = result.context.get('steps') as Record<string, { retryCount: number }>;
      expect(steps['independent'].retryCount).toBe(2);
    });

    it('continueOnError: true on a failing step does not block an unrelated independent step, and lets a dependent proceed to (and itself fail) an interpolation error', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'fail-step', uses: '@cognipipe/node-fail', config: {}, continueOnError: true },
        { name: 'independent', uses: '@cognipipe/node-echo', config: { v: 1 } },
        {
          name: 'dependent',
          uses: '@cognipipe/node-echo',
          config: { val: '{{ steps.fail-step.output.x }}' },
          dependsOn: ['fail-step'],
          continueOnError: true,
        },
      ]);

      const result = await executor.run(config);

      expect(result.stepErrors).toHaveLength(2);
      expect(result.stepErrors.map(e => e.stepName)).toEqual(['fail-step', 'dependent']);

      const steps = result.context.get('steps') as Record<
        string,
        { output: { echoed: { v: number } } }
      >;
      expect(steps['independent'].output.echoed.v).toBe(1);
    });

    it('a step that fails WITHOUT continueOnError still rejects run(), even though unrelated independent steps ran concurrently', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'fail-step', uses: '@cognipipe/node-fail', config: {} },
        { name: 'independent', uses: '@cognipipe/node-echo', config: { v: 1 } },
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

    it('a fatal failure in a dependency prevents its dependent from starting and rejects run()', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);

      let dependentStarted = false;

      class DependentNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          dependentStarted = true;
          return { ok: true };
        }
      }
      registry.register('@cognipipe/node-dependent', DependentNode);

      const config = buildWorkflow([
        { name: 'fail-step', uses: '@cognipipe/node-fail', config: {} },
        {
          name: 'dependent',
          uses: '@cognipipe/node-dependent',
          config: {},
          dependsOn: ['fail-step'],
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
      expect(dependentStarted).toBe(false);
    });

    it('treats a dependsOn entry naming a non-existent step as already-satisfied (dangling reference)', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        {
          name: 'orphan',
          uses: '@cognipipe/node-echo',
          config: { value: 1 },
          dependsOn: ['does-not-exist'],
        },
      ]);

      const result = await executor.run(config);
      const steps = result.context.get('steps') as Record<string, { output: unknown }>;
      expect(steps['orphan'].output).toEqual({ echoed: { value: 1 } });
    });

    it('overwrites an array seed value for the reserved "steps" namespace with the step results object', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-echo', EchoNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'step-a', uses: '@cognipipe/node-echo', config: { value: 1 } },
      ]);

      // Seed 'steps' as an array to exercise the !Array.isArray() false branch in scheduleContextWrite
      const result = await executor.run(config, { steps: ['malformed-seed'] });

      const steps = result.context.get('steps') as Record<string, { output: unknown }>;
      expect(steps['step-a'].output).toEqual({ echoed: { value: 1 } });
    });

    it('a fatal failure in multiple independent branches captures the first fatal error and rejects run()', async () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-fail', FailNode);
      const executor = new WorkflowExecutor(registry);

      const config = buildWorkflow([
        { name: 'fail-1', uses: '@cognipipe/node-fail', config: {} },
        { name: 'fail-2', uses: '@cognipipe/node-fail', config: {} },
      ]);

      let thrown: unknown;
      try {
        await executor.run(config);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
    });

    it('stress test: 10 independent steps with randomized delays all complete and are present in the final context', async () => {
      const registry = new NodeRegistry();

      class RandomDelayNode implements IBaseNode {
        constructor(private readonly id: number) {}
        async execute(): Promise<NodeOutput> {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 30));
          return { id: this.id };
        }
      }

      for (let i = 0; i < 10; i++) {
        const id = i;
        class Factory implements IBaseNode {
          #inner = new RandomDelayNode(id);
          execute(): Promise<NodeOutput> {
            return this.#inner.execute();
          }
        }
        registry.register(`@cognipipe/node-rand-${i}`, Factory);
      }

      const executor = new WorkflowExecutor(registry);
      const steps = Array.from({ length: 10 }, (_, i) => ({
        name: `step-${i}`,
        uses: `@cognipipe/node-rand-${i}`,
        config: {},
      }));

      const config = buildWorkflow(steps);
      const result = await executor.run(config);
      const contextSteps = result.context.get('steps') as Record<
        string,
        { output: { id: number } }
      >;

      for (let i = 0; i < 10; i++) {
        expect(contextSteps[`step-${i}`].output.id).toBe(i);
      }
    });
  });
});

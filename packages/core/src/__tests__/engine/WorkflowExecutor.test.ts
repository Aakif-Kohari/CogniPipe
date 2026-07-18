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
});

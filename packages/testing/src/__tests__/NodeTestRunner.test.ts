/**
 * @module NodeTestRunner.test
 *
 * Tests for NodeTestRunner: lifecycle order, config interpolation, env and
 * fetch isolation (including restoration when the node throws), failure
 * reporting, and the guard against overlapping runs that use overrides.
 */

import type { IBaseNode, IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import { MockContext } from '../MockContext';
import { NodeTestRunner, type NodeTestRunResult } from '../NodeTestRunner';

type SuccessfulRun = Extract<NodeTestRunResult, { ok: true }>;
type FailedRun = Extract<NodeTestRunResult, { ok: false }>;

function expectOk(result: NodeTestRunResult): asserts result is SuccessfulRun {
  if (!result.ok) {
    throw new Error(`Expected a successful run, but it failed with: ${String(result.error)}`);
  }
}

function expectFailed(result: NodeTestRunResult): asserts result is FailedRun {
  if (result.ok) {
    throw new Error('Expected a failed run, but it succeeded.');
  }
}

const ENV_VAR = 'COGNIPIPE_TEST_RUNNER_VAR';
const SEED = { steps: { auth: { output: { token: 'abc' } } } };

const events: string[] = [];

class LifecycleNode implements IBaseNode {
  async beforeExecute(): Promise<void> {
    events.push('before:start');
    await Promise.resolve();
    events.push('before:end');
  }

  async execute(): Promise<NodeOutput> {
    events.push('execute:start');
    await Promise.resolve();
    events.push('execute:end');
    return { done: true };
  }

  async afterExecute(): Promise<void> {
    events.push('after');
  }
}

class ExecuteOnlyNode implements IBaseNode {
  async execute(): Promise<NodeOutput> {
    return { ok: 1 };
  }
}

class EchoConfigNode implements IBaseNode {
  async execute(config: NodeConfig): Promise<NodeOutput> {
    return { ...config };
  }
}

class FetchNode implements IBaseNode {
  async execute(): Promise<NodeOutput> {
    const response = await globalThis.fetch('https://api.example.test/ping');
    return { status: response.status };
  }
}

class EnvNode implements IBaseNode {
  async execute(): Promise<NodeOutput> {
    return { seen: process.env[ENV_VAR] };
  }
}

function fetchStub(status = 200): typeof globalThis.fetch {
  return jest.fn(async () => ({ status })) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  events.length = 0;
  delete process.env[ENV_VAR];
});

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe('NodeTestRunner', () => {
  describe('lifecycle', () => {
    it('runs beforeExecute, execute and afterExecute in order and returns the output', async () => {
      const result = await new NodeTestRunner(LifecycleNode).run({ greeting: 'hi' });

      expectOk(result);
      expect(result.output).toEqual({ done: true });
      expect(result.resolvedConfig).toEqual({ greeting: 'hi' });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.calls).toEqual(['beforeExecute', 'execute', 'afterExecute']);
      // Each hook is awaited before the next one starts.
      expect(events).toEqual([
        'before:start',
        'before:end',
        'execute:start',
        'execute:end',
        'after',
      ]);
    });

    it('treats beforeExecute and afterExecute as optional', async () => {
      const result = await new NodeTestRunner(ExecuteOnlyNode).run({});

      expectOk(result);
      expect(result.calls).toEqual(['execute']);
    });

    it('hands the resolved config, the output and the same context to the hooks', async () => {
      const seen: Record<string, unknown[]> = {};

      class RecordingNode implements IBaseNode {
        async beforeExecute(config: NodeConfig, ctx: IExecutionContext): Promise<void> {
          seen['before'] = [config, ctx];
        }

        async execute(config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          seen['execute'] = [config, ctx];
          return { value: 42 };
        }

        async afterExecute(output: NodeOutput, ctx: IExecutionContext): Promise<void> {
          seen['after'] = [output, ctx];
        }
      }

      const result = await new NodeTestRunner(RecordingNode).run(
        { token: '{{ steps.auth.output.token }}' },
        { context: SEED },
      );

      expectOk(result);
      expect(seen['before']).toEqual([{ token: 'abc' }, result.context]);
      expect(seen['execute']).toEqual([{ token: 'abc' }, result.context]);
      expect(seen['after']?.[0]).toEqual({ value: 42 });
      expect(seen['before']?.[1]).toBe(result.context);
      expect(seen['execute']?.[1]).toBe(result.context);
      expect(seen['after']?.[1]).toBe(result.context);
    });

    it('constructs a fresh node instance for every run', async () => {
      class CounterNode implements IBaseNode {
        #count = 0;

        async execute(): Promise<NodeOutput> {
          this.#count += 1;
          return { count: this.#count };
        }
      }
      const runner = new NodeTestRunner(CounterNode);

      const first = await runner.run({});
      const second = await runner.run({});

      expectOk(first);
      expectOk(second);
      expect(first.output).toEqual({ count: 1 });
      expect(second.output).toEqual({ count: 1 });
    });
  });

  describe('config interpolation', () => {
    it('resolves tokens in nested objects and arrays and passes other leaves through', async () => {
      const result = await new NodeTestRunner(EchoConfigNode).run(
        {
          token: '{{ steps.auth.output.token }}',
          nested: { header: 'Bearer {{ steps.auth.output.token }}' },
          list: ['{{ steps.auth.output.token }}', 7, true, null],
          retries: 3,
        },
        { context: SEED },
      );

      expectOk(result);
      expect(result.resolvedConfig).toEqual({
        token: 'abc',
        nested: { header: 'Bearer abc' },
        list: ['abc', 7, true, null],
        retries: 3,
      });
      expect(result.output).toEqual(result.resolvedConfig);
    });

    it('passes the raw strings through when interpolate is false', async () => {
      const config = { token: '{{ steps.auth.output.token }}', list: ['{{ nothing.here }}'] };

      const result = await new NodeTestRunner(EchoConfigNode).run(config, {
        context: SEED,
        interpolate: false,
      });

      expectOk(result);
      expect(result.resolvedConfig).toEqual(config);
    });
  });

  describe('context', () => {
    it('returns the seeded MockContext the node received', async () => {
      let received: IExecutionContext | undefined;

      class ContextNode implements IBaseNode {
        async execute(_config: NodeConfig, ctx: IExecutionContext): Promise<NodeOutput> {
          received = ctx;
          return {};
        }
      }

      const result = await new NodeTestRunner(ContextNode).run({}, { context: SEED });

      expectOk(result);
      expect(result.context).toBeInstanceOf(MockContext);
      expect(received).toBe(result.context);
      expect(result.context.get('steps')).toEqual(SEED.steps);
    });

    it('starts from an empty context when no seed is given', async () => {
      const result = await new NodeTestRunner(ExecuteOnlyNode).run({});

      expectOk(result);
      expect(result.context.toJSON()).toEqual({});
    });
  });

  describe('env overrides', () => {
    it('makes the values visible during the run and restores a previously-set variable', async () => {
      process.env[ENV_VAR] = 'original';

      const result = await new NodeTestRunner(EnvNode).run({}, { env: { [ENV_VAR]: 'override' } });

      expectOk(result);
      expect(result.output).toEqual({ seen: 'override' });
      expect(process.env[ENV_VAR]).toBe('original');
    });

    it('deletes a previously-unset variable afterwards instead of leaving "undefined"', async () => {
      const result = await new NodeTestRunner(EnvNode).run({}, { env: { [ENV_VAR]: 'override' } });

      expectOk(result);
      expect(result.output).toEqual({ seen: 'override' });
      expect(ENV_VAR in process.env).toBe(false);
    });

    it('unsets the variable for the run when the value is undefined, then restores it', async () => {
      process.env[ENV_VAR] = 'original';

      const result = await new NodeTestRunner(EnvNode).run({}, { env: { [ENV_VAR]: undefined } });

      expectOk(result);
      expect(result.output).toEqual({ seen: undefined });
      expect(process.env[ENV_VAR]).toBe('original');
    });

    it('applies the overrides before the node is constructed', async () => {
      class EnvInConstructorNode implements IBaseNode {
        readonly #seen = process.env[ENV_VAR];

        async execute(): Promise<NodeOutput> {
          return { seen: this.#seen };
        }
      }

      const result = await new NodeTestRunner(EnvInConstructorNode).run(
        {},
        { env: { [ENV_VAR]: 'from-options' } },
      );

      expectOk(result);
      expect(result.output).toEqual({ seen: 'from-options' });
    });
  });

  describe('fetch override', () => {
    it('is what the node sees during the run, and the original is restored afterwards', async () => {
      const originalFetch = globalThis.fetch;
      const stub = fetchStub(204);

      const result = await new NodeTestRunner(FetchNode).run({}, { fetch: stub });

      expectOk(result);
      expect(result.output).toEqual({ status: 204 });
      expect(stub).toHaveBeenCalledWith('https://api.example.test/ping');
      expect(globalThis.fetch).toBe(originalFetch);
    });

    it('removes fetch again when it did not exist before the run', async () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      Reflect.deleteProperty(globalThis, 'fetch');

      try {
        const stub = fetchStub();

        const result = await new NodeTestRunner(FetchNode).run({}, { fetch: stub });

        expectOk(result);
        expect(stub).toHaveBeenCalledTimes(1);
        expect('fetch' in globalThis).toBe(false);
      } finally {
        if (originalDescriptor !== undefined) {
          Object.defineProperty(globalThis, 'fetch', originalDescriptor);
        }
      }
    });
  });

  describe('node failures', () => {
    it('returns the exact thrown error and skips afterExecute when execute() throws', async () => {
      const thrown = new Error('execute failed');

      class FailingNode implements IBaseNode {
        async beforeExecute(): Promise<void> {
          events.push('before');
        }

        async execute(): Promise<NodeOutput> {
          throw thrown;
        }

        async afterExecute(): Promise<void> {
          events.push('after');
        }
      }

      const result = await new NodeTestRunner(FailingNode).run({ a: 1 });

      expectFailed(result);
      expect(result.error).toBe(thrown);
      expect(result.calls).toEqual(['beforeExecute', 'execute']);
      expect(result.resolvedConfig).toEqual({ a: 1 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(events).toEqual(['before']);
    });

    it('returns a non-Error thrown value unwrapped', async () => {
      const thrownObject = { code: 'E_PLAIN' };

      class ThrowsStringNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          throw 'just a string';
        }
      }

      class ThrowsObjectNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          throw thrownObject;
        }
      }

      const fromString = await new NodeTestRunner(ThrowsStringNode).run({});
      const fromObject = await new NodeTestRunner(ThrowsObjectNode).run({});

      expectFailed(fromString);
      expectFailed(fromObject);
      expect(fromString.error).toBe('just a string');
      expect(fromObject.error).toBe(thrownObject);
    });

    it('fails with a plain Error and invokes nothing when a {{ }} token cannot be resolved', async () => {
      const result = await new NodeTestRunner(LifecycleNode).run(
        { token: '{{ steps.missing.output }}' },
        { context: SEED },
      );

      expectFailed(result);
      expect(result.calls).toEqual([]);
      expect(result.resolvedConfig).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).name).toBe('Error');
      expect((result.error as Error).message).toContain('steps.missing.output');
      expect(events).toEqual([]);
    });

    it('does not invoke execute() when beforeExecute() throws', async () => {
      const thrown = new Error('precondition failed');

      class BeforeFailsNode implements IBaseNode {
        async beforeExecute(): Promise<void> {
          throw thrown;
        }

        async execute(): Promise<NodeOutput> {
          events.push('execute');
          return {};
        }
      }

      const result = await new NodeTestRunner(BeforeFailsNode).run({});

      expectFailed(result);
      expect(result.error).toBe(thrown);
      expect(result.calls).toEqual(['beforeExecute']);
      expect(events).toEqual([]);
    });

    it('fails the run when afterExecute() throws', async () => {
      const thrown = new Error('cleanup failed');

      class AfterFailsNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          return { value: 1 };
        }

        async afterExecute(): Promise<void> {
          throw thrown;
        }
      }

      const result = await new NodeTestRunner(AfterFailsNode).run({});

      expectFailed(result);
      expect(result.error).toBe(thrown);
      expect(result.calls).toEqual(['execute', 'afterExecute']);
    });

    it('resolves with a failed result instead of rejecting when the constructor throws', async () => {
      const thrown = new Error('constructor failed');

      class ConstructorFailsNode implements IBaseNode {
        constructor() {
          throw thrown;
        }

        async execute(): Promise<NodeOutput> {
          return {};
        }
      }

      const result = await new NodeTestRunner(ConstructorFailsNode).run({ a: 1 });

      expectFailed(result);
      expect(result.error).toBe(thrown);
      expect(result.calls).toEqual([]);
      expect(result.resolvedConfig).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('restores env and fetch even when the node throws', async () => {
      process.env[ENV_VAR] = 'original';
      const originalFetch = globalThis.fetch;

      class ThrowsNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          throw new Error('boom');
        }
      }

      const result = await new NodeTestRunner(ThrowsNode).run(
        {},
        { env: { [ENV_VAR]: 'override', COGNIPIPE_TEST_RUNNER_OTHER: 'x' }, fetch: fetchStub() },
      );

      expectFailed(result);
      expect(process.env[ENV_VAR]).toBe('original');
      expect('COGNIPIPE_TEST_RUNNER_OTHER' in process.env).toBe(false);
      expect(globalThis.fetch).toBe(originalFetch);
    });

    it('restores env even when the constructor throws', async () => {
      class ConstructorFailsNode implements IBaseNode {
        constructor() {
          throw new Error('constructor failed');
        }

        async execute(): Promise<NodeOutput> {
          return {};
        }
      }

      const result = await new NodeTestRunner(ConstructorFailsNode).run(
        {},
        { env: { [ENV_VAR]: 'override' } },
      );

      expectFailed(result);
      expect(ENV_VAR in process.env).toBe(false);
    });
  });

  describe('overlapping runs', () => {
    // A node that stays "in flight" until the test releases the gate — no timers involved.
    function createGate(): { wait: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const wait = new Promise<void>(resolve => {
        release = resolve;
      });
      return { wait, release };
    }

    function createGatedNode(wait: Promise<void>): new () => IBaseNode {
      return class GatedNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          await wait;
          return {};
        }
      };
    }

    it('rejects a second run() that also passes env, and leaves the first run untouched', async () => {
      const gate = createGate();
      const runner = new NodeTestRunner(createGatedNode(gate.wait));

      const first = runner.run({}, { env: { [ENV_VAR]: 'first' } });
      const second = runner.run({}, { env: { [ENV_VAR]: 'second' } });

      // The overlap guard is static, so a run left in flight by a failed assertion
      // would make every later override test fail with a misleading "cannot overlap".
      // The finally therefore always releases the gate and settles the first run.
      // Both are safe to repeat: releasing a released gate is a no-op, and awaiting
      // an already-settled promise just reads its value.
      try {
        await expect(second).rejects.toThrow(/cannot overlap/);
        expect(process.env[ENV_VAR]).toBe('first');

        gate.release();
        const firstResult = await first;

        expectOk(firstResult);
        expect(ENV_VAR in process.env).toBe(false);
      } finally {
        gate.release();
        await first;
      }
    });

    it('rejects overlapping runs across runner instances and across env and fetch', async () => {
      const gate = createGate();
      const first = new NodeTestRunner(createGatedNode(gate.wait)).run({}, { fetch: fetchStub() });

      // Same guarantee as above: never leave the gated run holding the static guard.
      try {
        await expect(
          new NodeTestRunner(ExecuteOnlyNode).run({}, { env: { [ENV_VAR]: 'x' } }),
        ).rejects.toThrow(/cannot overlap/);

        gate.release();
        expectOk(await first);
      } finally {
        gate.release();
        await first;
      }
    });

    it('lets a run without overrides overlap with one that has them', async () => {
      const gate = createGate();
      const runner = new NodeTestRunner(createGatedNode(gate.wait));

      const withOverrides = runner.run({}, { env: { [ENV_VAR]: 'x' } });
      const withoutOverrides = runner.run({});

      // Released before any assertion, so a failure below cannot strand a run.
      gate.release();

      expectOk(await withOverrides);
      expectOk(await withoutOverrides);
    });

    it('releases the guard after a failed run and after a rejected overlap', async () => {
      const gate = createGate();
      const runner = new NodeTestRunner(createGatedNode(gate.wait));

      class ThrowsNode implements IBaseNode {
        async execute(): Promise<NodeOutput> {
          throw new Error('boom');
        }
      }

      // Declared out here so the finally can settle the gated run even when an
      // earlier assertion fails before it is ever started.
      let gated: Promise<NodeTestRunResult> | undefined;

      try {
        expectFailed(await new NodeTestRunner(ThrowsNode).run({}, { env: { [ENV_VAR]: 'a' } }));
        expectOk(await new NodeTestRunner(ExecuteOnlyNode).run({}, { env: { [ENV_VAR]: 'b' } }));

        const first = runner.run({}, { env: { [ENV_VAR]: 'c' } });
        gated = first;
        await expect(runner.run({}, { env: { [ENV_VAR]: 'd' } })).rejects.toThrow(/cannot overlap/);

        gate.release();
        expectOk(await first);

        expectOk(await new NodeTestRunner(ExecuteOnlyNode).run({}, { env: { [ENV_VAR]: 'e' } }));
        expect(ENV_VAR in process.env).toBe(false);
      } finally {
        gate.release();
        if (gated !== undefined) {
          await gated;
        }
      }
    });
  });
});

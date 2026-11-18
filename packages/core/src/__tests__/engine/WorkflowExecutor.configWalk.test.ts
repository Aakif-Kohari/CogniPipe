/**
 * @module WorkflowExecutor.configWalk.test
 *
 * Non-plain config values (Date, Map, Set, typed arrays, class instances) must
 * reach the node unchanged, by reference — the config walk only recurses into
 * plain objects and arrays. Exercised through the public run() because
 * interpolateValue/interpolateConfig are module-private.
 */

import { runInNewContext } from 'node:vm';
import type {
  IBaseNode,
  IExecutionContext,
  NodeConfig,
  NodeOutput,
  WorkflowConfig,
} from '@cognipipe/types';
import { WorkflowExecutor } from '../../engine/WorkflowExecutor';
import { NodeRegistry } from '../../engine/NodeRegistry';

// ---- Inline test doubles — do not import from @cognipipe/sdk ----

class EchoNode implements IBaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    return { echoed: config };
  }
}

/** Builds a minimal valid WorkflowConfig with the given steps. */
function buildWorkflow(steps: WorkflowConfig['steps']): WorkflowConfig {
  return { name: 'test-workflow', version: '1.0.0', steps };
}

class Tagged {
  label = '{{ trigger.payload }}';
}

/** Runs one echo step and returns what the node received as its config. */
async function echoed(
  stepConfig: Record<string, unknown>,
  initial?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const registry = new NodeRegistry();
  registry.register('@cognipipe/node-echo', EchoNode);
  const result = await new WorkflowExecutor(registry).run(
    buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: stepConfig }]),
    initial,
  );
  const steps = result.context.get('steps') as Record<
    string,
    { output: { echoed: Record<string, unknown> } } | undefined
  >;
  const step = steps['step-a'];
  if (step === undefined) {
    throw new Error('step-a produced no result');
  }
  return step.output.echoed;
}

describe('WorkflowExecutor config walk (non-plain values)', () => {
  it('passes a Date config value through by reference', async () => {
    const registry = new NodeRegistry();
    registry.register('@cognipipe/node-echo', EchoNode);
    const executor = new WorkflowExecutor(registry);

    const d = new Date('2026-01-01T00:00:00Z');
    const config = buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: { d } }]);

    const result = await executor.run(config);

    const steps = result.context.get('steps') as Record<
      string,
      { output: { echoed: { d: unknown } } }
    >;
    expect(steps['step-a']?.output.echoed.d).toBe(d);
  });

  it('passes a Map config value through by reference', async () => {
    const registry = new NodeRegistry();
    registry.register('@cognipipe/node-echo', EchoNode);
    const executor = new WorkflowExecutor(registry);

    const m = new Map([['k', 'v']]);
    const config = buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: { m } }]);

    const result = await executor.run(config);

    const steps = result.context.get('steps') as Record<
      string,
      { output: { echoed: { m: unknown } } }
    >;
    expect(steps['step-a']?.output.echoed.m).toBe(m);
  });

  it('still interpolates strings inside plain objects and arrays next to a non-plain value', async () => {
    const registry = new NodeRegistry();
    registry.register('@cognipipe/node-echo', EchoNode);
    const executor = new WorkflowExecutor(registry);

    const d = new Date('2026-01-01T00:00:00Z');
    const config = buildWorkflow([
      {
        name: 'step-a',
        uses: '@cognipipe/node-echo',
        config: { d, nested: { v: '{{ trigger.payload }}' }, list: ['{{ trigger.payload }}'] },
      },
    ]);

    const result = await executor.run(config, { trigger: { payload: 'seed' } });

    const steps = result.context.get('steps') as Record<
      string,
      { output: { echoed: { d: unknown; nested: { v: string }; list: string[] } } }
    >;
    const echoed = steps['step-a']?.output.echoed;
    expect(echoed?.d).toBe(d);
    expect(echoed?.nested).toEqual({ v: 'seed' });
    expect(echoed?.list).toEqual(['seed']);
  });

  it.each([
    ['Set', new Set([1])],
    ['RegExp', /x/g],
    ['Uint8Array', new Uint8Array([1, 2])],
    ['class instance', new Tagged()],
  ])('passes a %s config value through by reference', async (_name, value) => {
    const out = await echoed({ value });

    expect(out['value']).toBe(value);
  });

  it('does not interpolate tokens inside a non-plain object', async () => {
    const tagged = new Tagged();

    const out = await echoed({ tagged }, { trigger: { payload: 'seed' } });

    expect(out['tagged']).toBe(tagged);
    expect(tagged.label).toBe('{{ trigger.payload }}');
  });

  it('still walks a null-prototype object and a plain object from another realm', async () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['v'] = '{{ trigger.payload }}';
    const foreign = runInNewContext('({ v: "{{ trigger.payload }}" })') as Record<string, unknown>;

    const out = await echoed({ bare, foreign }, { trigger: { payload: 'seed' } });

    expect(out['bare']).toEqual({ v: 'seed' });
    expect(out['foreign']).toEqual({ v: 'seed' });
  });
});

/**
 * @module WorkflowExecutor.configWalk.test
 *
 * Non-plain config values (Date, Map, Set, typed arrays, class instances) must
 * reach the node unchanged, by reference — the config walk only recurses into
 * plain objects and arrays. Exercised through the public run() because
 * interpolateValue/interpolateConfig are module-private.
 */

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
});

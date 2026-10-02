/**
 * @module MyNode
 * Starter node. Rename the class, set the real `type`, and replace the config schema.
 */
import { BaseNode, CogniNode, defineConfig } from '@cognipipe/sdk';
import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import { z } from 'zod';

const MyNodeConfig = defineConfig(z.object({ message: z.string().min(1) }));

@CogniNode({ type: '@cognipipe/node-CHANGEME', version: '1.0.0' })
export class MyNode extends BaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    const { message } = MyNodeConfig.parse(config);
    return { echoed: message };
  }
}

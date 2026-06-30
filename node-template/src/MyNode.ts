// STEP 1: Rename this file and class to match your service
// STEP 2: Replace 'my-org/my-node' with your actual node type
// STEP 3: Define your config interface
// STEP 4: Implement the execute() method
// STEP 5: Write tests in __tests__/MyNode.test.ts

import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';

// TODO: Import BaseNode once @cognipipe/sdk is published
// import { BaseNode, CogniNode } from '@cognipipe/sdk';

// @CogniNode({ type: 'my-org/my-node', version: '1.0.0' })
export class MyNode /* extends BaseNode */ {
  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    // Your implementation here
    return {};
  }
}

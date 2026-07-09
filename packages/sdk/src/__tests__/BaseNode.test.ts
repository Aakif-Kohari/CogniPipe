import { z } from 'zod';
import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import { BaseNode } from '../BaseNode';

/** Minimal concrete subclass used to exercise BaseNode's abstract/lifecycle behaviour. */
class TestNode extends BaseNode {
  public calls: string[] = [];

  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    this.calls.push('execute');
    return { received: config };
  }

  async beforeExecute(_config: NodeConfig, _ctx: IExecutionContext): Promise<void> {
    this.calls.push('beforeExecute');
  }

  async afterExecute(_output: NodeOutput, _ctx: IExecutionContext): Promise<void> {
    this.calls.push('afterExecute');
  }

  /** Exposes the protected validateConfig() for direct testing. */
  public callValidateConfig<T>(schema: z.ZodType<T>, raw: unknown): T {
    return this.validateConfig(schema, raw);
  }
}

const mockCtx = {
  get: jest.fn(),
  set: jest.fn(),
  has: jest.fn(),
  interpolate: jest.fn((s: string) => s),
  toJSON: jest.fn(() => ({})),
} satisfies IExecutionContext;

describe('BaseNode', () => {
  describe('instantiation and identity', () => {
    it('instantiates a concrete subclass without errors', () => {
      expect(() => new TestNode()).not.toThrow();
    });

    it('reports TestNode.cogniNodeMeta as undefined on an undecorated subclass', () => {
      expect(TestNode.cogniNodeMeta).toBeUndefined();
    });

    it('is an instanceof BaseNode', () => {
      const node = new TestNode();
      expect(node instanceof BaseNode).toBe(true);
    });

    it('duck-types the IBaseNode execute contract ("execute" in node)', () => {
      const node = new TestNode();
      expect('execute' in node).toBe(true);
    });
  });

  describe('execute() and lifecycle hooks', () => {
    it('resolves execute() and returns the config wrapped in { received }', async () => {
      const node = new TestNode();
      const result = await node.execute({}, mockCtx);

      expect(result).toEqual({ received: {} });
      expect(node.calls).toContain('execute');
    });

    it('defines beforeExecute and afterExecute as callable functions', async () => {
      const node = new TestNode();

      expect(typeof node.beforeExecute).toBe('function');
      expect(typeof node.afterExecute).toBe('function');

      await node.beforeExecute?.({}, mockCtx);
      await node.afterExecute?.({ received: {} }, mockCtx);

      expect(node.calls).toEqual(['beforeExecute', 'afterExecute']);
    });
  });

  describe('validateConfig()', () => {
    it('returns the parsed value for a valid config', () => {
      const node = new TestNode();
      const Schema = z.object({ url: z.string() });

      const result = node.callValidateConfig(Schema, { url: 'https://example.com' });

      expect(result).toEqual({ url: 'https://example.com' });
    });

    it('applies Zod defaults for omitted fields', () => {
      const node = new TestNode();
      const Schema = z.object({ timeout: z.number().default(5000) });

      const result = node.callValidateConfig(Schema, {});

      expect(result).toEqual({ timeout: 5000 });
    });

    it('throws CogniPipeError(NODE_CONFIG_INVALID) with the field path in the message on a type mismatch', () => {
      const node = new TestNode();
      const Schema = z.object({ url: z.string() });
      let thrown: unknown;

      try {
        node.callValidateConfig(Schema, { url: 123 });
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      expect((thrown as CogniPipeError).message).toContain('url');
    });

    it('throws CogniPipeError(NODE_CONFIG_INVALID), not a raw ZodError, when raw is null', () => {
      const node = new TestNode();
      const Schema = z.object({ url: z.string() });
      let thrown: unknown;

      try {
        node.callValidateConfig(Schema, null);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
    });

    it('throws CogniPipeError(NODE_CONFIG_INVALID) when raw is undefined', () => {
      const node = new TestNode();
      const Schema = z.object({ url: z.string() });
      let thrown: unknown;

      try {
        node.callValidateConfig(Schema, undefined);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
    });
  });

  describe('cogniNodeMeta (decorator mechanism)', () => {
    // Kept last in the file: it mutates the shared static field on TestNode,
    // which would break the "undefined on an undecorated subclass" test above
    // if run afterward.
    it('persists a manually assigned CogniNodeMeta on the subclass', () => {
      TestNode.cogniNodeMeta = { type: 'test', version: '1.0.0' };

      expect(TestNode.cogniNodeMeta).toEqual({ type: 'test', version: '1.0.0' });
    });
  });
});

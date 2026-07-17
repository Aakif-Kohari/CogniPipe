import type { IBaseNode, IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import { NodeRegistry } from '../../engine/NodeRegistry';
import { CogniPipeError, isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

// Inline test double — do not export
class TestNode implements IBaseNode {
  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    return { result: 'test' };
  }
}

class ThrowingNode implements IBaseNode {
  constructor() {
    throw new Error('constructor failure');
  }

  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    return {};
  }
}

function expectRegistryError(
  fn: () => unknown,
  code: keyof typeof COGNIPIPE_ERROR_CODES,
): CogniPipeError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }

  expect(isCogniPipeError(thrown)).toBe(true);
  const err = thrown as CogniPipeError;
  expect(err.code).toBe(COGNIPIPE_ERROR_CODES[code]);
  return err;
}

describe('NodeRegistry', () => {
  describe('has / register', () => {
    it('starts empty — has() returns false for any type', () => {
      const registry = new NodeRegistry();
      expect(registry.has('x')).toBe(false);
    });

    it('register() makes has() return true for that type', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-http', TestNode);
      expect(registry.has('@cognipipe/node-http')).toBe(true);
    });

    it('registering the same type twice overwrites silently, no error', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-http', TestNode);
      expect(() => registry.register('@cognipipe/node-http', TestNode)).not.toThrow();
    });

    it('throws NODE_INSTANTIATION_FAILED with "empty" in the message for an empty type', () => {
      const registry = new NodeRegistry();
      const err = expectRegistryError(
        () => registry.register('', TestNode),
        'NODE_INSTANTIATION_FAILED',
      );
      expect(err.message).toContain('empty');
    });

    it('throws NODE_INSTANTIATION_FAILED for a whitespace-only type', () => {
      const registry = new NodeRegistry();
      expectRegistryError(() => registry.register('   ', TestNode), 'NODE_INSTANTIATION_FAILED');
    });
  });

  describe('get', () => {
    it('returns the registered constructor reference', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-http', TestNode);
      expect(registry.get('@cognipipe/node-http')).toBe(TestNode);
    });

    it('throws NODE_NOT_REGISTERED with the type name and registered types listed', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-slack', TestNode);

      const err = expectRegistryError(() => registry.get('unregistered'), 'NODE_NOT_REGISTERED');
      expect(err.message).toContain('unregistered');
      expect(err.message).toContain('@cognipipe/node-slack');
    });
  });

  describe('instantiate', () => {
    it('returns a TestNode instance, not the class itself', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-http', TestNode);
      const instance = registry.instantiate('@cognipipe/node-http');
      expect(instance).toBeInstanceOf(TestNode);
    });

    it('returns a new instance on every call', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-http', TestNode);
      const a = registry.instantiate('@cognipipe/node-http');
      const b = registry.instantiate('@cognipipe/node-http');
      expect(a).not.toBe(b);
    });

    it('throws NODE_NOT_REGISTERED for an unregistered type (checked before instantiation)', () => {
      const registry = new NodeRegistry();
      expectRegistryError(() => registry.instantiate('unregistered'), 'NODE_NOT_REGISTERED');
    });

    it('wraps a constructor throw in NODE_INSTANTIATION_FAILED with .cause set', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-throw', ThrowingNode);

      const err = expectRegistryError(
        () => registry.instantiate('@cognipipe/node-throw'),
        'NODE_INSTANTIATION_FAILED',
      );
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as Error).message).toBe('constructor failure');
    });
  });

  describe('listTypes', () => {
    it('returns registered types after one registration', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-http', TestNode);
      expect(registry.listTypes()).toEqual(['@cognipipe/node-http']);
    });

    it('returns a frozen array', () => {
      const registry = new NodeRegistry();
      registry.register('@cognipipe/node-http', TestNode);
      expect(Object.isFrozen(registry.listTypes())).toBe(true);
    });
  });

  describe('isCogniPipeError', () => {
    it('is true for every error thrown by NodeRegistry', () => {
      const registry = new NodeRegistry();

      let thrown: unknown;
      try {
        registry.register('', TestNode);
      } catch (err) {
        thrown = err;
      }
      expect(isCogniPipeError(thrown)).toBe(true);
    });
  });
});

import { CogniPipeError, COGNIPIPE_ERROR_CODES, isCogniPipeError } from '@cognipipe/core';
import { BaseNode } from '../../BaseNode';
import { CogniNode } from '../../decorators/CogniNode';

describe('CogniNode', () => {
  describe('metadata attachment', () => {
    it('sets type and version on the decorated class', () => {
      @CogniNode({ type: '@cognipipe/node-http', version: '1.0.0' })
      class HttpNode extends BaseNode {
        async execute() {
          return {};
        }
      }

      expect(HttpNode.cogniNodeMeta?.type).toBe('@cognipipe/node-http');
      expect(HttpNode.cogniNodeMeta?.version).toBe('1.0.0');
    });

    it('gives each decorated class its own independent metadata', () => {
      @CogniNode({ type: '@cognipipe/node-a', version: '1.0.0' })
      class NodeA extends BaseNode {
        async execute() {
          return {};
        }
      }

      @CogniNode({ type: '@cognipipe/node-b', version: '2.0.0' })
      class NodeB extends BaseNode {
        async execute() {
          return {};
        }
      }

      expect(NodeA.cogniNodeMeta).toEqual({ type: '@cognipipe/node-a', version: '1.0.0' });
      expect(NodeB.cogniNodeMeta).toEqual({ type: '@cognipipe/node-b', version: '2.0.0' });
    });

    it('leaves cogniNodeMeta undefined on an undecorated BaseNode subclass', () => {
      class UndecoratedNode extends BaseNode {
        async execute() {
          return {};
        }
      }

      expect(UndecoratedNode.cogniNodeMeta).toBeUndefined();
    });

    it('keeps the decorated class an instanceof BaseNode', () => {
      @CogniNode({ type: '@cognipipe/node-http', version: '1.0.0' })
      class HttpNode extends BaseNode {
        async execute() {
          return {};
        }
      }

      expect(new HttpNode() instanceof BaseNode).toBe(true);
    });
  });

  describe('version format — valid values', () => {
    it.each(['1.0.0', '0.0.1', '12.34.56'])('accepts version "%s"', version => {
      expect(() => {
        @CogniNode({ type: '@cognipipe/node-test', version })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      }).not.toThrow();
    });
  });

  describe('validation failures — throw at decoration time', () => {
    it('throws when type is empty', () => {
      expect(() => {
        @CogniNode({ type: '', version: '1.0.0' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      }).toThrow(CogniPipeError);
    });

    it('includes "type" in the message when type is empty', () => {
      let thrown: unknown;
      try {
        @CogniNode({ type: '', version: '1.0.0' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      } catch (err) {
        thrown = err;
      }

      expect((thrown as CogniPipeError).message).toContain('type');
    });

    it('throws when type is whitespace-only', () => {
      expect(() => {
        @CogniNode({ type: '   ', version: '1.0.0' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      }).toThrow(CogniPipeError);
    });

    it('includes "version" and "1.0" in the message for a two-part version', () => {
      let thrown: unknown;
      try {
        @CogniNode({ type: '@cognipipe/node-test', version: '1.0' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      } catch (err) {
        thrown = err;
      }

      expect((thrown as CogniPipeError).message).toContain('version');
      expect((thrown as CogniPipeError).message).toContain('1.0');
    });

    it('includes "v1.0.0" in the message for a v-prefixed version', () => {
      let thrown: unknown;
      try {
        @CogniNode({ type: '@cognipipe/node-test', version: 'v1.0.0' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      } catch (err) {
        thrown = err;
      }

      expect((thrown as CogniPipeError).message).toContain('v1.0.0');
    });

    it('includes "1.0.0-alpha" in the message for a pre-release tag', () => {
      let thrown: unknown;
      try {
        @CogniNode({ type: '@cognipipe/node-test', version: '1.0.0-alpha' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      } catch (err) {
        thrown = err;
      }

      expect((thrown as CogniPipeError).message).toContain('1.0.0-alpha');
    });

    it('throws when version is empty', () => {
      expect(() => {
        @CogniNode({ type: '@cognipipe/node-test', version: '' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      }).toThrow(CogniPipeError);
    });
  });

  describe('error structure', () => {
    it('throws an error that passes isCogniPipeError()', () => {
      let thrown: unknown;
      try {
        @CogniNode({ type: '', version: '1.0.0' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
    });

    it('sets code to NODE_INSTANTIATION_FAILED', () => {
      let thrown: unknown;
      try {
        @CogniNode({ type: '@cognipipe/node-test', version: 'not-semver' })
        class TestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void TestNode;
      } catch (err) {
        thrown = err;
      }

      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_INSTANTIATION_FAILED);
    });

    it('includes className in context', () => {
      let thrown: unknown;
      try {
        @CogniNode({ type: '', version: '1.0.0' })
        class NamedTestNode extends BaseNode {
          async execute() {
            return {};
          }
        }
        void NamedTestNode;
      } catch (err) {
        thrown = err;
      }

      expect((thrown as CogniPipeError).context).toMatchObject({ className: 'NamedTestNode' });
    });
  });

  describe('type-level guarantee', () => {
    it('only allows @CogniNode() to decorate BaseNode subclasses (compile-time check)', () => {
      // @ts-expect-error — PlainClass does not extend BaseNode, so this must fail to compile.
      // If CogniNode's generic constraint (`T extends typeof BaseNode`) is ever loosened,
      // this @ts-expect-error becomes unused and tsc/ts-jest will fail the build.
      @CogniNode({ type: '@cognipipe/node-test', version: '1.0.0' })
      class PlainClass {}

      expect(PlainClass).toBeDefined();
    });
  });
});

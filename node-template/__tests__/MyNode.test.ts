import { isCogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import type { IExecutionContext } from '@cognipipe/types';
import { MyNode } from '../src/MyNode.js';

const ctx = {
  get: jest.fn(),
  set: jest.fn(),
  has: jest.fn(),
  interpolate: jest.fn((s: string) => s),
  toJSON: jest.fn(() => ({})),
} satisfies IExecutionContext;

describe('MyNode', () => {
  it('echoes the configured message', async () => {
    await expect(new MyNode().execute({ message: 'hi' }, ctx)).resolves.toEqual({ echoed: 'hi' });
  });

  it('rejects an empty message with NODE_CONFIG_INVALID', async () => {
    expect.assertions(2);
    try {
      await new MyNode().execute({ message: '' }, ctx);
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as { code: string }).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
    }
  });
});

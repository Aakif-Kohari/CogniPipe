import { ClaudeNode } from '../src/index';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import type { IExecutionContext, NodeConfig } from '@cognipipe/types';

const ORIGINAL_ENV = process.env;
const mockCtx = {} as IExecutionContext;

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
  const { ok = true, status = 200 } = init;
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

const baseConfig = {
  model: 'claude-3-5-sonnet-20241022',
  prompt: 'Summarize this text',
} as NodeConfig;

const anthropicSuccessBody = {
  content: [{ type: 'text', text: 'Hello from Anthropic' }],
  model: 'claude-3-5-sonnet-20241022',
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('ClaudeNode', () => {
  let node: ClaudeNode;

  beforeEach(() => {
    node = new ClaudeNode();
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'test-key-123' };
    jest.resetAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns AiNodeOutput with content and fully populated aiMeta on success', async () => {
    mockFetchOnce(anthropicSuccessBody);

    const result = await node.execute(baseConfig, mockCtx);

    expect(result.content).toBe('Hello from Anthropic');
    expect(result.aiMeta).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelUsed: 'claude-3-5-sonnet-20241022',
      providerUrlUsed: 'https://api.anthropic.com/v1',
      retryCount: 0,
      fallbackUsed: false,
      completionReason: 'success',
    });
    expect(typeof result.aiMeta.latencyMs).toBe('number');
  });

  it('computes totalTokens === inputTokens + outputTokens (never reads a total_tokens field, which does not exist on the Anthropic response)', async () => {
    mockFetchOnce(anthropicSuccessBody);

    const result = await node.execute(baseConfig, mockCtx);

    expect(result.aiMeta.totalTokens).toBe(result.aiMeta.inputTokens + result.aiMeta.outputTokens);
  });

  it('calls fetch with x-api-key header, not Authorization: Bearer', async () => {
    mockFetchOnce(anthropicSuccessBody);

    await node.execute(baseConfig, mockCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-key-123',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    const callArgs = (global.fetch as jest.Mock).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(callArgs.headers.Authorization).toBeUndefined();
  });

  it('includes anthropic-version: 2023-06-01 header on every request', async () => {
    mockFetchOnce(anthropicSuccessBody);

    await node.execute(baseConfig, mockCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
      }),
    );
  });

  it('includes max_tokens in the request body, defaulting to 1024 when omitted from config', async () => {
    mockFetchOnce(anthropicSuccessBody);

    await node.execute(baseConfig, mockCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        body: expect.stringContaining('"max_tokens":1024'),
      }),
    );
  });

  it('forwards an explicit maxTokens instead of the default', async () => {
    mockFetchOnce(anthropicSuccessBody);

    await node.execute({ ...baseConfig, maxTokens: 2048 } as NodeConfig, mockCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        body: expect.stringContaining('"max_tokens":2048'),
      }),
    );
  });

  it('overrides the default Anthropic endpoint with a custom baseUrl', async () => {
    mockFetchOnce(anthropicSuccessBody);

    await node.execute(
      { ...baseConfig, baseUrl: 'https://gateway.example.com/v1' } as NodeConfig,
      mockCtx,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/messages',
      expect.anything(),
    );
  });

  it("throws CogniPipeError(NODE_CONFIG_INVALID) when temperature > 1 (Anthropic range is 0-1, not OpenAI's 0-2)", async () => {
    await expect(
      node.execute({ ...baseConfig, temperature: 1.5 } as NodeConfig, mockCtx),
    ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('accepts temperature at the upper bound of 1', async () => {
    mockFetchOnce(anthropicSuccessBody);

    await expect(
      node.execute({ ...baseConfig, temperature: 1 } as NodeConfig, mockCtx),
    ).resolves.toBeDefined();
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) when apiKeyEnv points to an unset variable', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) for an invalid model', async () => {
    await expect(
      node.execute({ ...baseConfig, model: 'claude-4-opus' } as unknown as NodeConfig, mockCtx),
    ).rejects.toBeInstanceOf(CogniPipeError);
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) for an empty prompt', async () => {
    await expect(
      node.execute({ ...baseConfig, prompt: '' } as NodeConfig, mockCtx),
    ).rejects.toBeInstanceOf(CogniPipeError);
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) when streaming is requested', async () => {
    await expect(
      node.execute({ ...baseConfig, streaming: true } as NodeConfig, mockCtx),
    ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) when baseUrl is not https', async () => {
    await expect(
      node.execute({ ...baseConfig, baseUrl: 'http://insecure.local/v1' } as NodeConfig, mockCtx),
    ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) with status code when Anthropic returns non-2xx', async () => {
    mockFetchOnce({ error: 'rate limited' }, { ok: false, status: 429 });

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
      message: expect.stringContaining('429'),
    });
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) on network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
    });
  });

  it('exposes cogniNodeMeta.type as @cognipipe/node-anthropic', () => {
    expect(
      (ClaudeNode as unknown as { cogniNodeMeta?: { type: string } }).cogniNodeMeta?.type,
    ).toBe('@cognipipe/node-anthropic');
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) when the response body is malformed', async () => {
    mockFetchOnce({ content: [] }); // missing usage

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
    });
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) when the response body is not valid JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
      text: async () => '',
    } as unknown as Response);

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
    });
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) when the request times out', async () => {
    jest.useFakeTimers();

    global.fetch = jest.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    });

    const executePromise = node.execute(baseConfig, mockCtx);

    jest.advanceTimersByTime(30_000);

    await expect(executePromise).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
      message: expect.stringContaining('timed out'),
    });

    jest.useRealTimers();
  });

  it('throws a timeout error when the response body read is aborted', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      text: async () => '',
    } as unknown as Response);

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
      message: expect.stringContaining('timed out'),
    });
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) with a stringified message on a non-Error fetch rejection', async () => {
    global.fetch = jest.fn().mockRejectedValue('raw string failure');

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
      message: expect.stringContaining('raw string failure'),
    });
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) with a stringified message when response.json() rejects with a non-Error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw 'raw json failure';
      },
      text: async () => '',
    } as unknown as Response);

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
      message: expect.stringContaining('raw json failure'),
    });
  });
});

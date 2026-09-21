import { EmbeddingNode } from '../src/EmbeddingNode.js';
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
  model: 'text-embedding-3-small',
  input: 'Text to embed',
} as NodeConfig;

const openAiSuccessBody = {
  data: [{ embedding: [0.1, -0.2, 0.3] }],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 7, total_tokens: 7 },
};

describe('EmbeddingNode', () => {
  let node: EmbeddingNode;

  beforeEach(() => {
    node = new EmbeddingNode();
    process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: 'test-key-123' };
    jest.resetAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns embedding output with content undefined and fully populated aiMeta on success', async () => {
    mockFetchOnce(openAiSuccessBody);

    const result = await node.execute(baseConfig, mockCtx);

    expect(result).toHaveProperty('content', undefined);
    expect(result.embedding).toEqual([0.1, -0.2, 0.3]);
    expect(result.aiMeta).toMatchObject({
      inputTokens: 7,
      outputTokens: 0,
      totalTokens: 7,
      modelUsed: 'text-embedding-3-small',
      providerUrlUsed: 'https://api.openai.com/v1',
      retryCount: 0,
      fallbackUsed: false,
      completionReason: 'success',
    });
    expect(typeof result.aiMeta.latencyMs).toBe('number');
  });

  it('satisfies totalTokens === inputTokens when outputTokens is always zero', async () => {
    mockFetchOnce(openAiSuccessBody);

    const result = await node.execute(baseConfig, mockCtx);

    expect(result.aiMeta.outputTokens).toBe(0);
    expect(result.aiMeta.totalTokens).toBe(result.aiMeta.inputTokens);
  });

  it('calls the embeddings endpoint with Authorization from env and model/input body', async () => {
    mockFetchOnce(openAiSuccessBody);

    await node.execute(baseConfig, mockCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key-123' }),
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'Text to embed',
        }),
      }),
    );
  });

  it('overrides the default OpenAI endpoint with a custom baseUrl', async () => {
    mockFetchOnce(openAiSuccessBody);

    await node.execute(
      { ...baseConfig, baseUrl: 'https://gateway.example.com/v1' } as NodeConfig,
      mockCtx,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/embeddings',
      expect.anything(),
    );
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) for an invalid model', async () => {
    await expect(
      node.execute(
        { ...baseConfig, model: 'text-embedding-ada-002' } as unknown as NodeConfig,
        mockCtx,
      ),
    ).rejects.toBeInstanceOf(CogniPipeError);
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) for empty input', async () => {
    await expect(
      node.execute({ ...baseConfig, input: '' } as NodeConfig, mockCtx),
    ).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) when apiKeyEnv points to an unset variable', async () => {
    delete process.env.OPENAI_API_KEY;

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) when baseUrl is not https', async () => {
    await expect(
      node.execute({ ...baseConfig, baseUrl: 'http://insecure.local/v1' } as NodeConfig, mockCtx),
    ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) with status code when OpenAI returns non-2xx', async () => {
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
      message: expect.stringContaining('ECONNREFUSED'),
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
      message: expect.stringContaining('could not be parsed as JSON'),
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

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) when the response body is malformed', async () => {
    mockFetchOnce({
      data: [],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
    });
  });

  it('exposes cogniNodeMeta.type as @cognipipe/node-openai-embedding', () => {
    expect(
      (EmbeddingNode as unknown as { cogniNodeMeta?: { type: string } }).cogniNodeMeta?.type,
    ).toBe('@cognipipe/node-openai-embedding');
  });
});

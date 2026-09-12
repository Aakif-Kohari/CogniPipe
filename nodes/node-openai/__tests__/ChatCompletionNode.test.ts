import { ChatCompletionNode } from '../src/ChatCompletionNode.js';
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
  model: 'gpt-4o',
  prompt: 'Summarize this text',
} as NodeConfig;

const openAiSuccessBody = {
  choices: [{ message: { content: 'Hello from OpenAI' } }],
  model: 'gpt-4o-2024-11-20',
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe('ChatCompletionNode', () => {
  let node: ChatCompletionNode;

  beforeEach(() => {
    node = new ChatCompletionNode();
    process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: 'test-key-123' };
    jest.resetAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns AiNodeOutput with content and fully populated aiMeta on success', async () => {
    mockFetchOnce(openAiSuccessBody);

    const result = await node.execute(baseConfig, mockCtx);

    expect(result.content).toBe('Hello from OpenAI');
    expect(result.aiMeta).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelUsed: 'gpt-4o-2024-11-20',
      providerUrlUsed: 'https://api.openai.com/v1',
      retryCount: 0,
      fallbackUsed: false,
      completionReason: 'success',
    });
    expect(typeof result.aiMeta.latencyMs).toBe('number');
  });

  it('satisfies totalTokens === inputTokens + outputTokens', async () => {
    mockFetchOnce(openAiSuccessBody);

    const result = await node.execute(baseConfig, mockCtx);

    expect(result.aiMeta.totalTokens).toBe(result.aiMeta.inputTokens + result.aiMeta.outputTokens);
  });

  it('calls fetch with Authorization: Bearer <key from env>, never the raw config value', async () => {
    mockFetchOnce(openAiSuccessBody);

    await node.execute(baseConfig, mockCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key-123' }),
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
      'https://gateway.example.com/v1/chat/completions',
      expect.anything(),
    );
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) when apiKeyEnv points to an unset variable', async () => {
    delete process.env.OPENAI_API_KEY;

    await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
      code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) for an invalid model', async () => {
    await expect(
      node.execute({ ...baseConfig, model: 'gpt-5-turbo' } as unknown as NodeConfig, mockCtx),
    ).rejects.toBeInstanceOf(CogniPipeError);
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) for an empty prompt', async () => {
    await expect(
      node.execute({ ...baseConfig, prompt: '' } as NodeConfig, mockCtx),
    ).rejects.toBeInstanceOf(CogniPipeError);
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
    });
  });

  it('exposes cogniNodeMeta.type as @cognipipe/node-openai', () => {
    expect(
      (ChatCompletionNode as unknown as { cogniNodeMeta?: { type: string } }).cogniNodeMeta?.type,
    ).toBe('@cognipipe/node-openai');
  });

  it('throws CogniPipeError(NODE_CONFIG_INVALID) when streaming is requested', async () => {
    await expect(
      node.execute({ ...baseConfig, streaming: true } as NodeConfig, mockCtx),
    ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws CogniPipeError(STEP_EXECUTION_FAILED) when the response body is malformed', async () => {
    mockFetchOnce({ choices: [] }); // missing message content + usage

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
});

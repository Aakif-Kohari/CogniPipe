/**
 * @module SlackMessageNode.test
 *
 * Unit tests for SlackMessageNode. Every Slack call is mocked through
 * `global.fetch` — no test touches the network.
 */

import { SlackMessageNode } from '../src/index';
import { CogniPipeError, isCogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import type { IExecutionContext, NodeConfig } from '@cognipipe/types';

const ORIGINAL_ENV = process.env;
const ORIGINAL_FETCH = global.fetch;
const mockCtx = {} as IExecutionContext;

const TOKEN = 'xoxb-test-token-123';
const DEFAULT_URL = 'https://slack.com/api/chat.postMessage';

const baseConfig = { channel: '#general', text: 'Hello world' } as NodeConfig;
const slackSuccessBody = { ok: true, channel: 'C0123ABCD', ts: '1712345678.000100' };

/** Replaces global.fetch with a mock that resolves to a real Response. */
function mockFetchOnce(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): void {
  const { status = 200, headers = {} } = init;
  global.fetch = jest
    .fn()
    .mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
    );
}

/** The url, headers and raw body string of the first fetch call. */
function sentRequest(): { url: string; headers: Record<string, string>; body: string } {
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
    string,
    { headers: Record<string, string>; body: string },
  ];
  return { url, headers: init.headers, body: init.body };
}

describe('SlackMessageNode', () => {
  let node: SlackMessageNode;

  beforeEach(() => {
    node = new SlackMessageNode();
    process.env = { ...ORIGINAL_ENV, SLACK_BOT_TOKEN: TOKEN };
    jest.resetAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = ORIGINAL_FETCH;
  });

  describe('successful posts', () => {
    it('posts text and returns { ok: true, channel, ts } from the Slack response', async () => {
      mockFetchOnce(slackSuccessBody);

      const result = await node.execute(baseConfig, mockCtx);

      expect(result).toEqual({ ok: true, channel: 'C0123ABCD', ts: '1712345678.000100' });
      expect(JSON.parse(sentRequest().body)).toEqual({ channel: '#general', text: 'Hello world' });
    });

    it('posts blocks only (no text) and forwards them unchanged, including unknown keys', async () => {
      mockFetchOnce(slackSuccessBody);
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'Deploy', emoji: true } },
        { type: 'section', block_id: 'b1', text: { type: 'mrkdwn', text: '*done*' } },
        { type: 'divider' },
      ];

      await node.execute({ channel: '#general', blocks } as NodeConfig, mockCtx);

      const body = JSON.parse(sentRequest().body) as Record<string, unknown>;
      expect(body).toEqual({ channel: '#general', blocks });
      expect(body).not.toHaveProperty('text');
    });

    it('posts text and blocks together (text is the notification fallback)', async () => {
      mockFetchOnce(slackSuccessBody);
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Details' } }];

      await node.execute({ channel: '#general', text: 'fallback', blocks } as NodeConfig, mockCtx);

      expect(JSON.parse(sentRequest().body)).toEqual({
        channel: '#general',
        text: 'fallback',
        blocks,
      });
    });

    it("accepts exactly 50 blocks (Slack's limit)", async () => {
      mockFetchOnce(slackSuccessBody);
      const blocks = Array.from({ length: 50 }, () => ({ type: 'divider' }));

      await expect(
        node.execute({ channel: '#general', blocks } as NodeConfig, mockCtx),
      ).resolves.toBeDefined();
    });

    it.each([true, false])('forwards unfurlLinks: %s as unfurl_links', async unfurlLinks => {
      mockFetchOnce(slackSuccessBody);

      await node.execute({ ...baseConfig, unfurlLinks } as NodeConfig, mockCtx);

      expect(JSON.parse(sentRequest().body)).toMatchObject({ unfurl_links: unfurlLinks });
    });

    it('omits keys that are not configured from the request body', async () => {
      mockFetchOnce(slackSuccessBody);

      await node.execute(baseConfig, mockCtx);

      const raw = sentRequest().body;
      expect(raw).not.toContain('blocks');
      expect(raw).not.toContain('unfurl_links');
    });

    it('sends a POST to the default URL with Authorization: Bearer <token from env>', async () => {
      mockFetchOnce(slackSuccessBody);

      await node.execute(baseConfig, mockCtx);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        DEFAULT_URL,
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
        }),
      );
    });

    it('honors a baseUrl override', async () => {
      mockFetchOnce(slackSuccessBody);

      await node.execute(
        { ...baseConfig, baseUrl: 'https://gateway.example.com/slack-api' } as NodeConfig,
        mockCtx,
      );

      expect(sentRequest().url).toBe('https://gateway.example.com/slack-api/chat.postMessage');
    });

    it('does not double the slash when baseUrl ends with "/"', async () => {
      mockFetchOnce(slackSuccessBody);

      await node.execute(
        { ...baseConfig, baseUrl: 'https://gateway.example.com/api/' } as NodeConfig,
        mockCtx,
      );

      expect(sentRequest().url).toBe('https://gateway.example.com/api/chat.postMessage');
    });

    it('treats an omitted action as postMessage', async () => {
      mockFetchOnce(slackSuccessBody);

      await expect(node.execute(baseConfig, mockCtx)).resolves.toEqual(slackSuccessBody);
    });

    it('accepts an explicit action: "postMessage"', async () => {
      mockFetchOnce(slackSuccessBody);

      await expect(
        node.execute({ ...baseConfig, action: 'postMessage' } as NodeConfig, mockCtx),
      ).resolves.toEqual(slackSuccessBody);
    });

    it('reads the token from a custom tokenEnv', async () => {
      process.env.MY_SLACK_TOKEN = 'xoxb-custom-token';
      mockFetchOnce(slackSuccessBody);

      await node.execute({ ...baseConfig, tokenEnv: 'MY_SLACK_TOKEN' } as NodeConfig, mockCtx);

      expect(sentRequest().headers.Authorization).toBe('Bearer xoxb-custom-token');
    });

    it('exposes cogniNodeMeta.type as @cognipipe/node-slack', () => {
      expect(
        (SlackMessageNode as unknown as { cogniNodeMeta?: { type: string } }).cogniNodeMeta?.type,
      ).toBe('@cognipipe/node-slack');
    });
  });

  describe('config validation (NODE_CONFIG_INVALID, fetch never called)', () => {
    it('throws when the token env var is missing, naming the variable but not any value', async () => {
      expect.assertions(5);
      delete process.env.SLACK_BOT_TOKEN;

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
        expect((err as CogniPipeError).message).toContain('SLACK_BOT_TOKEN');
        expect((err as CogniPipeError).message).not.toContain(TOKEN);
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws when the token env var is set but empty', async () => {
      expect.assertions(3);
      process.env.SLACK_BOT_TOKEN = '';

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('names the custom tokenEnv (not SLACK_BOT_TOKEN) when that variable is missing', async () => {
      expect.assertions(3);

      try {
        await node.execute(
          { ...baseConfig, tokenEnv: 'MISSING_SLACK_TOKEN' } as NodeConfig,
          mockCtx,
        );
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('MISSING_SLACK_TOKEN');
        expect((err as CogniPipeError).message).not.toContain('SLACK_BOT_TOKEN"');
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws when neither text nor blocks is provided', async () => {
      expect.assertions(3);

      try {
        await node.execute({ channel: '#general' } as NodeConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
        expect((err as CogniPipeError).message).toContain('text');
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['empty channel', { channel: '', text: 'hi' }],
      ['missing channel', { text: 'hi' }],
      ['empty text', { channel: '#general', text: '' }],
      ['empty blocks array', { channel: '#general', blocks: [] }],
      [
        'blocks with 51 items',
        { channel: '#general', blocks: Array.from({ length: 51 }, () => ({ type: 'divider' })) },
      ],
      ['a block without a type', { channel: '#general', blocks: [{ text: 'no type' }] }],
      ['a block whose type is not a string', { channel: '#general', blocks: [{ type: 42 }] }],
      ['an empty tokenEnv', { ...baseConfig, tokenEnv: '' }],
      ['a non-boolean unfurlLinks', { ...baseConfig, unfurlLinks: 'yes' }],
      ['a baseUrl that is not a URL', { ...baseConfig, baseUrl: 'not a url' }],
    ])('throws NODE_CONFIG_INVALID for %s', async (_name, config) => {
      await expect(node.execute(config as NodeConfig, mockCtx)).rejects.toMatchObject({
        code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws NODE_CONFIG_INVALID mentioning "action" for an unknown action', async () => {
      expect.assertions(4);

      try {
        await node.execute({ ...baseConfig, action: 'deleteMessage' } as NodeConfig, mockCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
        expect((err as CogniPipeError).message).toContain('action');
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each([null, 'postMessage', ['postMessage']])(
      'throws NODE_CONFIG_INVALID when the config is not an object (%p)',
      async config => {
        await expect(node.execute(config as unknown as NodeConfig, mockCtx)).rejects.toMatchObject({
          code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID,
        });
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it('throws NODE_CONFIG_INVALID for a non-https baseUrl', async () => {
      await expect(
        node.execute(
          { ...baseConfig, baseUrl: 'http://insecure.local/api' } as NodeConfig,
          mockCtx,
        ),
      ).rejects.toMatchObject({ code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Slack API errors', () => {
    it('turns HTTP 200 with { ok: false, error: "channel_not_found" } into STEP_EXECUTION_FAILED with a hint', async () => {
      expect.assertions(4);
      mockFetchOnce({ ok: false, error: 'channel_not_found' });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        expect((err as CogniPipeError).message).toContain('channel_not_found');
        expect((err as CogniPipeError).message).toContain('Hint:');
      }
    });

    it.each([
      ['invalid_auth', 'SLACK_BOT_TOKEN'],
      ['not_in_channel', '/invite'],
      ['is_archived', 'archived'],
      ['invalid_blocks', 'Block Kit'],
      ['missing_scope', 'chat:write'],
    ])('adds an actionable hint for "%s"', async (slackError, hintText) => {
      expect.assertions(2);
      mockFetchOnce({ ok: false, error: slackError });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain(slackError);
        expect((err as CogniPipeError).message).toContain(hintText);
      }
    });

    it('names the configured tokenEnv in the invalid_auth hint', async () => {
      expect.assertions(1);
      process.env.MY_SLACK_TOKEN = 'xoxb-custom-token';
      mockFetchOnce({ ok: false, error: 'invalid_auth' });

      try {
        await node.execute({ ...baseConfig, tokenEnv: 'MY_SLACK_TOKEN' } as NodeConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('"MY_SLACK_TOKEN"');
      }
    });

    it('includes the "needed" scope from a missing_scope response', async () => {
      expect.assertions(3);
      mockFetchOnce({ ok: false, error: 'missing_scope', needed: 'chat:write.public' });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('missing_scope');
        expect((err as CogniPipeError).message).toContain('chat:write.public');
        expect((err as CogniPipeError).context).toMatchObject({ needed: 'chat:write.public' });
      }
    });

    it('reports an unknown Slack error code without inventing a hint', async () => {
      expect.assertions(2);
      mockFetchOnce({ ok: false, error: 'msg_too_long' });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('msg_too_long');
        expect((err as CogniPipeError).message).not.toContain('Hint:');
      }
    });

    it('falls back to "unknown_error" when ok is false and no error string is present', async () => {
      expect.assertions(1);
      mockFetchOnce({ ok: false });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('unknown_error');
      }
    });

    it('surfaces HTTP 429 with the Retry-After value and does not retry', async () => {
      expect.assertions(5);
      mockFetchOnce(
        { ok: false, error: 'ratelimited' },
        { status: 429, headers: { 'Retry-After': '30' } },
      );

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        expect((err as CogniPipeError).message).toContain('429');
        expect((err as CogniPipeError).message).toContain('30');
      }
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces HTTP 429 without a Retry-After header', async () => {
      expect.assertions(3);
      mockFetchOnce({ ok: false, error: 'ratelimited' }, { status: 429 });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        expect((err as CogniPipeError).message).toContain('429');
      }
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws STEP_EXECUTION_FAILED with the status for other non-2xx responses', async () => {
      mockFetchOnce('Bad Gateway', { status: 502 });

      await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        message: expect.stringContaining('502'),
      });
    });
  });

  describe('transport and response-shape failures (STEP_EXECUTION_FAILED)', () => {
    it('wraps a network failure and keeps the original error as .cause', async () => {
      expect.assertions(3);
      const networkError = new Error('ECONNREFUSED');
      global.fetch = jest.fn().mockRejectedValue(networkError);

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        expect((err as CogniPipeError).message).toContain('ECONNREFUSED');
        expect((err as CogniPipeError).cause).toBe(networkError);
      }
    });

    it('wraps a non-Error rejection', async () => {
      global.fetch = jest.fn().mockRejectedValue('boom');

      await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        message: expect.stringContaining('boom'),
      });
    });

    it('wraps a failure while reading the response body', async () => {
      expect.assertions(2);
      const readError = new Error('socket hang up');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => {
          throw readError;
        },
      } as unknown as Response);

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        expect((err as CogniPipeError).cause).toBe(readError);
      }
    });

    it('times out after 30 000 ms (fake timers + AbortError)', async () => {
      expect.assertions(3);
      jest.useFakeTimers();
      global.fetch = jest.fn().mockImplementation((_url, init: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });

      const executePromise = node.execute(baseConfig, mockCtx);
      jest.advanceTimersByTime(30_000);

      try {
        await executePromise;
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        expect((err as CogniPipeError).message).toContain('timed out');
      }
    });

    it('keeps the original abort error as .cause on timeout', async () => {
      expect.assertions(2);
      jest.useFakeTimers();
      // A plain Error named AbortError: Jest runs tests in a separate VM realm, where a
      // DOMException is not `instanceof Error` — in real Node it is.
      const abortError = Object.assign(new Error('The operation was aborted.'), {
        name: 'AbortError',
      });
      global.fetch = jest.fn().mockImplementation((_url, init: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError));
        });
      });

      const executePromise = node.execute(baseConfig, mockCtx);
      jest.advanceTimersByTime(30_000);

      try {
        await executePromise;
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('timed out');
        expect((err as CogniPipeError).cause).toBe(abortError);
      }
    });

    it('does not time out before the deadline', async () => {
      jest.useFakeTimers();
      mockFetchOnce(slackSuccessBody);

      const executePromise = node.execute(baseConfig, mockCtx);
      jest.advanceTimersByTime(29_000);

      await expect(executePromise).resolves.toEqual(slackSuccessBody);
    });

    it('throws when a 200 body is not JSON', async () => {
      expect.assertions(3);
      mockFetchOnce('<html>proxy error</html>');

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
        expect((err as CogniPipeError).message).toContain('proxy error');
        expect((err as CogniPipeError).cause).toBeInstanceOf(SyntaxError);
      }
    });

    it.each([
      ['an array', '[]'],
      ['null', 'null'],
      ['a string', '"ok"'],
    ])('throws when the JSON body is %s instead of an object', async (_name, body) => {
      mockFetchOnce(body);

      await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        message: expect.stringContaining('unexpected response'),
      });
    });

    it.each([
      ['ts is missing', { ok: true, channel: 'C0123ABCD' }],
      ['channel is missing', { ok: true, ts: '1712345678.000100' }],
      ['ts is not a string', { ok: true, channel: 'C0123ABCD', ts: 1712345678.0001 }],
      ['channel is not a string', { ok: true, channel: 42, ts: '1712345678.000100' }],
    ])('throws an "incomplete response" error when %s', async (_name, body) => {
      mockFetchOnce(body);

      await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        message: expect.stringContaining('incomplete response'),
      });
    });

    it('treats a DOMException AbortError as a timeout even if signal.aborted is false', async () => {
      // Creates an AbortError without advancing timers, so signal.aborted remains false.
      // This forces evaluation of the right side of the || in toRequestError (Line 156).
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      global.fetch = jest.fn().mockRejectedValue(abortError);

      await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        message: expect.stringContaining('timed out'),
      });
    });

    it('handles non-Error thrown by JSON.parse', async () => {
      // Mocking JSON.parse to throw a string instead of a SyntaxError
      // covers the `undefined` branch of `err instanceof Error` in the catch block (Line 253).
      const originalParse = JSON.parse;
      global.JSON.parse = (() => {
        throw 'non-error string';
      }) as unknown as typeof JSON.parse;

      try {
        mockFetchOnce('not json');
        await expect(node.execute(baseConfig, mockCtx)).rejects.toMatchObject({
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          message: expect.stringContaining('could not be parsed as JSON'),
        });
      } finally {
        global.JSON.parse = originalParse;
      }
    });
  });

  describe('error-message safety', () => {
    it('truncates a 5 000-character error body to 500 characters in the message', async () => {
      expect.assertions(4);
      mockFetchOnce('x'.repeat(5_000), { status: 500 });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        const message = (err as CogniPipeError).message;
        expect(isCogniPipeError(err)).toBe(true);
        expect(message).toContain('truncated, 4500 more characters');
        expect(message).toContain('x'.repeat(500));
        expect(message).not.toContain('x'.repeat(501));
      }
    });

    it('truncates a non-JSON 200 body the same way', async () => {
      expect.assertions(2);
      mockFetchOnce('y'.repeat(5_000));

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('truncated');
        expect((err as CogniPipeError).message.length).toBeLessThan(900);
      }
    });

    it('truncates an oversized Slack error code', async () => {
      expect.assertions(1);
      mockFetchOnce({ ok: false, error: 'e'.repeat(5_000) });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message.length).toBeLessThan(900);
      }
    });

    it('redacts the token if a response body echoes it back', async () => {
      expect.assertions(3);
      mockFetchOnce(`upstream said: Authorization: Bearer ${TOKEN}`, { status: 500 });

      try {
        await node.execute(baseConfig, mockCtx);
      } catch (err) {
        expect((err as CogniPipeError).message).not.toContain(TOKEN);
        expect((err as CogniPipeError).message).toContain('[REDACTED]');
        expect(JSON.stringify((err as CogniPipeError).toJSON())).not.toContain(TOKEN);
      }
    });

    it('never puts the token in the message, context or cause of any failure', async () => {
      const scenarios: Array<() => void> = [
        () => mockFetchOnce({ ok: false, error: 'invalid_auth' }),
        () => mockFetchOnce({ ok: false, error: 'missing_scope', needed: 'chat:write' }),
        () => mockFetchOnce({ ok: false }, { status: 429, headers: { 'Retry-After': '5' } }),
        () => mockFetchOnce('boom', { status: 500 }),
        () => mockFetchOnce('not json'),
        () => mockFetchOnce({ ok: true }),
        () => {
          global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
        },
      ];

      for (const arrange of scenarios) {
        arrange();
        let thrown: unknown;
        try {
          await node.execute(baseConfig, mockCtx);
        } catch (err) {
          thrown = err;
        }

        expect(isCogniPipeError(thrown)).toBe(true);
        const error = thrown as CogniPipeError;
        expect(error.message).not.toContain(TOKEN);
        expect(JSON.stringify(error.context ?? {})).not.toContain(TOKEN);
        expect(String(error.cause ?? '')).not.toContain(TOKEN);
      }
    });
  });
});

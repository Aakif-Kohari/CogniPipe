/**
 * @module SlackMessageNode
 *
 * Slack node for CogniPipe workflows. Posts plain-text and Block Kit messages
 * to a channel through Slack's `chat.postMessage` Web API method.
 * Uses Node.js 22's built-in fetch — no `@slack/web-api` dependency.
 */

import { BaseNode, CogniNode, defineConfig } from '@cognipipe/sdk';
import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import { URL } from 'node:url';
import { z } from 'zod';

/**
 * Output of a successful `postMessage` call.
 */
export interface SlackMessageNodeOutput extends NodeOutput {
  /** Always `true` — a Slack `ok: false` response throws instead of returning. */
  ok: true;
  /** The channel ID Slack resolved, e.g. `"C0123ABCD"` (even when the config used `"#general"`). */
  channel: string;
  /** Message timestamp, e.g. `"1712345678.000100"`. Use as `threadTs` to reply in a thread (Issue #162). */
  ts: string;
}

/**
 * One Block Kit block. Only the mandatory `type` is validated — Slack owns the
 * (large and frequently changing) Block Kit grammar, so every other key is
 * passed through untouched and Slack reports anything it dislikes.
 */
const BlockSchema = z.looseObject({ type: z.string().min(1) });

/**
 * Config for the `postMessage` action.
 * `tokenEnv` is the NAME of an environment variable — the token itself is never
 * accepted in config.
 */
const PostMessageSchema = z
  .object({
    action: z.literal('postMessage'),
    tokenEnv: z.string().min(1).default('SLACK_BOT_TOKEN'),
    /** `"#general"` or a channel ID such as `"C0123ABCD"`. */
    channel: z.string().min(1),
    text: z.string().min(1).optional(),
    /** Slack allows at most 50 blocks per message. */
    blocks: z.array(BlockSchema).min(1).max(50).optional(),
    unfurlLinks: z.boolean().optional(),
    /** Slack Web API base URL. Must be https. Defaults to `https://slack.com/api`. */
    baseUrl: z.string().url().optional(),
  })
  .refine(config => config.text !== undefined || config.blocks !== undefined, {
    message: 'Provide at least one of "text" or "blocks"',
    path: ['text'],
  });

/** Validated `postMessage` config, with defaults applied. */
type PostMessageConfig = z.output<typeof PostMessageSchema>;

/**
 * Config accepted by {@link SlackMessageNode}. `action` may be omitted, in which
 * case it means `postMessage`.
 */
export type SlackMessageConfig = Omit<z.input<typeof PostMessageSchema>, 'action'> & {
  action?: 'postMessage';
};

/**
 * Treats a missing `action` as `postMessage` before the union is evaluated.
 * An unknown `action` is left untouched so the union rejects it.
 */
function withDefaultAction(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.action === undefined) {
      return { ...record, action: 'postMessage' };
    }
  }
  return raw;
}

/**
 * Config schema: an `action`-keyed discriminated union. Issue #162 adds
 * `postToThread` by appending one more schema to this array — `PostMessageSchema`
 * and the `switch` in `execute()` only gain a sibling, nothing existing changes.
 */
const SlackConfig = defineConfig(
  z.preprocess(withDefaultAction, z.discriminatedUnion('action', [PostMessageSchema])),
);

const DEFAULT_BASE_URL = 'https://slack.com/api';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum characters of a Slack response body echoed into an error message. */
const MAX_ERROR_BODY_CHARS = 500;

/** Keeps provider response bodies from flooding logs; bounds message size only. */
function truncateErrorBody(body: string): string {
  return body.length > MAX_ERROR_BODY_CHARS
    ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}… [truncated, ${body.length - MAX_ERROR_BODY_CHARS} more characters]`
    : body;
}

/**
 * Prepares a response body for an error message or context: the bot token is
 * replaced first (so truncation can never leave a partial token behind), then
 * the result is truncated.
 */
function safeBodySnippet(body: string, token: string): string {
  return truncateErrorBody(body.split(token).join('[REDACTED]'));
}

/** Joins baseUrl + endpoint without double slashes and without mangling query strings. */
function buildEndpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  let pathname = url.pathname;
  while (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = `${pathname}/${endpoint}`;
  return url.toString();
}

/**
 * Returns an actionable next step for the Slack errors users hit most often,
 * or `undefined` for anything else. `tokenEnv` is the variable NAME, never the token.
 */
function getSlackErrorHint(error: string, tokenEnv: string, needed?: string): string | undefined {
  switch (error) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
      return `Hint: Slack rejected the token in the "${tokenEnv}" environment variable. Check that it is a valid, non-revoked bot token for this workspace.`;
    case 'channel_not_found':
      return 'Hint: Check the "channel" value (use a channel ID such as C0123ABCD, or #name for a public channel). Private channels are only visible to the bot after it is invited.';
    case 'not_in_channel':
      return 'Hint: Invite the bot to the channel first (in Slack: /invite @YourBotName).';
    case 'is_archived':
      return 'Hint: The channel is archived. Unarchive it or choose another channel.';
    case 'invalid_blocks':
      return 'Hint: Slack rejected the "blocks" payload. Validate it in the Slack Block Kit Builder.';
    case 'missing_scope':
      return needed
        ? `Hint: The bot token is missing the "${needed}" scope. Add it under OAuth & Permissions in your Slack app settings, then reinstall the app.`
        : 'Hint: The bot token is missing a required scope (chat:write is required). Add it under OAuth & Permissions in your Slack app settings, then reinstall the app.';
    default:
      return undefined;
  }
}

/** Maps a failure of `fetch()` or of reading the response body to a CogniPipeError. */
function toRequestError(err: unknown, signal: AbortSignal): CogniPipeError {
  const cause = err instanceof Error ? err : undefined;

  if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
    return new CogniPipeError(`Slack API request timed out after ${DEFAULT_TIMEOUT_MS}ms.`, {
      code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
      context: { timeoutMs: DEFAULT_TIMEOUT_MS },
      cause,
    });
  }

  return new CogniPipeError(
    `Slack API request failed: ${err instanceof Error ? err.message : String(err)}`,
    { code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED, cause },
  );
}

/** Calls `chat.postMessage` and validates Slack's response. */
async function postMessage(cfg: PostMessageConfig): Promise<SlackMessageNodeOutput> {
  const token = process.env[cfg.tokenEnv];
  if (!token) {
    throw new CogniPipeError(
      `Environment variable "${cfg.tokenEnv}" is not set. SlackMessageNode requires a Slack bot token.`,
      { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { tokenEnv: cfg.tokenEnv } },
    );
  }

  const baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
  const { protocol } = new URL(baseUrl);
  if (protocol !== 'https:') {
    throw new CogniPipeError(
      `SlackMessageNode requires an https:// baseUrl to avoid sending the bot token over cleartext. Got protocol "${protocol}".`,
      { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { protocol } },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  let responseText: string;

  try {
    try {
      response = await fetch(buildEndpointUrl(baseUrl, 'chat.postMessage'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        // JSON.stringify drops keys whose value is undefined.
        body: JSON.stringify({
          channel: cfg.channel,
          text: cfg.text,
          blocks: cfg.blocks,
          unfurl_links: cfg.unfurlLinks,
        }),
        signal: controller.signal,
      });
      // Read the body while the timeout is still armed so a stalled body can't hang the step.
      responseText = await response.text();
    } catch (err) {
      throw toRequestError(err, controller.signal);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 429) {
    const rawRetryAfter = response.headers.get('Retry-After');
    const retryAfter = rawRetryAfter !== null ? safeBodySnippet(rawRetryAfter, token) : null;
    throw new CogniPipeError(
      retryAfter !== null
        ? `Slack API rate limit exceeded (HTTP 429). Slack asks you to retry after ${retryAfter} seconds. Set "retry:" on this step to retry automatically.`
        : 'Slack API rate limit exceeded (HTTP 429). Retry later, or set "retry:" on this step to retry automatically.',
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { status: 429, retryAfter },
      },
    );
  }

  if (!response.ok) {
    throw new CogniPipeError(
      `Slack API returned ${response.status}: ${safeBodySnippet(responseText, token)}`,
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { status: response.status },
      },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    throw new CogniPipeError(
      `Slack API returned a response that could not be parsed as JSON: ${safeBodySnippet(responseText, token)}`,
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { status: response.status },
        cause: err instanceof Error ? err : undefined,
      },
    );
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new CogniPipeError(
      'Slack API returned an unexpected response (expected a JSON object).',
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { body: safeBodySnippet(responseText, token) },
      },
    );
  }

  const result = data as Record<string, unknown>;

  // Slack reports most failures as HTTP 200 with { ok: false, error: "..." },
  // so checking response.ok alone is not enough.
  if (result.ok !== true) {
    const slackError = safeBodySnippet(
      typeof result.error === 'string' ? result.error : 'unknown_error',
      token,
    );
    const needed =
      typeof result.needed === 'string' ? safeBodySnippet(result.needed, token) : undefined;
    const hint = getSlackErrorHint(slackError, cfg.tokenEnv, needed);

    throw new CogniPipeError(
      hint ? `Slack API error "${slackError}". ${hint}` : `Slack API error "${slackError}".`,
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { slackError, needed },
      },
    );
  }

  const { channel, ts } = result;
  if (typeof channel !== 'string' || typeof ts !== 'string') {
    throw new CogniPipeError(
      'Slack API returned an incomplete response: expected string "channel" and "ts" fields.',
      {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { body: safeBodySnippet(responseText, token) },
      },
    );
  }

  return { ok: true, channel, ts };
}

/**
 * Slack `chat.postMessage` node.
 * Posts a plain-text message, a Block Kit message, or both (then `text` is the
 * notification fallback). Reads the bot token from `process.env[config.tokenEnv]`
 * — never accepts the token directly in config.
 *
 * @example
 * ```yaml
 * steps:
 *   - name: notify
 *     uses: '@cognipipe/node-slack'
 *     config:
 *       channel: '#engineering'
 *       text: 'Deployment complete!'
 * ```
 */
@CogniNode({ type: '@cognipipe/node-slack', version: '1.0.0' })
export class SlackMessageNode extends BaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<SlackMessageNodeOutput> {
    const cfg = SlackConfig.parse(config);

    switch (cfg.action) {
      case 'postMessage':
        return postMessage(cfg);
    }
  }
}

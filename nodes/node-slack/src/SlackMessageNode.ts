/**
 * @module SlackMessageNode
 *
 * Slack node for CogniPipe workflows. Posts plain-text and Block Kit messages
 * to a channel — or as a reply inside an existing thread — through Slack's
 * `chat.postMessage` Web API method.
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
  /** Message timestamp, e.g. `"1712345678.000100"`. Use as `threadTs` to reply in a thread. */
  ts: string;
}

/**
 * Output of a successful `postToThread` call.
 */
export interface SlackThreadReplyOutput extends NodeOutput {
  /** Always `true` — a Slack `ok: false` response throws instead of returning. */
  ok: true;
  /** The channel ID Slack resolved, e.g. `"C0123ABCD"` (even when the config used `"#general"`). */
  channel: string;
  /** The reply's own timestamp, e.g. `"1712345678.000200"`. */
  ts: string;
  /** Echoes the parent message's `ts` — the `threadTs` the reply was posted under. */
  threadTs: string;
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
 * Config for the `postToThread` action: the same shared fields as `postMessage`
 * plus the parent message's timestamp. Declared as its own schema so the
 * `postMessage` variant above stays untouched.
 */
const PostToThreadSchema = z
  .object({
    action: z.literal('postToThread'),
    tokenEnv: z.string().min(1).default('SLACK_BOT_TOKEN'),
    /** `"#general"` or a channel ID such as `"C0123ABCD"`. Must be the parent message's channel. */
    channel: z.string().min(1),
    text: z.string().min(1).optional(),
    /** Slack allows at most 50 blocks per message. */
    blocks: z.array(BlockSchema).min(1).max(50).optional(),
    unfurlLinks: z.boolean().optional(),
    /** Slack Web API base URL. Must be https. Defaults to `https://slack.com/api`. */
    baseUrl: z.string().url().optional(),
    /**
     * The parent message's `ts`, e.g. `"1712345678.000100"`. Matched strictly (no
     * trimming) so a stray space from a template fails here instead of in Slack.
     */
    threadTs: z
      .string()
      .regex(
        /^\d+\.\d+$/,
        'threadTs must be the parent message\'s ts: digits, a dot, digits (for example "1712345678.000100") with no surrounding whitespace',
      ),
    /** Sent as `reply_broadcast`: also show the reply in the channel. */
    replyBroadcast: z.boolean().optional(),
  })
  .refine(config => config.text !== undefined || config.blocks !== undefined, {
    message: 'Provide at least one of "text" or "blocks"',
    path: ['text'],
  });

/** Validated `postToThread` config, with defaults applied. */
type PostToThreadConfig = z.output<typeof PostToThreadSchema>;

/**
 * Config accepted by {@link SlackMessageNode}. `action` may be omitted, in which
 * case it means `postMessage`.
 */
export type SlackMessageConfig =
  | (Omit<z.input<typeof PostMessageSchema>, 'action'> & { action?: 'postMessage' })
  | z.input<typeof PostToThreadSchema>;

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
 * Config schema: an `action`-keyed discriminated union. A new action is one more
 * schema in this array plus one more `case` in `execute()` — existing variants
 * are never edited.
 */
const SlackConfig = defineConfig(
  z.preprocess(
    withDefaultAction,
    z.discriminatedUnion('action', [PostMessageSchema, PostToThreadSchema]),
  ),
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

/** The fields every action sends to `chat.postMessage`, whatever else it adds. */
type SharedSlackConfig = Omit<PostMessageConfig, 'action'>;

/** Request fields only some actions add to the shared body. */
interface ExtraRequestFields {
  thread_ts?: string;
  reply_broadcast?: boolean;
}

/** The part of a successful Slack response every action returns. */
interface SlackPostResult {
  channel: string;
  ts: string;
}

/**
 * Calls `chat.postMessage` and validates Slack's response. Every action goes
 * through here so error handling (ok: false hints, 429, timeout, 500-character
 * body cap, token redaction) can never drift between them.
 */
async function sendChatPostMessage(
  cfg: SharedSlackConfig,
  extra: ExtraRequestFields,
): Promise<SlackPostResult> {
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
          ...extra,
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

  return { channel, ts };
}

/** Posts a new top-level message. */
async function postMessage(cfg: PostMessageConfig): Promise<SlackMessageNodeOutput> {
  const { channel, ts } = await sendChatPostMessage(cfg, {});
  return { ok: true, channel, ts };
}

/** Posts a reply under the message whose `ts` is `cfg.threadTs`. */
async function postToThread(cfg: PostToThreadConfig): Promise<SlackThreadReplyOutput> {
  const { channel, ts } = await sendChatPostMessage(cfg, {
    thread_ts: cfg.threadTs,
    reply_broadcast: cfg.replyBroadcast,
  });
  return { ok: true, channel, ts, threadTs: cfg.threadTs };
}

/**
 * Slack `chat.postMessage` node.
 * Posts a plain-text message, a Block Kit message, or both (then `text` is the
 * notification fallback). With `action: postToThread` the message is posted as a
 * reply under an earlier message instead. Reads the bot token from
 * `process.env[config.tokenEnv]` — never accepts the token directly in config.
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
 *
 * @example
 * ```yaml
 * steps:
 *   - name: follow-up
 *     uses: '@cognipipe/node-slack'
 *     dependsOn: ['notify']
 *     config:
 *       action: postToThread
 *       channel: '{{ steps.notify.output.channel }}'
 *       threadTs: '{{ steps.notify.output.ts }}'
 *       text: 'Rollout finished ✅'
 * ```
 */
@CogniNode({ type: '@cognipipe/node-slack', version: '1.0.0' })
export class SlackMessageNode extends BaseNode {
  async execute(
    config: NodeConfig,
    _ctx: IExecutionContext,
  ): Promise<SlackMessageNodeOutput | SlackThreadReplyOutput> {
    const cfg = SlackConfig.parse(config);

    switch (cfg.action) {
      case 'postMessage':
        return postMessage(cfg);
      case 'postToThread':
        return postToThread(cfg);
    }
  }
}

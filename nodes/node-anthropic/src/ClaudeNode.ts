import { BaseNode, CogniNode } from '@cognipipe/sdk';
import type { IExecutionContext, NodeConfig } from '@cognipipe/types';
import type { AiProviderConfig, AiNodeOutput } from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import { URL } from 'node:url';
import { z } from 'zod';

/**
 * Config schema for ClaudeNode.
 * Mirrors the shared `AiProviderConfig` fields (provider, apiKeyEnv, model,
 * baseUrl, streaming, maxTokens, temperature) at runtime via Zod, and adds one
 * chat-specific field (`prompt`). See `ClaudeNodeConfig` below for the
 * compile-time contract against `AiProviderConfig` — Anthropic-specific
 * fields are additive only, no shared field is redefined with different
 * semantics.
 *
 * Two bounds differ deliberately from `node-openai`'s `ChatCompletionConfigSchema`
 * and must NOT be copied from it verbatim:
 * - `maxTokens` defaults to 1024 (and is always sent) because Anthropic's
 *   Messages API requires `max_tokens` on every request and returns a 400
 *   without it — OpenAI's is optional.
 * - `temperature`'s valid range is 0–1, not OpenAI's 0–2.
 *
 * `streaming` is inherited from `AiProviderConfig` but, like
 * `ChatCompletionConfigSchema`, is intentionally left out of this schema:
 * Anthropic's Messages API also returns Server-Sent Events for streaming
 * requests, and this node doesn't yet aggregate them into a single
 * `AiNodeOutput` either. The `execute()` streaming guard below throws before
 * any request is sent if a caller requests it anyway.
 */
const ClaudeConfigSchema = z.object({
  provider: z.string().default('anthropic'),
  apiKeyEnv: z.string().min(1).default('ANTHROPIC_API_KEY'),
  model: z.enum(['claude-sonnet-5', 'claude-haiku-4-5-20251001']),
  baseUrl: z.string().url().optional(),
  streaming: z.boolean().default(false),
  // Anthropic REQUIRES max_tokens on every request — the API 400s without
  // it. OpenAI's equivalent field is optional; do not drop this default
  // when copying this node's structure elsewhere.
  maxTokens: z.number().int().positive().default(1024),
  // Anthropic's valid range is 0–1, NOT OpenAI's 0–2.
  temperature: z.number().min(0).max(1).optional(),
  /** Chat-specific: the prompt sent to the model. */
  prompt: z.string().min(1, 'prompt must be a non-empty string'),
});

/** Runtime-validated config, inferred from the Zod schema above. */
export type ClaudeConfig = z.input<typeof ClaudeConfigSchema>;

/**
 * Compile-time config contract for this node, following the pattern
 * documented in `AiProviderConfig`'s own JSDoc (`packages/types/src/ai-provider.types.ts`):
 * extend the shared interface, add only what's new.
 */
export interface ClaudeNodeConfig extends AiProviderConfig {
  /** Chat-specific: the prompt sent to the model. */
  prompt: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Shape of a successful Anthropic Messages API response. */
interface AnthropicMessageResponse {
  content: Array<{ type: string; text: string }>;
  model: string;
  // Anthropic reports input/output tokens separately and never returns a
  // total_tokens field — see AiExecutionMetadata's JSDoc. totalTokens is
  // computed below, not read off this response.
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Anthropic Messages API node.
 * Supports claude-sonnet-5 and claude-haiku-4-5-20251001. Reads the
 * API key from process.env[config.apiKeyEnv] — never accepts the key
 * directly in config.
 *
 * @example
 * ```yaml
 * steps:
 *   - name: summarize
 *     uses: '@cognipipe/node-anthropic'
 *     config:
 *       model: claude-sonnet-5
 *       prompt: 'Summarize: {{ steps.fetch-data.output.body }}'
 *       apiKeyEnv: ANTHROPIC_API_KEY
 * ```
 */
@CogniNode({ type: '@cognipipe/node-anthropic', version: '1.0.0' })
export class ClaudeNode extends BaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<AiNodeOutput> {
    const cfg = this.validateConfig(ClaudeConfigSchema, config);

    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) {
      throw new CogniPipeError(
        `Environment variable "${cfg.apiKeyEnv}" is not set. ClaudeNode requires an Anthropic API key.`,
        { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { apiKeyEnv: cfg.apiKeyEnv } },
      );
    }

    const baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;

    if (new URL(baseUrl).protocol !== 'https:') {
      throw new CogniPipeError(
        `ClaudeNode requires an https:// baseUrl to avoid sending the API key over cleartext. Got: "${baseUrl}". Insecure local gateways are not supported in v1.`,
        { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { baseUrl } },
      );
    }

    // `streaming` is not in ClaudeConfigSchema, so a caller-supplied value
    // is read straight off the raw, pre-validation config — the same way
    // ChatCompletionNode guards it. See the schema's JSDoc above for why
    // this isn't implemented yet.
    if ((config as { streaming?: unknown }).streaming) {
      throw new CogniPipeError(
        'ClaudeNode does not yet support streaming responses. Set streaming to false (or omit it) until SSE aggregation is implemented.',
        { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { streaming: true } },
      );
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    let rawData: unknown;

    try {
      try {
        response = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Anthropic uses x-api-key, NOT "Authorization: Bearer".
            'x-api-key': apiKey,
            // REQUIRED on every request — Anthropic has no equivalent of
            // OpenAI's version-less endpoint.
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify({
            model: cfg.model,
            max_tokens: cfg.maxTokens, // Anthropic requires this
            temperature: cfg.temperature,
            messages: [{ role: 'user', content: cfg.prompt }],
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new CogniPipeError(
            `Anthropic API request timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
            {
              code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
              context: { baseUrl, timeout: DEFAULT_TIMEOUT_MS },
            },
          );
        }
        throw new CogniPipeError(
          `Anthropic API request failed: ${err instanceof Error ? err.message : String(err)}`,
          {
            code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
            cause: err instanceof Error ? err : undefined,
          },
        );
      }

      if (!response.ok) {
        const errBody = await response.text();
        throw new CogniPipeError(`Anthropic API returned ${response.status}: ${errBody}`, {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { status: response.status },
        });
      }

      try {
        rawData = await response.json();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new CogniPipeError(
            `Anthropic API request timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
            {
              code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
              context: { baseUrl, timeout: DEFAULT_TIMEOUT_MS },
            },
          );
        }
        throw new CogniPipeError(
          `Anthropic API returned a response that could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`,
          {
            code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
            cause: err instanceof Error ? err : undefined,
          },
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const maybe = rawData as Partial<AnthropicMessageResponse> | null;
    if (
      !maybe ||
      typeof maybe !== 'object' ||
      !Array.isArray(maybe.content) ||
      maybe.content.length === 0 ||
      typeof maybe.model !== 'string' ||
      typeof maybe.usage?.input_tokens !== 'number' ||
      typeof maybe.usage?.output_tokens !== 'number'
    ) {
      throw new CogniPipeError(
        'Anthropic API returned an incomplete or malformed messages response.',
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { body: rawData },
        },
      );
    }

    const data = maybe as AnthropicMessageResponse;
    const textBlock = data.content.find(block => block.type === 'text');
    const latencyMs = Date.now() - startTime;

    const inputTokens = data.usage.input_tokens;
    const outputTokens = data.usage.output_tokens;

    return {
      content: textBlock?.text,
      aiMeta: {
        // Anthropic's usage.* -> aiMeta.* per AiExecutionMetadata JSDoc.
        // totalTokens is COMPUTED as inputTokens + outputTokens — Anthropic
        // never returns a total_tokens field, unlike OpenAI where it's used
        // as-is. Do not copy node-openai's passthrough here.
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens, // COMPUTED — Anthropic never returns total_tokens directly
        latencyMs,
        modelUsed: data.model,
        providerUrlUsed: baseUrl,
        // Hardcoded in v1 per AiExecutionMetadata contract — no retry loop
        // or fallback chain implemented yet (see README for the
        // RetryManager follow-up noted in the issue).
        retryCount: 0,
        fallbackUsed: false,
        completionReason: 'success',
      },
    };
  }
}

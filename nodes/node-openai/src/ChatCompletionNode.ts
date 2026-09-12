import { BaseNode, CogniNode } from '@cognipipe/sdk';
import type { IExecutionContext, NodeConfig } from '@cognipipe/types';
import type { AiProviderConfig, AiNodeOutput } from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import { z } from 'zod';

/**
 * Config schema for ChatCompletionNode.
 * Mirrors the shared `AiProviderConfig` fields (provider, apiKeyEnv, model,
 * baseUrl, streaming, maxTokens, temperature) at runtime via Zod, and adds
 * one chat-specific field (`prompt`). See `ChatCompletionNodeConfig` below
 * for the compile-time contract against `AiProviderConfig` — OpenAI-specific
 * fields are additive only, no shared field is redefined with different
 * semantics.
 */
const ChatCompletionConfigSchema = z.object({
  provider: z.string().default('openai'),
  apiKeyEnv: z.string().min(1).default('OPENAI_API_KEY'),
  model: z.enum(['gpt-4o', 'gpt-3.5-turbo']),
  baseUrl: z.string().url().optional(),
  streaming: z.boolean().default(false),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Chat-specific: the prompt sent to the model. */
  prompt: z.string().min(1, 'prompt must be a non-empty string'),
});

/** Runtime-validated config, inferred from the Zod schema above. */
export type ChatCompletionConfig = z.infer<typeof ChatCompletionConfigSchema>;

/**
 * Compile-time config contract for this node, following the pattern
 * documented in `AiProviderConfig`'s own JSDoc (`packages/types/src/ai-provider.types.ts`):
 * extend the shared interface, add only what's new.
 */
export interface ChatCompletionNodeConfig extends AiProviderConfig {
  /** Chat-specific: the prompt sent to the model. */
  prompt: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Shape of a successful OpenAI Chat Completions API response. */
interface OpenAiChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI Chat Completions node.
 * Supports gpt-4o and gpt-3.5-turbo. Reads the API key from
 * process.env[config.apiKeyEnv] — never accepts the key directly in config.
 *
 * @example
 * ```yaml
 * steps:
 *   - name: summarize
 *     uses: '@cognipipe/node-openai'
 *     config:
 *       model: gpt-4o
 *       prompt: 'Summarize: {{ steps.fetch-data.output.body }}'
 *       apiKeyEnv: OPENAI_API_KEY
 * ```
 */
@CogniNode({ type: '@cognipipe/node-openai', version: '1.0.0' })
export class ChatCompletionNode extends BaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<AiNodeOutput> {
    const cfg = this.validateConfig(ChatCompletionConfigSchema, config);

    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) {
      throw new CogniPipeError(
        `Environment variable "${cfg.apiKeyEnv}" is not set. ChatCompletionNode requires an OpenAI API key.`,
        { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { apiKeyEnv: cfg.apiKeyEnv } },
      );
    }

    const baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
    const startTime = Date.now();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: cfg.prompt }],
          stream: cfg.streaming,
          max_tokens: cfg.maxTokens,
          temperature: cfg.temperature,
        }),
      });
    } catch (err) {
      throw new CogniPipeError(
        `OpenAI API request failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          cause: err instanceof Error ? err : undefined,
        },
      );
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new CogniPipeError(`OpenAI API returned ${response.status}: ${errBody}`, {
        code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
        context: { status: response.status },
      });
    }

    const data = (await response.json()) as OpenAiChatCompletionResponse;

    const latencyMs = Date.now() - startTime;

    return {
      content: data.choices[0]?.message.content,
      aiMeta: {
        // OpenAI's usage.* -> aiMeta.* per AiExecutionMetadata JSDoc.
        // total_tokens is used as-is (never recomputed) — OpenAI returns
        // it directly and it already satisfies the invariant.
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
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

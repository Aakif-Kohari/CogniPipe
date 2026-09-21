import { BaseNode, CogniNode } from '@cognipipe/sdk';
import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import type { AiProviderConfig } from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import { URL } from 'node:url';
import { z } from 'zod';

/** Config schema for EmbeddingNode. */
const EmbeddingConfigSchema = z.object({
  provider: z.string().default('openai'),
  apiKeyEnv: z.string().min(1).default('OPENAI_API_KEY'),
  model: z.enum(['text-embedding-3-small', 'text-embedding-3-large']),
  baseUrl: z.string().url().optional(),
  /** Text to embed. */
  input: z.string().min(1, 'input must be a non-empty string'),
});

/** Runtime-validated config, inferred from the Zod schema above. */
export type EmbeddingConfig = z.input<typeof EmbeddingConfigSchema>;

/** Compile-time config contract for OpenAI embeddings. */
export interface EmbeddingNodeConfig extends AiProviderConfig {
  model: 'text-embedding-3-small' | 'text-embedding-3-large';
  /** Text to embed. */
  input: string;
}

/**
 * Output for EmbeddingNode. Does NOT use AiNodeOutput.content for vectors —
 * `content` is intentionally undefined, and the vector lives in `embedding`
 * because embedding dimensions vary by model.
 */
export interface EmbeddingNodeOutput extends NodeOutput {
  content?: undefined;
  /** The embedding vector — length depends on the model used. */
  embedding: number[];
  aiMeta: {
    inputTokens: number;
    outputTokens: 0;
    totalTokens: number;
    latencyMs: number;
    modelUsed: string;
    providerUrlUsed: string;
    retryCount: number;
    fallbackUsed: false;
    completionReason: 'success';
  };
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Shape of a successful OpenAI Embeddings API response. */
interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI Embeddings node.
 * Supports text-embedding-3-small and text-embedding-3-large. Reads the API key
 * from process.env[config.apiKeyEnv] — never accepts the key directly in config.
 *
 * @example
 * ```yaml
 * steps:
 *   - name: embed-query
 *     uses: '@cognipipe/node-openai-embedding'
 *     config:
 *       model: text-embedding-3-small
 *       input: 'Search query text'
 *       apiKeyEnv: OPENAI_API_KEY
 * ```
 */
@CogniNode({ type: '@cognipipe/node-openai-embedding', version: '1.0.0' })
export class EmbeddingNode extends BaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<EmbeddingNodeOutput> {
    const cfg = this.validateConfig(EmbeddingConfigSchema, config);

    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) {
      throw new CogniPipeError(
        `Environment variable "${cfg.apiKeyEnv}" is not set. EmbeddingNode requires an OpenAI API key.`,
        { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { apiKeyEnv: cfg.apiKeyEnv } },
      );
    }

    const baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;

    if (new URL(baseUrl).protocol !== 'https:') {
      throw new CogniPipeError(
        `EmbeddingNode requires an https:// baseUrl to avoid sending the API key over cleartext. Got: "${baseUrl}". Insecure local gateways are not supported in v1.`,
        { code: COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID, context: { baseUrl } },
      );
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    let rawData: unknown;

    try {
      try {
        response = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            input: cfg.input,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new CogniPipeError(`OpenAI API request timed out after ${DEFAULT_TIMEOUT_MS}ms.`, {
            code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
            context: { baseUrl, timeout: DEFAULT_TIMEOUT_MS },
          });
        }
        throw new CogniPipeError(
          `OpenAI API request failed: ${err instanceof Error ? err.message : String(err)}`,
          {
            code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
            cause: err instanceof Error ? err : undefined,
          },
        );
      }

      if (!response.ok) {
        let errBody: string;
        try {
          errBody = await response.text();
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw new CogniPipeError(
              `OpenAI API request timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
              {
                code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
                context: { baseUrl, timeout: DEFAULT_TIMEOUT_MS },
              },
            );
          }
          throw err;
        }

        throw new CogniPipeError(`OpenAI API returned ${response.status}: ${errBody}`, {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { status: response.status },
        });
      }

      try {
        rawData = await response.json();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new CogniPipeError(`OpenAI API request timed out after ${DEFAULT_TIMEOUT_MS}ms.`, {
            code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
            context: { baseUrl, timeout: DEFAULT_TIMEOUT_MS },
          });
        }
        throw new CogniPipeError(
          `OpenAI API returned a response that could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`,
          {
            code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
            cause: err instanceof Error ? err : undefined,
          },
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const maybe = rawData as Partial<OpenAiEmbeddingResponse> | null;
    const embedding = maybe?.data?.[0]?.embedding;
    if (
      !maybe ||
      typeof maybe !== 'object' ||
      !Array.isArray(maybe.data) ||
      maybe.data.length === 0 ||
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      !embedding.every(value => typeof value === 'number') ||
      typeof maybe.model !== 'string' ||
      typeof maybe.usage?.prompt_tokens !== 'number' ||
      typeof maybe.usage?.total_tokens !== 'number' ||
      maybe.usage.total_tokens !== maybe.usage.prompt_tokens
    ) {
      throw new CogniPipeError(
        'OpenAI API returned an incomplete or malformed embedding response.',
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { body: rawData },
        },
      );
    }

    const data = maybe as OpenAiEmbeddingResponse;
    const embeddingVector = embedding as number[];
    const latencyMs = Date.now() - startTime;

    return {
      content: undefined,
      embedding: embeddingVector,
      aiMeta: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: 0,
        totalTokens: data.usage.total_tokens,
        latencyMs,
        modelUsed: data.model,
        providerUrlUsed: baseUrl,
        retryCount: 0,
        fallbackUsed: false,
        completionReason: 'success',
      },
    };
  }
}

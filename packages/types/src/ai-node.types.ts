/**
 * @module ai-node.types
 *
 * Standard output interface for CogniPipe AI provider nodes.
 *
 * Every AI node (@cognipipe/node-openai, @cognipipe/node-anthropic, etc.)
 * must return an object satisfying AiNodeOutput from its execute() method.
 *
 * Design principle: two clean layers.
 *   - output.content   → what the AI produced (easy interpolation)
 *   - output.aiMeta.*  → how the execution went (observability, debugging, cost)
 *
 * Workflow authors use content for normal steps and aiMeta for
 * monitoring, cost tracking, and debugging.
 */

import type { NodeOutput } from './node.types.js';

/**
 * Execution metadata produced by every successful AI node run.
 * Covers token usage, latency, cost, retry history, and fallback state.
 *
 * All fields are required unless explicitly marked optional.
 * If the provider does not return a required value, the node must
 * throw CogniPipeError(STEP_EXECUTION_FAILED) rather than set undefined.
 *
 * Important: token counts use provider-specific tokenisation and are
 * useful for cost tracking within a provider/model family, but are
 * not directly comparable across different providers.
 *
 * Invariant: totalTokens === inputTokens + outputTokens
 */
export interface AiExecutionMetadata {
  /**
   * Number of tokens consumed by the input prompt.
   * Normalised from:
   * - OpenAI: usage.prompt_tokens
   * - Anthropic: usage.input_tokens
   */
  inputTokens: number;

  /**
   * Number of tokens generated in the response.
   * Normalised from:
   * - OpenAI: usage.completion_tokens
   * - Anthropic: usage.output_tokens
   */
  outputTokens: number;

  /**
   * Total tokens for this request. Must satisfy: inputTokens + outputTokens.
   * Normalised from:
   * - OpenAI: usage.total_tokens
   * - Anthropic: computed (not returned directly by the API)
   */
  totalTokens: number;

  /**
   * Wall-clock milliseconds from start of API call to complete response.
   * Measured by the node, not reported by the provider.
   */
  latencyMs: number;

  /**
   * Exact model identifier the provider used to serve this request.
   * May differ from AiProviderConfig.model if the provider resolved
   * a version alias (e.g. 'gpt-4o' → 'gpt-4o-2024-11-20').
   * Always populated from the API response, not echoed from config.
   */
  modelUsed: string;

  /**
   * The base URL of the provider endpoint that actually responded.
   * May differ from AiProviderConfig.baseUrl if fallback occurred.
   * Accessible via {{ steps.step-name.output.aiMeta.providerUrlUsed }}.
   */
  providerUrlUsed: string;

  /**
   * Number of retry attempts made before success.
   * 0 means the first attempt succeeded.
   * Accessible via {{ steps.step-name.output.aiMeta.retryCount }}.
   */
  retryCount: number;

  /**
   * Whether the primary provider/model failed and execution fell
   * back to an alternative. Reserved for future fallback chain support.
   * Must be false in all v1 node implementations.
   */
  fallbackUsed: boolean;

  /**
   * How execution completed.
   * - 'success'          → primary provider responded successfully
   * - 'fallback-success' → primary failed, fallback responded (future)
   * - 'partial'          → partial response returned (streaming edge case)
   * Must be 'success' in all v1 node implementations.
   */
  completionReason: 'success' | 'fallback-success' | 'partial';

  /**
   * Estimated cost in USD for this API call.
   * Calculated by the node using provider pricing and token counts.
   * Undefined if the provider does not publish per-token pricing.
   */
  estimatedCostUsd?: number;

  /**
   * The provider that fulfilled the request when fallback occurred.
   * Reserved for future fallback chain support.
   * Must NOT be populated by v1 node implementations.
   */
  fallbackProviderUsed?: string;
}

/**
 * Standard output returned by all CogniPipe AI provider nodes.
 *
 * Two-layer design:
 *   content  → the AI-generated text (interpolate directly in workflow YAML)
 *   aiMeta   → execution metadata (token counts, latency, cost, retry state)
 *
 * @example
 * ```yaml
 * # In a downstream step's config:
 * message: '{{ steps.summarize.output.content }}'
 * cost: '{{ steps.summarize.output.aiMeta.estimatedCostUsd }}'
 * model: '{{ steps.summarize.output.aiMeta.modelUsed }}'
 * ```
 *
 * @example
 * ```typescript
 * // What a completed node-openai step returns:
 * const output: AiNodeOutput = {
 *   content: 'Here is your daily digest...',
 *   aiMeta: {
 *     inputTokens: 1240,
 *     outputTokens: 380,
 *     totalTokens: 1620,
 *     latencyMs: 2341,
 *     modelUsed: 'gpt-4o-2024-11-20',
 *     providerUrlUsed: 'https://api.openai.com/v1',
 *     retryCount: 0,
 *     fallbackUsed: false,
 *     completionReason: 'success',
 *     estimatedCostUsd: 0.0097,
 *   },
 * };
 * ```
 */
export interface AiNodeOutput extends NodeOutput {
  /**
   * The AI-generated text response.
   * Undefined for embedding requests — the vector lives in a
   * provider-specific field defined by the node package itself.
   * Interpolate in workflow YAML as: {{ steps.step-name.output.content }}
   */
  content?: string;

  /**
   * Structured execution metadata. Always required on a successful run.
   * If this cannot be populated, the node must throw CogniPipeError.
   * Interpolate fields as: {{ steps.step-name.output.aiMeta.modelUsed }}
   */
  aiMeta: AiExecutionMetadata;
}

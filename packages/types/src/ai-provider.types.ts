/**
 * @module ai-provider.types
 *
 * Shared configuration interfaces for CogniPipe AI provider nodes.
 *
 * Every AI node (@cognipipe/node-openai, @cognipipe/node-anthropic, etc.)
 * accepts a config that extends AiProviderConfig. This ensures a consistent
 * contract across all AI nodes so workflows, tooling, and future
 * observability features can reason about AI steps uniformly.
 *
 * This module contains type definitions only — no runtime code, no Zod schemas.
 * Zod schemas that validate against these interfaces live in @cognipipe/core
 * and in individual node packages.
 */

/**
 * Provider features a node may declare support for.
 * Used in AiProviderConfig.capabilities to advertise which API features
 * are available for a given provider + model combination.
 *
 * - 'chat'         — chat completion (prompt → text response)
 * - 'embedding'    — text → vector embedding
 * - 'tool-calling' — structured tool / function calling
 * - 'streaming'    — token-by-token streaming responses
 * - 'vision'       — multimodal image understanding in the prompt
 */
export type AiProviderCapability = 'chat' | 'embedding' | 'tool-calling' | 'streaming' | 'vision';

/**
 * AI-provider-specific retry policy for rate-limited API calls (HTTP 429).
 * Intentionally distinct from the workflow-level RetryConfig — AI rate limiting
 * has provider-specific semantics (Retry-After headers, per-minute vs per-day
 * limits) that warrant a dedicated policy shape.
 */
export interface AiRateLimitPolicy {
  /**
   * Maximum number of retry attempts when the provider responds with HTTP 429.
   * The node stops retrying and throws CogniPipeError(STEP_EXECUTION_FAILED)
   * after this many attempts. Must be between 1 and 10.
   */
  maxRetries: number;

  /**
   * Base delay in milliseconds before the first retry attempt.
   * Subsequent retries use exponential backoff from this base value.
   * Example: 1000ms → retries at 1s, 2s, 4s, 8s...
   * Minimum value: 100ms.
   */
  initialDelayMs: number;

  /**
   * Whether the node should honour the `Retry-After` header returned by the
   * provider on a 429 response. When true, the node waits the exact duration
   * specified by the header rather than its own backoff schedule.
   * Defaults to true — respecting provider rate limit signals is best practice.
   */
  respectRetryAfter?: boolean;
}

/**
 * Shared base configuration interface for all CogniPipe AI provider nodes.
 * Every AI node's config type must extend this interface.
 *
 * Fields represent the minimal common denominator across OpenAI, Anthropic,
 * OpenRouter, Gemini, and local model providers. Provider-specific fields
 * (e.g. top_p, frequency_penalty for OpenAI) are defined in the individual
 * node package's own config interface that extends this one.
 *
 * `baseUrl` is the primary discriminator for routing (official endpoints,
 * OpenAI-compatible gateways like Groq/OpenRouter/Together, local endpoints
 * like Ollama, or internal proxies) — never `provider`, which is a free-form
 * label only.
 *
 * @example
 * ```typescript
 * // How node-openai defines its own config extending this base:
 * import type { AiProviderConfig } from '@cognipipe/types';
 *
 * export interface OpenAiNodeConfig extends AiProviderConfig {
 *   // OpenAI-specific fields only — shared fields come from AiProviderConfig
 *   topP?: number;
 *   frequencyPenalty?: number;
 * }
 * ```
 */
export interface AiProviderConfig {
  /**
   * Human-readable identifier for logging and error messages only.
   * Does NOT affect API behaviour and must never be used as a discriminator
   * in conditional workflow logic or node implementations.
   * The API endpoint is determined by baseUrl — not this field.
   * Useful for structured logs: 'openai', 'anthropic', 'openrouter', 'ollama',
   * 'my-internal-proxy'. Any string is valid.
   */
  provider: string;

  /**
   * Name of the environment variable that holds the provider API key.
   * The node reads `process.env[apiKeyEnv]` at execution time.
   * This field holds the VARIABLE NAME, never the key value itself.
   * Zero hardcoded secrets — always use an env var name here.
   *
   * @example 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'
   */
  apiKeyEnv: string;

  /**
   * Model identifier passed verbatim to the provider API.
   * Refer to your provider's model list for valid values.
   *
   * @example 'gpt-4o', 'claude-3-5-sonnet-20241022', 'meta-llama/llama-3-8b-instruct'
   */
  model: string;

  /**
   * Optional custom base URL for the provider's API endpoint.
   * When omitted, each node uses the provider's default production URL.
   * Override to use Azure OpenAI, OpenRouter, Ollama, or an internal proxy.
   *
   * @example 'https://openrouter.ai/api/v1'
   * @example 'http://localhost:11434/v1'
   */
  baseUrl?: string;

  /**
   * Whether to request streaming responses from the provider.
   * When true, the provider returns tokens incrementally as generated.
   * Only effective if the provider and model support streaming.
   * Defaults to false if omitted.
   */
  streaming?: boolean;

  /**
   * Maximum number of tokens the model may generate in its response.
   * Maps to `max_tokens` (OpenAI, Anthropic) or the provider-equivalent field.
   * Uses the provider's own default when omitted.
   */
  maxTokens?: number;

  /**
   * Sampling temperature controlling output randomness.
   * 0 produces deterministic output; higher values increase creativity.
   * Valid range varies by provider — typically 0.0–2.0 (OpenAI) or 0.0–1.0 (Anthropic).
   * Uses the provider's default when omitted.
   */
  temperature?: number;

  /**
   * Capabilities of the specific provider ENDPOINT and MODEL in this config.
   * This describes what the configured baseUrl + model combination can
   * actually do — NOT what the node package generally supports.
   *
   * Example: node-openai may support vision, but if you configure it
   * with baseUrl 'http://localhost:11434/v1' and model 'llama3', you
   * would omit 'vision' here because that specific model does not support it.
   * This keeps the same node package usable across chat-only models,
   * embedding models, streaming models, and future tool-calling setups.
   *
   * Nodes that require a capability should check this field and throw
   * CogniPipeError(NODE_CONFIG_INVALID) if absent, rather than making
   * an API call that will fail.
   * @example ['chat', 'streaming']
   * @example ['embedding']
   * @example ['chat', 'tool-calling', 'vision']
   */
  capabilities?: AiProviderCapability[];

  /**
   * AI-provider-specific rate limit retry policy.
   * Use this instead of the workflow-level RetryConfig for AI nodes, since
   * provider rate limits (HTTP 429 + Retry-After) need different handling
   * than general step failures.
   * When omitted, nodes use a sensible provider-specific default.
   */
  rateLimitPolicy?: AiRateLimitPolicy;
}

# @cognipipe/node-openai

OpenAI Chat Completions node for CogniPipe workflows.

> **Status:** private package, not yet published to npm. First-publish and
> Trusted Publisher setup on npmjs.com is a maintainer task tracked
> separately — this package stays `"private": true` until that's done.

## Usage

```yaml
steps:
  - name: summarize
    uses: '@cognipipe/node-openai'
    config:
      model: gpt-4o
      prompt: 'Summarize: {{ steps.fetch-data.output.body }}'
      apiKeyEnv: OPENAI_API_KEY
```

Downstream steps can read the result via:

```yaml
message: '{{ steps.summarize.output.content }}'
tokens: '{{ steps.summarize.output.aiMeta.totalTokens }}'
model: '{{ steps.summarize.output.aiMeta.modelUsed }}'
```

## Config

| Field             | Type                          | Required | Default                     | Notes                                                                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------- | -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`           | `'gpt-4o' \| 'gpt-3.5-turbo'` | ✅       | —                           | Passed verbatim to the Chat Completions API.                                                                                                                                                                                                                                                                      |
| `prompt`          | `string`                      | ✅       | —                           | Sent as a single `user` message. Must be non-empty.                                                                                                                                                                                                                                                               |
| `apiKeyEnv`       | `string`                      | —        | `'OPENAI_API_KEY'`          | **Name** of the env var holding your OpenAI API key. The node reads `process.env[apiKeyEnv]` — never put a raw key in config.                                                                                                                                                                                     |
| `provider`        | `string`                      | —        | `'openai'`                  | Logging/labeling only. Never branched on.                                                                                                                                                                                                                                                                         |
| `baseUrl`         | `string` (URL)                | —        | `https://api.openai.com/v1` | Override for Azure OpenAI, OpenRouter, a local gateway, etc.                                                                                                                                                                                                                                                      |
| `streaming`       | `boolean`                     | —        | `false`                     | **Not supported in v1.** Setting this to `true` throws `CogniPipeError(NODE_CONFIG_INVALID)` — the OpenAI API returns Server-Sent Events for streaming responses, and this node doesn't yet aggregate them into a single `AiNodeOutput`.                                                                          |
| `maxTokens`       | `number` (positive int)       | —        | provider default            | Forwarded as `max_tokens`.                                                                                                                                                                                                                                                                                        |
| `temperature`     | `number` (0–2)                | —        | provider default            | Forwarded as `temperature`.                                                                                                                                                                                                                                                                                       |
| `capabilities`    | `AiProviderCapability[]`      | —        | —                           | Inherited from `AiProviderConfig`. Accepted by the shared type; this node doesn't yet gate behavior on it (no capability-specific branches exist for chat-only usage in v1).                                                                                                                                      |
| `rateLimitPolicy` | `AiRateLimitPolicy`           | —        | —                           | Inherited from `AiProviderConfig`. **Not wired up in v1** — a 429 response is surfaced immediately as `CogniPipeError(STEP_EXECUTION_FAILED)` rather than retried. Once `RetryManager` lands, this node will consume it to drive exponential-backoff retries without a breaking change to this node's public API. |

## Output (`AiNodeOutput`)

- `content` — the model's text response.
- `aiMeta.inputTokens` / `outputTokens` / `totalTokens` — normalized from OpenAI's `usage.prompt_tokens` / `usage.completion_tokens` / `usage.total_tokens` (used as-is, not recomputed).
- `aiMeta.modelUsed` — the exact model OpenAI served (may differ from the configured alias).
- `aiMeta.providerUrlUsed`, `latencyMs`, `retryCount` (always `0` in v1), `fallbackUsed` (always `false` in v1), `completionReason` (always `'success'` in v1).

## Errors

- Missing/unset `apiKeyEnv` → `CogniPipeError(NODE_CONFIG_INVALID)`.
- Invalid `model` or empty `prompt` → `CogniPipeError(NODE_CONFIG_INVALID)`.
- Non-2xx response from OpenAI → `CogniPipeError(STEP_EXECUTION_FAILED)` (message includes the HTTP status).
- Network failure → `CogniPipeError(STEP_EXECUTION_FAILED)`.

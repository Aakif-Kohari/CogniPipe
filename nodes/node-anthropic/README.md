# @cognipipe/node-anthropic

Anthropic Claude integration node for CogniPipe workflows.

> **Status:** private package, not yet published to npm. First-publish and
> Trusted Publisher setup on npmjs.com is a maintainer task tracked
> separately — this package stays `"private": true` until that's done.

## ClaudeNode

### Usage

```yaml
steps:
  - name: summarize
    uses: '@cognipipe/node-anthropic'
    config:
      model: claude-3-5-sonnet-20241022
      prompt: 'Summarize: {{ steps.fetch-data.output.body }}'
      apiKeyEnv: ANTHROPIC_API_KEY
```

Downstream steps can read the result via:

```yaml
message: '{{ steps.summarize.output.content }}'
tokens: '{{ steps.summarize.output.aiMeta.totalTokens }}'
model: '{{ steps.summarize.output.aiMeta.modelUsed }}'
```

### Config

| Field             | Type                                                        | Required | Default                        | Notes                                                                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`           | `'claude-3-5-sonnet-20241022' \| 'claude-3-haiku-20240307'` | ✅       | —                              | Passed verbatim to the Messages API.                                                                                                                                                                                                                                                                              |
| `prompt`          | `string`                                                    | ✅       | —                              | Sent as a single `user` message. Must be non-empty.                                                                                                                                                                                                                                                               |
| `apiKeyEnv`       | `string`                                                    | —        | `'ANTHROPIC_API_KEY'`          | **Name** of the env var holding your Anthropic API key. The node reads `process.env[apiKeyEnv]` — never put a raw key in config.                                                                                                                                                                                  |
| `provider`        | `string`                                                    | —        | `'anthropic'`                  | Logging/labeling only. Never branched on.                                                                                                                                                                                                                                                                         |
| `baseUrl`         | `string` (URL)                                              | —        | `https://api.anthropic.com/v1` | Override for proxies, Bedrock, etc. **Must be `https://`** to prevent sending the API key in cleartext. Insecure local gateways are not supported in v1.                                                                                                                                                          |
| `maxTokens`       | `number` (positive int)                                     | —        | `1024`                         | **Required by Anthropic's API** (unlike OpenAI, where it's optional) — the API returns a 400 without it, so this node always sends it.                                                                                                                                                                            |
| `temperature`     | `number` (0–1)                                              | —        | provider default               | Forwarded as `temperature`. **Note:** Anthropic's range is strictly `0` to `1`, unlike OpenAI's `0` to `2`. A value above `1` throws a config validation error.                                                                                                                                                   |
| `streaming`       | `boolean`                                                   | —        | `false`                        | **Not supported in v1.** Setting this to `true` throws `CogniPipeError(NODE_CONFIG_INVALID)` — Anthropic's API returns Server-Sent Events for streaming, and this node doesn't yet aggregate them into a single `AiNodeOutput`.                                                                                   |
| `capabilities`    | `AiProviderCapability[]`                                    | —        | —                              | Inherited from `AiProviderConfig`. Accepted by the shared type; this node doesn't yet gate behavior on it.                                                                                                                                                                                                        |
| `rateLimitPolicy` | `AiRateLimitPolicy`                                         | —        | —                              | Inherited from `AiProviderConfig`. **Not wired up in v1** — a 429 response is surfaced immediately as `CogniPipeError(STEP_EXECUTION_FAILED)` rather than retried. Once `RetryManager` lands, this node will consume it to drive exponential-backoff retries without a breaking change to this node's public API. |

### Output (`AiNodeOutput`)

- `content` — the model's text response (extracted from the first `text` block in the `content` array).
- `aiMeta.inputTokens` / `outputTokens` / `totalTokens` — normalized from Anthropic's `usage.input_tokens` / `usage.output_tokens`. **`totalTokens` is computed locally** as `inputTokens + outputTokens`, because Anthropic's API does not return a `total_tokens` field the way OpenAI's does.
- `aiMeta.modelUsed` — the exact model Anthropic served (may differ from the configured alias).
- `aiMeta.providerUrlUsed`, `latencyMs`, `retryCount` (always `0` in v1), `fallbackUsed` (always `false` in v1), `completionReason` (always `'success'` in v1).

## Errors

- Missing/unset `apiKeyEnv` → `CogniPipeError(NODE_CONFIG_INVALID)`.
- Invalid `model`, empty `prompt`, out-of-bounds `temperature` (> 1), `streaming: true`, or insecure `baseUrl` (not `https://`) → `CogniPipeError(NODE_CONFIG_INVALID)`.
- Non-2xx response from Anthropic → `CogniPipeError(STEP_EXECUTION_FAILED)` (message includes the HTTP status).
- Network failure or request timeout (30s) → `CogniPipeError(STEP_EXECUTION_FAILED)`.
- Malformed response → `CogniPipeError(STEP_EXECUTION_FAILED)`.

## A note on model versions

The `model` enum above is pinned to `claude-3-5-sonnet-20241022` and
`claude-3-haiku-20240307` because that's the exact contract this node's
issue and tests were written against. Anthropic has shipped several
generations since those snapshots (Claude Sonnet 4.x/5, Opus 4.x/5, Haiku
4.5, and newer). Widening this enum is a one-line change once a maintainer
decides which newer models to support and updates the tests/README to
match — tracked as a follow-up rather than folded into this PR, so this
node's scope stays reviewable against its issue.

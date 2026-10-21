# @cognipipe/node-slack

Slack integration node for CogniPipe workflows. Posts plain-text and
[Block Kit](https://api.slack.com/block-kit) messages to a Slack channel through the
[`chat.postMessage`](https://api.slack.com/methods/chat.postMessage) Web API method, using Node's
built-in `fetch` (no `@slack/web-api` dependency).

> **Status:** private package, not yet published to npm. First-publish and
> Trusted Publisher setup on npmjs.com is a maintainer task tracked
> separately — this package stays `"private": true` until that's done.

## Slack setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Under **OAuth & Permissions**, add the **`chat:write`** bot token scope.
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
4. Export it as an environment variable — the node reads the token from the environment, never from config:

   ```bash
   export SLACK_BOT_TOKEN="xoxb-your-token"
   ```

5. **Invite the bot to the channel** it should post in (`/invite @YourBotName`). Without this, Slack
   answers `not_in_channel` (or `channel_not_found` for private channels).

## SlackMessageNode

### Usage

Plain text:

```yaml
steps:
  - name: notify
    uses: '@cognipipe/node-slack'
    config:
      channel: '#engineering'
      text: 'Deployment complete!'
```

Block Kit, with `text` as the notification fallback — the flagship HTTP → AI → Slack workflow:

```yaml
steps:
  - name: fetch-data
    uses: '@cognipipe/node-http'
    config:
      url: 'https://example.com/data'

  - name: summarize
    uses: '@cognipipe/node-anthropic'
    dependsOn: ['fetch-data']
    config:
      model: claude-sonnet-5
      prompt: 'Summarize: {{ steps.fetch-data.output.body }}'

  - name: deliver
    uses: '@cognipipe/node-slack'
    dependsOn: ['summarize']
    retry:
      attempts: 3
      delayMs: 5000
    config:
      channel: C0123ABCD
      text: 'Daily summary is ready'
      blocks:
        - type: header
          text: { type: plain_text, text: 'Daily summary' }
        - type: section
          text: { type: mrkdwn, text: '{{ steps.summarize.output.content }}' }
```

Downstream steps can read the result via:

```yaml
channel: '{{ steps.deliver.output.channel }}'
ts: '{{ steps.deliver.output.ts }}'
```

### Config

The config is an `action`-keyed discriminated union. `postMessage` is the only action today, and it is
what you get when `action` is omitted. Other actions (for example `postToThread`) will be added as
separate variants without changing this one.

| Field         | Type            | Required | Default                 | Notes                                                                                                                                                                        |
| ------------- | --------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`      | `'postMessage'` | —        | `'postMessage'`         | Which operation to run. An unknown value fails with `NODE_CONFIG_INVALID`.                                                                                                   |
| `channel`     | `string`        | ✅       | —                       | `"#general"` or a channel ID such as `"C0123ABCD"`. Channel IDs are more robust — they survive renames. Must be non-empty.                                                   |
| `text`        | `string`        | ⚠️       | —                       | Plain-text / mrkdwn message. When `blocks` is also set, this is the notification fallback. Must be non-empty if provided.                                                    |
| `blocks`      | `object[]`      | ⚠️       | —                       | Block Kit blocks, forwarded to Slack **unchanged**. 1–50 items; each must have a string `type`. The rest of each block is not validated here — Slack reports invalid blocks. |
| `tokenEnv`    | `string`        | —        | `'SLACK_BOT_TOKEN'`     | **Name** of the env var holding the bot token. The node reads `process.env[tokenEnv]` — never put a raw token in config.                                                     |
| `unfurlLinks` | `boolean`       | —        | Slack's default         | Sent as `unfurl_links`. Omitted from the request when not set.                                                                                                               |
| `baseUrl`     | `string` (URL)  | —        | `https://slack.com/api` | Override for proxies / test servers. **Must be `https://`** so the token is never sent in cleartext.                                                                         |

⚠️ At least one of `text` or `blocks` is required.

### Output (`SlackMessageNodeOutput`)

```typescript
{
  ok: true;
  channel: string; // channel ID Slack resolved, e.g. "C0123ABCD" (even if you configured "#general")
  ts: string; // message timestamp, e.g. "1712345678.000100"
}
```

`ts` identifies the message; it is what a threaded reply uses as `threadTs`.

## Errors

All failures are `CogniPipeError`s. Error messages never contain the bot token, and any response body
echoed into a message is truncated to 500 characters.

| Code                    | When                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_CONFIG_INVALID`   | Missing/empty `tokenEnv` variable (the message names the variable, not a value); neither `text` nor `blocks`; empty `channel`; more than 50 blocks or a block without a string `type`; unknown `action`; `baseUrl` that is not `https://`. No request is sent. |
| `STEP_EXECUTION_FAILED` | Network failure or timeout (30 s) — the original error is kept as `.cause`; HTTP 429 (message includes the `Retry-After` value); any other non-2xx status; a body that is not JSON; Slack `ok: false`; a success response missing `channel` or `ts`.           |

### Slack API errors

Slack answers most failures with **HTTP 200** and `{ "ok": false, "error": "…" }`, so the node checks
the `ok` field, not just the HTTP status. The error code is included in the message, with a hint for
the common ones:

| Slack error                                   | What to do                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `invalid_auth`, `not_authed`, `token_revoked` | The token in `tokenEnv` is wrong, revoked or for another workspace.                 |
| `channel_not_found`                           | Check `channel`. Private channels are only visible to the bot after it is invited.  |
| `not_in_channel`                              | Invite the bot: `/invite @YourBotName`.                                             |
| `missing_scope`                               | Add the scope named in the message (at least `chat:write`), then reinstall the app. |
| `is_archived`                                 | The channel is archived.                                                            |
| `invalid_blocks`                              | Validate `blocks` in Slack's Block Kit Builder.                                     |

### Rate limits

HTTP 429 is surfaced immediately, with Slack's `Retry-After` value in the message. The node does not
retry on its own in v1 — set `retry:` on the step (see the usage example above) to retry automatically.

> **Retries can duplicate messages.** `retry:` re-runs the whole call after any failure, including a
> timeout or 5xx where Slack may already have posted the message. It is safe for HTTP 429 (nothing was
> posted); for other failures a retry can post the message twice.

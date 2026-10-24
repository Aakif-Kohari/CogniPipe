# AI Content Pipeline — CogniPipe Example

A three-step workflow that demonstrates the flagship CogniPipe use case: fetch
data over HTTP, have an AI model write something about it, and post the result
to Slack. It exercises the core `workflow.yaml` syntax — a `name`/`version`
header, sequential steps wired together with `dependsOn`, a per-step `retry`
policy, and `{{ steps.<step-name>.output.<path> }}` context interpolation.

## What this workflow does

The workflow fetches a Hacker News story (item `8863`) from the public Firebase
API in an HTTP step, passes the story's `title` and `url` into an OpenAI step
that writes a friendly two-sentence blurb, and then posts that blurb to the
`#content-digest` Slack channel. Each step reads the previous step's output
through interpolation, and every step after the first declares `dependsOn` so
the engine runs them in order. It is the reference scenario for the authors of
`@cognipipe/node-http`, `@cognipipe/node-openai` and `@cognipipe/node-slack`.

The Hacker News API needs no key. If the item ever changes shape, pick another
keyless public JSON API and keep every interpolated path a scalar leaf (see
[Interpolation gotchas](#interpolation-gotchas)).

## Nodes used

| Node          | Package                  | Status                                                                                                                                                                                         |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP Request  | `@cognipipe/node-http`   | Implemented and published to npm — supports `GET`, `POST`, `PUT`, `DELETE`, and `PATCH` via Node.js 22's built-in `fetch`. See [`nodes/node-http/README.md`](../../nodes/node-http/README.md). |
| OpenAI Chat   | `@cognipipe/node-openai` | Implemented, but **not yet published to npm** — the package is still `"private": true`. See [`nodes/node-openai/README.md`](../../nodes/node-openai/README.md).                                |
| Slack Message | `@cognipipe/node-slack`  | Implemented (`SlackMessageNode`), but **not yet published to npm** — the package is still `"private": true`. See [`nodes/node-slack/README.md`](../../nodes/node-slack/README.md).             |

Each step is written against its node's current config: `fetch-story` uses
`url`, `method` and `timeout`; `write-blurb` uses `model`, `apiKeyEnv`,
`maxTokens` and `prompt` and exposes the model's reply as `output.content`;
`post-to-slack` uses `tokenEnv`, `channel` and `text`. Once the OpenAI and Slack
packages are published and installed next to the CLI, this workflow is
intended to run without changes.

## Required environment variables

Both variables are already listed in the root [`.env.example`](../../.env.example).
The workflow only references them **by name** (`apiKeyEnv`, `tokenEnv`) — never
put a secret value in `workflow.yaml`.

| Variable          | Used by         | Description                                                                                                                                      |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`  | `write-blurb`   | Your OpenAI API key, read by `@cognipipe/node-openai` to authenticate the chat completion.                                                       |
| `SLACK_BOT_TOKEN` | `post-to-slack` | A Slack Bot User OAuth Token (`xoxb-…`). The bot needs the `chat:write` scope and must be invited to `#content-digest` (`/invite @YourBotName`). |

## How to validate it today

> ⚠️ **This workflow cannot be executed end-to-end yet.** `cognipipe run` checks
> that every step's `uses` package is registered **before it runs any step**,
> and none of the three node packages is resolvable from the CLI's runtime
> context: `@cognipipe/node-openai` and `@cognipipe/node-slack` are not yet
> published to npm, and `@cognipipe/node-http`, although published, is not a
> dependency of the `cognipipe` CLI package. Running `cognipipe run` on this
> file from a repo checkout therefore stops with `NODE_NOT_REGISTERED` on the
> `fetch-story` step, and nothing is fetched, generated or posted. Even with
> `@cognipipe/node-http` installed next to the CLI, the run is rejected the same
> way on `write-blurb`, because `@cognipipe/node-openai` is not published. This
> example exists to pin down the intended `workflow.yaml` syntax and give node
> implementers a concrete reference scenario.

The `cognipipe test <workflow-file>` command validates a workflow and previews
its execution order **without executing any nodes**. From the repo root:

```bash
pnpm turbo build --filter=cognipipe
node apps/cli/dist/index.js test examples/ai-content-pipeline/workflow.yaml
```

`pnpm turbo build --filter=cognipipe` builds the CLI **and** its workspace
dependencies (`@cognipipe/core`, `@cognipipe/types`) in the right order. Using
`pnpm --filter cognipipe build` alone runs only the CLI's `tsc` and fails on a
fresh checkout because the dependency `.d.ts` files are not built yet.

Output:

```text
Validating workflow: ai-content-pipeline (1.0.0)
Structure         ✅ Valid
dependsOn refs    ✅ All 2 references resolve
Circular deps     ✅ No cycles detected
Node availability ❌ @cognipipe/node-http   (not installed — run: pnpm add @cognipipe/node-http)
                  ❌ @cognipipe/node-openai (not installed — run: pnpm add @cognipipe/node-openai)
                  ❌ @cognipipe/node-slack  (not installed — run: pnpm add @cognipipe/node-slack)
Execution order:
  1. fetch-story   (@cognipipe/node-http)
  2. write-blurb   (@cognipipe/node-openai)
  3. post-to-slack (@cognipipe/node-slack)
Result: 3 errors — workflow is not ready to run.
```

The structural checks — parse, schema validation, `dependsOn` references, and
cycle detection — all pass, and the execution order is
`fetch-story → write-blurb → post-to-slack`. The three ❌ rows (and the
non-zero exit code that comes with them) reflect the package-resolution
boundary described above, **not** a broken workflow: `cognipipe test` checks
whether each `uses` package can be resolved from the CLI's context, and none of
them can be today. `hello-world` shows the same behavior for its own nodes.

### Validate the YAML now

For a check that does not depend on node packages at all, use the
`validate.mjs` scratch snippet from
[`examples/hello-world/README.md`](../hello-world/README.md#validate-the-yaml-now).
It resolves `workflow.yaml` relative to itself, so save it next to this
workflow's `workflow.yaml`, build core once, and run it:

```bash
pnpm turbo build --filter=@cognipipe/core
node examples/ai-content-pipeline/validate.mjs
```

On success you will see:

```text
Valid workflow: ai-content-pipeline — 3 steps
```

Delete `validate.mjs` before committing — it is a scratch file, not part of the
example.

## Interpolation gotchas

**Reference a scalar leaf, not a whole object.** Each `{{ }}` expression is
resolved against the execution context when the step starts. Strings, numbers
and booleans are converted with `String()`; an object or array is embedded as
raw JSON text. That is rarely what you want inside a prompt or a Slack message:

> _(Note: `node-http` automatically parses the response body as a JSON object
> when the server returns a `Content-Type` of `application/json`, which is
> why paths like `output.body.title` work.)_

```yaml
# Avoid: pastes the entire Hacker News JSON document, including the long
# `kids` array of comment IDs, into the prompt
prompt: 'Summarize: {{ steps.fetch-story.output.body }}'

# Prefer: reads exactly the two fields the prompt needs
prompt: 'Title: {{ steps.fetch-story.output.body.title }}. URL: {{ steps.fetch-story.output.body.url }}'
```

**A path that does not resolve is an error, not an empty string.** If any part
of the path is missing or `null`, the step fails with an interpolation error.
Not every Hacker News item has a `url` (text-only posts do not), which is why
this example pins item `8863`.

**`dependsOn` is what orders the steps.** The executor is DAG-parallel: a step
with no `dependsOn` starts immediately, concurrently with every other step.
Interpolating `{{ steps.fetch-story.output… }}` does **not** create an implicit
dependency. Without `dependsOn: ['fetch-story']`, `write-blurb` would start
before `fetch-story` has written its output to the context, and its
interpolation would fail with an error telling you to ensure the referenced step
ran first. Every step after the first in this workflow therefore declares
`dependsOn`.

# AI Content Pipeline — CogniPipe Example

A 3-step workflow that demonstrates the flagship CogniPipe use case: chaining an HTTP fetch, an AI generation step, and a Slack post.

## What this workflow does

This pipeline chains three disparate nodes together:
1. **`fetch-story`** (`@cognipipe/node-http`): Fetches a story from the Hacker News Firebase API.
2. **`write-blurb`** (`@cognipipe/node-openai`): Sends the fetched title and URL to OpenAI (`gpt-4o`) with a prompt to write a friendly two-sentence blurb, using expression interpolation (`{{ steps.fetch-story.output.body.title }}`).
3. **`post-to-slack`** (`@cognipipe/node-slack`): Posts the generated blurb to a Slack channel (`#content-digest`) via `SLACK_BOT_TOKEN`.

## How to run

> ⚠️ **This workflow cannot be executed end-to-end yet.** While `@cognipipe/node-http` is published, `@cognipipe/node-openai` and `@cognipipe/node-slack` are still in development or not yet installed in the CLI execution context. Attempting to run this workflow via `cognipipe run` will report `NODE_NOT_REGISTERED` for the private or uninstalled nodes.

You can validate the structural integrity and parse the workflow using the CLI:

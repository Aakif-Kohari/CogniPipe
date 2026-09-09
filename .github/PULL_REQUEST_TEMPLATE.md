## Description

<!-- What does this PR do? Be specific. -->

> **Note on CodeRabbit:** This repo uses CodeRabbit for automated review
> comments. Its suggestions are helpful but **not always correct** — some
> are false positives. Use your own judgment on whether a suggestion applies.
> If you're unsure whether to apply one, leave it as-is and a maintainer
> will weigh in during review rather than guessing.

## Related Issue

<!-- Required. PRs without a linked issue will not be reviewed. -->

Closes #

## Type of Change

- [ ] 🐛 Bug fix (non-breaking)
- [ ] ✨ New feature (non-breaking)
- [ ] 🔌 New node package
- [ ] 💥 Breaking change
- [ ] 📝 Documentation only
- [ ] 🔧 Chore / maintenance

## Testing

<!-- Describe how you tested this. -->

## Checklist

**Every PR:**

- [ ] All CI checks pass locally (`pnpm test && pnpm lint && pnpm type-check`)
- [ ] Conventional commit format used for all commits
- [ ] A [changeset](https://github.com/changesets/changesets) has been added (`pnpm changeset`)

**If this adds/modifies a node:**

- [ ] Extends `BaseNode` from `@cognipipe/sdk`
- [ ] Config validated with Zod
- [ ] No real API calls in tests (all mocked)
- [ ] `README.md` updated/created for this node
- [ ] Coverage is ≥ 80%

**If this touches `packages/core` or `packages/sdk`:**

- [ ] Coverage is ≥ 90%
- [ ] No public API breaking changes (or breaking change checkbox above is ticked)
- [ ] TypeDoc comments added for any new public exports

## Screenshots / Output

<!-- Optional but strongly encouraged for CLI changes or visual output -->

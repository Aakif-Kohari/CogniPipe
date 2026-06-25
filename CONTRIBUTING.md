# Contributing to CogniPipe

Thank you for investing your time! All contributions are valued.

---

## Table of Contents
1. [Before You Start](#before-you-start)
2. [Setting Up the Repo](#setting-up-the-repo)
3. [Project Structure](#project-structure)
4. [The 48-Hour Assignment Rule](#the-48-hour-assignment-rule)
5. [Making a Contribution](#making-a-contribution)
6. [Building a New Node](#building-a-new-node)    ← most common contribution
7. [Testing Requirements](#testing-requirements)
8. [Commit & Branch Conventions](#commit--branch-conventions)
9. [PR Process](#pr-process)
10. [Code Style](#code-style)

---

## Before You Start

- Browse [open issues](../../issues?q=is%3Aissue+is%3Aopen+no%3Aassignee)
- Comment `.take` on the issue you want - the bot will assign you automatically
- Read this entire file before opening a PR

---

## Setting Up the Repo

**Prerequisites:** Node.js >= 18, pnpm >= 9, git

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/cognipipe.git
cd cognipipe

# 3. Install all dependencies
pnpm install

# 4. Build dependency packages
pnpm turbo build --filter=@cognipipe/types --filter=@cognipipe/sdk

# 5. Verify everything works
pnpm test
pnpm lint
pnpm type-check
```

---

## The 48-Hour Assignment Rule

When you claim an issue, you have **48 hours** to link a Draft PR or commit.
- Request an extension by replying on the issue - always granted for genuine effort.
- No response - automatic unassignment so others can contribute.

---

## Building a New Node

Every node lives in `nodes/node-<service>/` and must follow this structure:

```
nodes/node-myservice/
├── src/
│   ├── MyServiceNode.ts    ← extends BaseNode
│   └── index.ts            ← named export only
├── __tests__/
│   └── MyServiceNode.test.ts
├── package.json            ← name: @cognipipe/node-myservice
├── tsconfig.json           ← extends ../../tsconfig.base.json
└── README.md               ← REQUIRED: documents all config options
```

**Non-negotiable requirements for node PRs:**
- [ ] Extends `BaseNode` from `@cognipipe/sdk`
- [ ] Uses the `@CogniNode()` decorator with unique `type` string
- [ ] Config validated with Zod (use `NodeConfig.define()`)
- [ ] Zero real API calls in tests (mock everything)
- [ ] `README.md` documents every config field
- [ ] `__tests__/` has ≥ 80% coverage

---

## Testing Requirements

| Scope | Tool | Min Coverage |
|-------|------|-------------|
| `packages/core` | Jest | 90% |
| `packages/sdk` | Jest | 90% |
| `nodes/*` | Jest | 80% |
| `apps/cli` | Jest | 70% |

- **Run tests:** `pnpm test`
- **Run specific package:** `pnpm --filter @cognipipe/core test`
- **Watch mode:** `pnpm --filter @cognipipe/core test -- --watch`

No PR will be merged if any test fails or coverage drops below the threshold.

---

## Commit & Branch Conventions

**Branch naming:**
```
feat/node-anthropic
fix/executor-parallel-deadlock
docs/node-development-guide
chore/update-eslint-config
```

**Commit messages (Conventional Commits):**
```
feat(node-openai): add embedding node with vector output
fix(core): resolve context interpolation for nested paths
docs(contributing): add node testing requirements section
chore(deps): update zod to 3.23.8
```

---

## PR Process

1. All CI checks must pass (lint, type-check, tests, build)
2. PR description must use the template - do not delete sections
3. Link the issue with `Closes #<number>` in the PR body
4. Add a changeset: `pnpm changeset` and follow the prompts
5. A maintainer will review within 72 hours on weekdays

**Merging is strictly manual.** The maintainer merges - never self-merge.

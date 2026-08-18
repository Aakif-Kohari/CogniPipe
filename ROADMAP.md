# CogniPipe Roadmap

> This is a living document. Items may shift based on community feedback.

## ✅ Phase 0 — Foundation

- [x] Monorepo scaffold (Turborepo + pnpm workspaces)
- [x] GitHub Actions: auto-assignment, 48-hour rule, CI, release, label-sync
- [x] Community documentation and issue templates
- [x] `@cognipipe/types` — shared TypeScript types _(Published to npm)_
- [x] `@cognipipe/sdk` — BaseNode class + decorators _(Published to npm)_
- [x] `@cognipipe/core` — WorkflowParser, WorkflowValidator, WorkflowExecutor _(Published to npm)_
- [x] `@cognipipe/node-http` — generic HTTP node _(Published to npm)_
- [ ] `@cognipipe/node-openai` — OpenAI integration _(Stub)_
- [x] `cognipipe` CLI — run, init, test commands _(Published to npm)_

## 🔄 Phase 1 — Node Ecosystem

- [ ] `@cognipipe/node-anthropic`
- [ ] `@cognipipe/node-slack`
- [ ] `@cognipipe/node-github`
- [ ] `@cognipipe/node-transform`
- [ ] Parallel node execution (DAG)
- [x] Retry logic with exponential backoff _(Shipped in `@cognipipe/core`)_
- [x] Context variable interpolation _(Shipped in `@cognipipe/core`)_

## 🔮 Phase 2 — Developer Experience

- [ ] `cognipipe init` interactive scaffolder
- [ ] `cognipipe install` node package manager
- [ ] Docusaurus documentation site
- [ ] `@cognipipe/testing` — test utilities for node authors
- [ ] VS Code extension (syntax highlighting for workflow.yaml)

## 🌍 Phase 3 — Community & Scale

- [ ] Public node registry
- [ ] Workflow templates marketplace
- [ ] `@cognipipe/node-webhook` — inbound webhook trigger
- [ ] Scheduled workflow execution
- [ ] Web dashboard (optional, React-based)

---

_Have an idea? Open a [discussion](../../discussions/categories/ideas)._

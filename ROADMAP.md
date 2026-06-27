# CogniPipe Roadmap

> This is a living document. Items may shift based on community feedback.

## ✅ Phase 0 — Foundation

- [x] Monorepo scaffold (Turborepo + pnpm)
- [ ] `@cognipipe/types` — shared TypeScript types
- [ ] `@cognipipe/sdk` — BaseNode class + decorators
- [ ] `@cognipipe/core` — WorkflowParser, WorkflowValidator, WorkflowExecutor
- [ ] `@cognipipe/node-http` — generic HTTP node
- [ ] `@cognipipe/node-openai` — OpenAI integration
- [ ] `cognipipe` CLI — run, init, test commands

## 🔄 Phase 1 — Node Ecosystem

- [ ] `@cognipipe/node-anthropic`
- [ ] `@cognipipe/node-slack`
- [ ] `@cognipipe/node-github`
- [ ] `@cognipipe/node-transform`
- [ ] Parallel node execution (DAG)
- [ ] Retry logic with exponential backoff
- [ ] Context variable interpolation

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

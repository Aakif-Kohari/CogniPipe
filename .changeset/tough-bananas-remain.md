---
'@cognipipe/types': minor
---

Adds comprehensive JSDoc documentation to every exported symbol in`packages/types/src/`. Before this PR, contributors implementing`WorkflowExecutor`, `WorkflowValidator`, or any new node package had noinline hover documentation — they had to read raw TypeScript and guessintent. After this PR, every IDE user across the monorepo gets accuratedocumentation on every interface, type, and field immediately.This is a **documentation-only change** — no runtime behaviour, no newexports, no dependencies added.

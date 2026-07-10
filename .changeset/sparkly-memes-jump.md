---
'@cognipipe/core': patch
---

Add a CommonJS build ('dist/cjs') alongside the existing ESM build, with a 'require' condition in 'exports'. '@cognipipe/core''s 'package.json' previously only exported an 'import' condition, so any consumer using CommonJS-style 'require()' — including Jest tests compiled by 'ts-jest' to CommonJS — failed to resolve the package. '@cognipipe/sdk''s new 'BaseNode' (added in this PR) is the first in-repo consumer to hit this via a real runtime import.

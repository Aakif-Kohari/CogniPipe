---
'@cognipipe/core': minor
'@cognipipe/node-http': patch
'@cognipipe/sdk': patch
'@cognipipe/types': patch
'cognipipe': patch
---

**Breaking (minor while pre-1.0):** `@cognipipe/core` now rejects duplicate step names and dangling `dependsOn` references at validation time, and interpolation inserts objects/arrays as JSON (previously `"[object Object]"` / comma-joined values).

Also: add READMEs, LICENSE files and npm metadata (homepage, bugs, keywords) so package pages render on npm. core/cli: fix quadratic memory use in cycle detection. node-http: enforce http(s) URLs and correct README examples and error documentation.

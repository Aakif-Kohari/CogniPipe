---
'@cognipipe/core': minor
'@cognipipe/node-http': patch
'@cognipipe/sdk': patch
'@cognipipe/types': patch
'cognipipe': patch
---

Add READMEs, LICENSE files and npm metadata (homepage, bugs, keywords) so package pages render on npm. core: validate duplicate step names and dangling dependsOn references at validation time, serialize object/array interpolation values as JSON instead of "[object Object]", and fix quadratic memory use in cycle detection. cli: same cycle-detection fix. node-http: enforce http(s) URLs and correct README examples and error documentation.

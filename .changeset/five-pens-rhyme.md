---
'@cognipipe/core': patch
---

Fix `WorkflowExecutor` config interpolation replacing non-plain objects with `{}`. A `Date`, `Map`, `Set`, typed array or class instance in a step's config now reaches the node unchanged, by reference, instead of being rebuilt from its (empty) enumerable entries. Only plain objects and arrays are walked. This affects programmatically-built configs and YAML loaded with a schema that produces non-plain values (e.g. js-yaml's `YAML11_SCHEMA`).

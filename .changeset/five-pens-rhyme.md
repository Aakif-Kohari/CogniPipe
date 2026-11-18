---
'@cognipipe/core': patch
---

Fix `WorkflowExecutor` config interpolation mangling non-plain objects. A `Date`, `Map`, `Set`, `RegExp`, typed array or class instance in a step's config used to be rebuilt as a plain object from its own enumerable entries (empty for a `Date`, `Map`, `Set` or `RegExp`, index keys for a typed array), losing its prototype and methods. It now reaches the node unchanged, by reference. Only plain objects and arrays are walked, so `{{ }}` tokens inside a non-plain object's own fields are no longer interpolated: move token-bearing fields into a plain config object, or resolve them before constructing the instance. This affects configs built in code and YAML parsed with a schema that yields non-plain values (e.g. js-yaml's `YAML11_SCHEMA`, which parses timestamps as `Date`; the default schema leaves them as strings).

---
'@cognipipe/sdk': minor
---

Add '@CogniNode()' class decorator. Validates 'type' (non-empty) and 'version' (strict semver) at decoration time, throws 'CogniPipeError(NODE_INSTANTIATION_FAILED)' on bad input, attaches 'cogniNodeMeta' to class statically.

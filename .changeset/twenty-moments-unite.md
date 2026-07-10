---
'@cognipipe/types': minor
'@cognipipe/sdk': minor
---

Add 'BaseNode' abstract class to '@cognipipe/sdk' and the 'IBaseNode'/'CogniNodeMeta' contract to '@cognipipe/types'.

Every node package under 'nodes/*' can now extend 'BaseNode' and implement 'execute()', with optional 'beforeExecute'/'afterExecute' lifecycle hooks. The protected 'validateConfig()' helper wraps Zod's '.safeParse()' and throws a consistent 'CogniPipeError(NODE_CONFIG_INVALID)' instead of a raw 'ZodError', matching 'WorkflowValidator''s existing error-formatting convention.

'IBaseNode' lives in '@cognipipe/types' (not '@cognipipe/sdk') so '@cognipipe/core''s future 'NodeRegistry' can type-check node instances without creating a circular 'types ← core ← sdk ← core' dependency.

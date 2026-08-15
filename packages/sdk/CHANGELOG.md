# @cognipipe/sdk

## 0.1.0

### Minor Changes

- 422e723: Add '@CogniNode()' class decorator. Validates 'type' (non-empty) and 'version' (strict semver) at decoration time, throws 'CogniPipeError(NODE_INSTANTIATION_FAILED)' on bad input, attaches 'cogniNodeMeta' to class statically.
- d4303da: Add defineConfig() factory for declaring reusable Zod-backed config parsers at node class scope.
- 8ed1c97: Add 'BaseNode' abstract class to '@cognipipe/sdk' and the 'IBaseNode'/'CogniNodeMeta' contract to '@cognipipe/types'.

  Every node package under 'nodes/*' can now extend 'BaseNode' and implement 'execute()', with optional 'beforeExecute'/'afterExecute' lifecycle hooks. The protected 'validateConfig()' helper wraps Zod's '.safeParse()' and throws a consistent 'CogniPipeError(NODE_CONFIG_INVALID)' instead of a raw 'ZodError', matching 'WorkflowValidator''s existing error-formatting convention.

  'IBaseNode' lives in '@cognipipe/types' (not '@cognipipe/sdk') so '@cognipipe/core''s future 'NodeRegistry' can type-check node instances without creating a circular 'types ← core ← sdk ← core' dependency.

### Patch Changes

- 7c76492: add "type": "module" for ESM consistency
- 30d678e: Scaffold the '@cognipipe/sdk' package by adding TypeScript and Jest configuration, package scripts, and an initial public API barrel. This prepares the package for upcoming SDK implementations such as 'BaseNode' and '@CogniNode()'.
- 5a956ab: Add engines field declaring Node.js >=22.0.0 and pnpm >=9.0.0 requirements to match root package.json
- d28df2f: Fix ERR_MODULE_NOT_FOUND when consuming compiled ESM output under Node's native module loader. Relative imports across all packages were missing explicit .js extensions — TypeScript's `bundler` moduleResolution compiled these without error, but Node's native ESM resolver requires an exact extension on every relative specifier and has no fallback. Jest's more lenient resolver masked this in every test run, so it was never caught until a real `node dist/index.js` invocation surfaced it. Fixed by adding .js extensions to all relative imports and adding a `moduleNameMapper` to each ESM-mode/CJS-transform Jest config so `ts-jest` can still resolve the real .ts source files despite the literal .js specifiers.
- 44adfa0: Configured OIDC trusted publishing infrastructure

  - Bump pnpm to v10.34.5 and pin Node to v22.14.0 across CI and .nvmrc
  - Add publishConfig.access and files field to all publishable packages
  - Mark stub node packages as private to prevent accidental publishing
  - Update release.yml to use OIDC id-token auth instead of NPM_TOKEN
  - Force npm CLI upgrade in CI to fix known OIDC fallback bug

- 87a448d: Add @cognipipe/node-http: generic HTTP request node supporting GET, POST, PUT, DELETE, and PATCH with configurable headers, body, and timeout. Uses Node.js 22's built-in fetch.
  Fix @cognipipe/sdk: add dual ESM/CJS build (matching @cognipipe/core) so the package resolves correctly under CommonJS test/build tooling.
- Updated dependencies [0cdaffc]
- Updated dependencies [35fe8b6]
- Updated dependencies [b46a784]
- Updated dependencies [7c76492]
- Updated dependencies [52aeea5]
- Updated dependencies [5c2b7a8]
- Updated dependencies [d3b0a0a]
- Updated dependencies [74f9a19]
- Updated dependencies [b98eacb]
- Updated dependencies [5a956ab]
- Updated dependencies [b239f6b]
- Updated dependencies [31e1750]
- Updated dependencies [d28df2f]
- Updated dependencies [44adfa0]
- Updated dependencies [8ed1c97]
- Updated dependencies [15ed5ed]
- Updated dependencies [7e35b4c]
- Updated dependencies [ab19f15]
- Updated dependencies [8ed1c97]
- Updated dependencies [41e4c4a]
  - @cognipipe/core@0.1.0
  - @cognipipe/types@0.1.0

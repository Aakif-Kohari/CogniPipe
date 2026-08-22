# @cognipipe/node-http

## 0.1.1

### Patch Changes

- 10292ff: Add integration coverage for complete HTTP request and response cycles.

## 0.1.0

### Minor Changes

- 87a448d: Add @cognipipe/node-http: generic HTTP request node supporting GET, POST, PUT, DELETE, and PATCH with configurable headers, body, and timeout. Uses Node.js 22's built-in fetch.
  Fix @cognipipe/sdk: add dual ESM/CJS build (matching @cognipipe/core) so the package resolves correctly under CommonJS test/build tooling.

### Patch Changes

- 7c76492: add "type": "module" for ESM consistency
- 5a956ab: Add engines field declaring Node.js >=22.0.0 and pnpm >=9.0.0 requirements to match root package.json
- d28df2f: Fix ERR_MODULE_NOT_FOUND when consuming compiled ESM output under Node's native module loader. Relative imports across all packages were missing explicit .js extensions — TypeScript's `bundler` moduleResolution compiled these without error, but Node's native ESM resolver requires an exact extension on every relative specifier and has no fallback. Jest's more lenient resolver masked this in every test run, so it was never caught until a real `node dist/index.js` invocation surfaced it. Fixed by adding .js extensions to all relative imports and adding a `moduleNameMapper` to each ESM-mode/CJS-transform Jest config so `ts-jest` can still resolve the real .ts source files despite the literal .js specifiers.
- 44adfa0: Configured OIDC trusted publishing infrastructure

  - Bump pnpm to v10.34.5 and pin Node to v22.14.0 across CI and .nvmrc
  - Add publishConfig.access and files field to all publishable packages
  - Mark stub node packages as private to prevent accidental publishing
  - Update release.yml to use OIDC id-token auth instead of NPM_TOKEN
  - Force npm CLI upgrade in CI to fix known OIDC fallback bug

- Updated dependencies [0cdaffc]
- Updated dependencies [422e723]
- Updated dependencies [35fe8b6]
- Updated dependencies [b46a784]
- Updated dependencies [7c76492]
- Updated dependencies [52aeea5]
- Updated dependencies [5c2b7a8]
- Updated dependencies [d3b0a0a]
- Updated dependencies [30d678e]
- Updated dependencies [74f9a19]
- Updated dependencies [b98eacb]
- Updated dependencies [5a956ab]
- Updated dependencies [b239f6b]
- Updated dependencies [31e1750]
- Updated dependencies [d28df2f]
- Updated dependencies [44adfa0]
- Updated dependencies [87a448d]
- Updated dependencies [d4303da]
- Updated dependencies [8ed1c97]
- Updated dependencies [15ed5ed]
- Updated dependencies [7e35b4c]
- Updated dependencies [ab19f15]
- Updated dependencies [8ed1c97]
- Updated dependencies [41e4c4a]
  - @cognipipe/core@0.1.0
  - @cognipipe/sdk@0.1.0
  - @cognipipe/types@0.1.0

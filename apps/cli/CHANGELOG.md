# cognipipe

## 0.1.0

### Minor Changes

- b2aaac4: Add 'cognipipe run' command with dynamic node discovery.
- d28df2f: Add cognipipe test command with DAG cycle detection and execution preview
- 5b99143: Bootstraps the CLI package from scratch (package.json, tsconfig, jest config, entry point) and implements the --version / -v flag, reading version from package.json at runtime via createRequire. Uses ESM-mode Jest (via cross-env + --experimental-vm-modules) since import.meta.url requires real ESM, unlike the CommonJS ts-jest pattern used in packages/core.

### Patch Changes

- d28df2f: Fix ERR_MODULE_NOT_FOUND when consuming compiled ESM output under Node's native module loader. Relative imports across all packages were missing explicit .js extensions — TypeScript's `bundler` moduleResolution compiled these without error, but Node's native ESM resolver requires an exact extension on every relative specifier and has no fallback. Jest's more lenient resolver masked this in every test run, so it was never caught until a real `node dist/index.js` invocation surfaced it. Fixed by adding .js extensions to all relative imports and adding a `moduleNameMapper` to each ESM-mode/CJS-transform Jest config so `ts-jest` can still resolve the real .ts source files despite the literal .js specifiers.
- 44adfa0: Configured OIDC trusted publishing infrastructure

  - Bump pnpm to v10.34.5 and pin Node to v22.14.0 across CI and .nvmrc
  - Add publishConfig.access and files field to all publishable packages
  - Mark stub node packages as private to prevent accidental publishing
  - Update release.yml to use OIDC id-token auth instead of NPM_TOKEN
  - Force npm CLI upgrade in CI to fix known OIDC fallback bug

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

---
'cognipipe': minor
---

Bootstraps the CLI package from scratch (package.json, tsconfig, jest config, entry point) and implements the --version / -v flag, reading version from package.json at runtime via createRequire. Uses ESM-mode Jest (via cross-env + --experimental-vm-modules) since import.meta.url requires real ESM, unlike the CommonJS ts-jest pattern used in packages/core.

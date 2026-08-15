---
'@cognipipe/node-anthropic': patch
'@cognipipe/node-transform': patch
'@cognipipe/node-github': patch
'@cognipipe/node-openai': patch
'@cognipipe/node-slack': patch
'@cognipipe/testing': patch
'@cognipipe/node-http': patch
'@cognipipe/types': patch
'@cognipipe/core': patch
'@cognipipe/sdk': patch
'cognipipe': patch
---

Configured OIDC trusted publishing infrastructure

- Bump pnpm to v10.34.5 and pin Node to v22.14.0 across CI and .nvmrc
- Add publishConfig.access and files field to all publishable packages
- Mark stub node packages as private to prevent accidental publishing
- Update release.yml to use OIDC id-token auth instead of NPM_TOKEN
- Force npm CLI upgrade in CI to fix known OIDC fallback bug

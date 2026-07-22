---
'@cognipipe/node-http': minor
'@cognipipe/sdk': patch
---

Add @cognipipe/node-http: generic HTTP request node supporting GET, POST, PUT, DELETE, and PATCH with configurable headers, body, and timeout. Uses Node.js 22's built-in fetch.
Fix @cognipipe/sdk: add dual ESM/CJS build (matching @cognipipe/core) so the package resolves correctly under CommonJS test/build tooling.

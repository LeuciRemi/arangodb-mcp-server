# Changelog

All notable changes to this project are documented here.

## Unreleased

- Validate document selectors before HTTP requests to prevent collection-policy bypasses through path traversal.
- Honor cancellation before write-query commit, preserve write results across page boundaries, and count in-flight continuations toward cursor capacity.
- Apply request timeouts to all ArangoDB connections and include the runtime dependency required for HTTPS.
- Decode resource URI variables safely, bound MCP error responses, and clean up sessions when the client closes stdin.
- Correct the development Dockerfile health check and expand regression, TLS, package, and CI validation.
- Refresh production dependencies with published security fixes.
- Update MCP SDK to 1.32.1, arangojs to 10.6.0, Undici to 6.29.1 and Zod to 4.6.7; refresh compatible transitives, including proxy-addr 2.0.8.
- Pin the disposable development/integration database to ArangoDB 3.12.12 and run CI for develop pushes.
- Keep the oversized SDK validation-error regression effective when array-length checks short-circuit per-item validation; preserve the byte limit, truncation and no-callback assertions.
- Production-only npm audit is clean for this update. The development-only braces advisory remains through nodemon/shx; no forced downgrade or audit suppression is applied.

## 2.0.0

- **Breaking:** return structured, paginated envelopes; clients should prefer `structuredContent`, while the text content retains a compact JSON fallback for compatibility with clients that do not expose structured results.
- **Breaking:** replace the combined write profile with separate document CRUD and arbitrary AQL capabilities. The legacy `ARANGO_ENABLE_WRITE` alias now enables document CRUD only.
- Enforce read-only AQL with optimizer-plan validation and transactions using `allowImplicit: false`.
- Run `readWriteQuery` in a strict transaction with separately declared read and write collections.
- Commit write queries before returning their first page, buffer all returned rows in a private size-bounded spool, and roll back when the spool limit is exceeded.
- Add bounded cursor pagination, bind variables, timeouts, memory limits, and response budgets.
- Enforce response budgets across complete serialized MCP tool envelopes and resources.
- Reserve cursor capacity atomically and scope metadata pagination cursors.
- Add structured MCP outputs, output schemas, risk annotations, completions, and an exploration prompt.
- Add collection metadata, query explanation, explicit sampling, health, and revision-safe document tools.
- Keep the default MCP surface minimal and expose `explainQuery` and
  `healthCheck` only when diagnostic tools are explicitly enabled.
- Add environment-based secrets, database and collection allowlists, and HTTPS CA configuration.
- Pin the development database to ArangoDB 3.12 and correct its authenticated health check.
- Test direct, bind-collection, `DOCUMENT()`, traversal, and graph allowlist boundaries.
- Test all AQL modification forms, cursor expiration, oversized write results, write-spool rollback, and a dedicated read-only ArangoDB user.
- Add unit, MCP contract, Docker integration, CI, security, and installed-tarball packaging validation.

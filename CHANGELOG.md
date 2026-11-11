# Changelog

All notable changes to this project are documented here.

## 3.0.0

- **Breaking:** remove `bytes`, empty `warnings`, and unrequested `stats` from query pages. `readQuery` and `readWriteQuery` accept `includeStats`; streamed reads report statistics only when the whole result fits the first page, while `readWriteQuery` reports them on its first page and always returns `writesExecuted` and `writesIgnored` there.
- **Breaking:** return `listDatabases` as `{ databases: string[], totalDatabases, nextCursor? }`, without `{ name }` wrappers or `truncated`.
- **Breaking:** return `listCollections` entries as `{ name, type, count? }` with `document`/`edge` types and document counts for the returned page, dropping numeric type, status, `isSystem`, and `truncated`.
- **Breaking:** return `describeCollection` as a flat compact object; add a `verbose` input for raw properties and index objects. The collection resource returns the same compact object.
- **Breaking:** derive the database allowlist from collection allowlist entries, so databases without an allowlisted collection are neither listed nor queryable.
- Add `listGraphs`, `listViews`, and `inferSchema` to the default read-only profile. Graph and view definitions that reach a non-allowlisted collection are hidden, and schema inference is one aggregated AQL query that keeps document values inside ArangoDB.
- Replace long tool descriptions, server instructions, and the `exploreDatabase` prompt with a short metadata-first flow: databases, collections, description or inferred schema, then AQL with bind variables.
- Update the MCP SDK to 2.4.0 and Undici to 8.12.4. Replace nodemon with a `tsc --watch` development loop (`dev/dev.mjs`), which removes the last development-only npm audit advisories.
- List databases through `/_api/database/user` and report health from a visible database, so a least-privilege user without access to `_system` can list databases, run `healthCheck`, and query its own database.
- Ignore allowlist entries for collections that do not exist instead of declaring them in the transaction, so one stale entry no longer fails every query in that database.
- Allow querying ArangoSearch and `search-alias` views: views are authorised through their linked collections, excluded from transaction declarations and `explainQuery` collections, and reported separately as `views`.
- Stop sending `returnNew`/`returnOld` for document CRUD because the returned documents were discarded.
- Append a leading `WITH` hint to ArangoDB error 1652 and state the requirement in the server instructions.
- Preserve the original URL scheme when redacting credentials from error messages.
- Derive the default request timeout from `ARANGO_MCP_MAX_RUNTIME` plus 5000 ms instead of a fixed 35000 ms; an explicit `ARANGO_MCP_REQUEST_TIMEOUT` or `--request-timeout` still takes precedence.
- **Breaking:** require Node.js 22.19 or newer (Undici 8 and MCP Inspector 2 minimum; Node.js 20 is end-of-life). CI now tests Node.js 22, 24 and 26 and runs integration on Node.js 24 LTS.
- Migrate from `@modelcontextprotocol/sdk` 1.32 to the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.3.1; `@modelcontextprotocol/client` 2.3.1 for tests): tool and prompt schemas are now Zod object schemas, `McpError` becomes `ProtocolError`, and handlers read cancellation from `ctx.mcpReq.signal`.
- SDK v2 reports unknown tools as JSON-RPC errors (`-32602`) instead of `isError` tool results; the transport boundary now also redacts and size-bounds JSON-RPC error responses, dropping oversized error data first.
- Update Undici to 8.12.3 and keep arangojs 10.6.0, Zod 4.6.7, TypeScript 7.0.2 and shx 0.4.0 (already the latest majors). Drop the `@hono/node-server` and `fast-uri` overrides, which only applied to SDK v1 transitive dependencies.
- Update the development MCP Inspector to 2.12.0, passing its server environment with `-e`; update GitHub Actions to `actions/checkout@v7` and `actions/setup-node@v7`, and pin `shell.nix` to `nodejs_24`.

- Validate document selectors before HTTP requests to prevent collection-policy bypasses through path traversal.
- Honor cancellation before write-query commit, preserve write results across page boundaries, and count in-flight continuations toward cursor capacity.
- Apply request timeouts to all ArangoDB connections and include the runtime dependency required for HTTPS.
- Decode resource URI variables safely, bound MCP error responses, and clean up sessions when the client closes stdin.
- Correct the development Dockerfile health check and expand regression, TLS, package, and CI validation.
- Refresh production dependencies with published security fixes.
- Update MCP SDK to 1.32.1, arangojs to 10.6.0, Undici to 6.29.1 and Zod to 4.6.7; refresh compatible transitives, including proxy-addr 2.0.8.
- Pin the disposable development/integration database to ArangoDB 3.12.12 and run CI for develop pushes.
- Keep the oversized SDK validation-error regression effective when array-length checks short-circuit per-item validation; preserve the byte limit, truncation and no-callback assertions.
- Production-only npm audit is clean for this update.

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

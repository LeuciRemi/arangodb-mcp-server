# ArangoDB MCP Server

A safe, bounded [Model Context Protocol](https://modelcontextprotocol.io/) server for exploring and querying ArangoDB databases.

The server is metadata-first and read-only by default. It supports multiple databases, AQL bind variables, optimizer plans, structured MCP output, graph and view discovery, in-database schema inference, explicit document sampling, and cursor-based result pagination.

## Safety model

- `readQuery` is executed inside an ArangoDB transaction with no write collections and `allowImplicit: false`.
- ArangoDB's optimizer plan is checked before execution; modification queries are rejected.
- Allowed collections are explicitly declared to transactions, so dynamic reads cannot escape the configured allowlist.
- Collections reached only at runtime (`DOCUMENT()`, anonymous graph traversals) are absent from the optimizer plan; declare them in a leading `WITH` statement, otherwise ArangoDB fails with error 1652.
- Allowlist entries for collections that do not exist are ignored instead of being declared, so a stale entry cannot fail every query in that database.
- ArangoSearch (`arangosearch`) and `search-alias` views are queryable. A view is authorised through the collections it links, which must all be allowlisted. Queries run inside a stream transaction, so `OPTIONS { waitForSync: true }` is unavailable and freshly written documents become visible only once the view has indexed them.
- `listGraphs` and `listViews` hide definitions that reach a collection outside the allowlist, and `inferSchema` runs as one aggregated read-only AQL query, so no document values leave ArangoDB.
- Query time, memory, row count, serialized response size, buffered write-result size, cursor TTL, and active cursor count are capped.
- Revision-safe document CRUD and arbitrary write-capable AQL are separate opt-in capabilities.
- Database and collection allowlists can further restrict the ArangoDB user's permissions. Configuring a collection allowlist also restricts the server to the databases those entries belong to.
- Queries and bind values are not written to logs.

Use a dedicated ArangoDB user with **Read Only** collection permissions for the strongest database-side guarantee. Enabling the write tool does not grant permissions that the configured ArangoDB user does not already have.

## Tools

| Tool | Purpose | Default risk |
| --- | --- | --- |
| `listDatabases` | List allowed databases as a string array | Read-only |
| `listCollections` | List collection names, `document`/`edge` types, and document counts | Read-only |
| `describeCollection` | Describe type, count, schema, computed values, and indexes; `verbose` adds raw properties and indexes | Read-only |
| `inferSchema` | Infer field paths and per-type counts from the first N documents in storage order | Read-only |
| `listGraphs` | List graphs with edge definitions and orphan collections | Read-only |
| `listViews` | List ArangoSearch and search-alias views with read collections and compact links | Read-only |
| `sampleDocuments` | Explicitly sample up to 20 documents with field projection | Read-only |
| `explainQuery` | Validate and summarize a read-only AQL optimizer plan | Diagnostic opt-in |
| `readQuery` | Execute bounded AQL in a read-only transaction; `includeStats` adds statistics when the whole result fits the first page | Read-only |
| `continueQuery` | Consume the next page from an opaque cursor | Read-only |
| `healthCheck` | Report connectivity, version, policy, and limits | Diagnostic opt-in |
| `insertDocument` | Insert one bounded document | Document-write opt-in |
| `updateDocument` | Patch a document with mandatory `_rev` conflict protection | Document-write opt-in |
| `deleteDocument` | Delete a document with mandatory `_rev` conflict protection | Document-write opt-in |
| `readWriteQuery` | Execute arbitrary write-capable AQL and report `writesExecuted`/`writesIgnored` | Separate higher-privilege opt-in |

All tools provide MCP `outputSchema`, `structuredContent`, text fallback content, and risk annotations.

Document tools accept a document key or a `collection/key` identifier whose collection
matches `collectionName`. Path separators inside keys, traversal segments, and URL
query or fragment syntax are rejected before a request reaches ArangoDB.

The default minimal profile exposes nine tools: `listDatabases`, `listCollections`,
`describeCollection`, `inferSchema`, `listGraphs`, `listViews`, `sampleDocuments`,
`readQuery`, and `continueQuery`.
Set `ARANGO_ENABLE_DIAGNOSTIC_TOOLS=true` (or pass
`--enable-diagnostic-tools`) to additionally expose `explainQuery` and
`healthCheck`.

## Resources and prompt

Two application-controlled resource templates are exposed:

- `arangodb:///{database}/{collection}` returns the same compact collection object as a non-verbose `describeCollection` call, without document samples.
- `arangodb:///{database}/{collection}/{documentId}` returns one explicitly addressed document.

Database and collection template variables support MCP completion. Collections and documents are intentionally not enumerated through `resources/list`; the bounded listing tools should be used instead.

The `exploreDatabase` prompt guides clients through a metadata-first, bounded exploration.

## Installation from source

The package is prepared for npm publication but is not currently available from the public npm registry.

```sh
git clone https://github.com/LeuciRemi/arangodb-mcp-server.git
cd arangodb-mcp-server
npm ci
npm run build
```

Configure the compiled server in your MCP client. Prefer the `env` block instead of positional credentials so the password is not exposed in the process list:

```json
{
  "mcpServers": {
    "arangodb": {
      "command": "node",
      "args": ["/absolute/path/to/arangodb-mcp-server/dist/index.js"],
      "env": {
        "ARANGO_URL": "http://127.0.0.1:8529",
        "ARANGO_USERNAME": "mcp_reader",
        "ARANGO_PASSWORD": "replace-me",
        "ARANGO_ALLOWED_DATABASES": "analytics",
        "ARANGO_ALLOWED_COLLECTIONS": "analytics/events,analytics/accounts"
      }
    }
  }
}
```

The legacy positional form remains supported for compatibility:

```sh
arangodb-mcp-server http://127.0.0.1:8529 username password
```

It emits a warning because CLI secrets may be visible to other local processes.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ARANGO_URL` | Required | ArangoDB HTTP or HTTPS base URL |
| `ARANGO_USERNAME` | None | Basic-auth username |
| `ARANGO_PASSWORD` | Empty | Basic-auth password |
| `ARANGO_ENABLE_DOCUMENT_WRITES` | `false` | Register revision-safe document CRUD |
| `ARANGO_ENABLE_READ_WRITE_QUERY` | `false` | Register arbitrary write-capable AQL (higher privilege) |
| `ARANGO_ENABLE_WRITE` | `false` | Deprecated alias enabling document CRUD only |
| `ARANGO_ENABLE_DIAGNOSTIC_TOOLS` | `false` | Register `explainQuery` and `healthCheck` |
| `ARANGO_ALLOWED_DATABASES` | User-visible databases | Comma-separated database allowlist; narrowed to the databases used by `ARANGO_ALLOWED_COLLECTIONS` when that is set |
| `ARANGO_ALLOWED_COLLECTIONS` | User-visible collections | Comma-separated `database/collection` allowlist |
| `ARANGO_MCP_MAX_ROWS` | `100` | Maximum rows in one result page |
| `ARANGO_MCP_MAX_BYTES` | `512000` | Maximum serialized bytes in the complete MCP tool response envelope |
| `ARANGO_MCP_MAX_WRITE_SPOOL_BYTES` | `16777216` | Maximum total bytes buffered for all `readWriteQuery` results before commit |
| `ARANGO_MCP_MAX_RUNTIME` | `30` | ArangoDB query runtime limit in seconds |
| `ARANGO_MCP_MEMORY_LIMIT` | `134217728` | ArangoDB query memory limit in bytes |
| `ARANGO_MCP_REQUEST_TIMEOUT` | max runtime + 5000 | arangojs request timeout in milliseconds; defaults to `ARANGO_MCP_MAX_RUNTIME` × 1000 plus 5000 ms |
| `ARANGO_MCP_CURSOR_TTL` | `30` | Continuation cursor lifetime in seconds |
| `ARANGO_MCP_MAX_ACTIVE_CURSORS` | `32` | Maximum simultaneous cursors |
| `ARANGO_TLS_CA_FILE` | None | PEM CA file for HTTPS connections |
| `ARANGO_TLS_REJECT_UNAUTHORIZED` | `true` | Verify the HTTPS server certificate; setting this to `false` permits man-in-the-middle attacks and must be limited to temporary local diagnostics |

`ARANGO_HOSTS`, `ARANGO_ROOT_USERNAME`, and `ARANGO_ROOT_PASSWORD` are accepted as compatibility aliases.

Run `node dist/index.js --help` for equivalent CLI flags. CLI values take precedence over environment values.

## Querying and pagination

Use bind variables for values and collection names:

```json
{
  "databaseName": "analytics",
  "aql": "FOR doc IN @@collection FILTER doc.status == @status SORT doc._key RETURN KEEP(doc, ['_key', 'status'])",
  "bindVars": {
    "@collection": "events",
    "status": "open"
  },
  "pageSize": 25
}
```

A query page contains `rows`, `rowCount`, `hasMore`, `nextCursor` only when another page exists, and `warnings` only when ArangoDB reports some. `readQuery` and `readWriteQuery` add `stats` only when `includeStats: true` is set. A streamed read reports statistics only when the whole result fits the first page; a paginated read never reports them. `readWriteQuery` reports statistics on its first page and also always reports `writesExecuted` and `writesIgnored`; continuation pages do not repeat either.

When more rows are available, the result includes `hasMore: true` and an opaque `nextCursor`. Pass it to `continueQuery` before its TTL expires. Cursors are process-local and must not be persisted across server restarts.

Write-query results are fully consumed into a private temporary spool before the transaction commits, so writes never depend on a client consuming every continuation page. If the spool would exceed `ARANGO_MCP_MAX_WRITE_SPOOL_BYTES`, the cursor is closed and the transaction is rolled back before any write becomes visible. Return fewer or smaller values from write AQL, or raise the limit deliberately when larger result sets are expected.

Cancellation observed before commit rolls back a write query. Once commit has begun,
cancellation cannot guarantee rollback; a committed operation must not be retried on
the assumption that cancellation undid it. Closing the MCP client cleans up remaining
query sessions and temporary result files.

`listDatabases`, `listCollections`, `listGraphs`, and `listViews` also accept `limit` and an opaque `cursor`, and return `nextCursor` when another metadata page is available. Document counts in `listCollections` cover only the returned page. Metadata cursors are bound to their list type, database context, and current access policy.

## Least-privilege ArangoDB user

Create a dedicated account and grant read-only access at the database or collection level. For example, in `arangosh` as an administrator:

```js
const users = require("@arangodb/users");
users.save("mcp_reader", "replace-with-a-secret");
users.grantDatabase("mcp_reader", "analytics", "ro");
users.grantCollection("mcp_reader", "analytics", "events", "ro");
users.grantCollection("mcp_reader", "analytics", "accounts", "ro");
```

The account does not need any access to `_system`: `listDatabases` reads the user-visible database list, and `healthCheck` reads the version from a database the user can see. When a collection allowlist is configured, only the databases owning those entries remain visible and queryable.

Keep the database account read-only even when the MCP server's allowlists are configured; the two controls are complementary.

## Migrating from 2.x

Version 3.0 makes every read-only response more compact and adds graph, view, and schema discovery. Apply these breaking changes to any client that reads `structuredContent`:

- Query pages (`readQuery`, `continueQuery`, `readWriteQuery`, `sampleDocuments`) no longer contain `bytes`. Empty `warnings` are omitted, `stats` is returned only with `includeStats: true`, and `nextCursor` only when another page exists. `readQuery` statistics appear only when the whole result fits the first page; a paginated read never reports them. `readWriteQuery` reports statistics on its first page and always returns `writesExecuted` and `writesIgnored` there.
- `listDatabases` returns `{ databases: string[], totalDatabases, nextCursor? }`; the previous `{ name }` wrappers and `truncated` flag are gone.
- `listCollections` returns `{ databaseName, collections: [{ name, type, count? }], totalCollections, nextCursor? }`. `type` is `"document"` or `"edge"`; numeric type and status, `isSystem`, and `truncated` are gone.
- `describeCollection` returns a flat object (`type`, `documentCount`, optional `schema` and `computedValues`, and compact `indexes`). The `details` wrapper is gone. Pass `verbose: true` to add raw `properties` and `rawIndexes`. The collection resource returns the same compact object.
- A collection allowlist now also acts as a database allowlist: databases without an allowlisted collection are neither listed nor queryable.
- `inferSchema`, `listGraphs`, and `listViews` are part of the default profile. `inferSchema` scans the first N documents in storage order, not a random sample.

Upgrading from 1.x: read the 2.0.0 entry in [CHANGELOG.md](CHANGELOG.md) for the structured-envelope and split write-profile changes, then apply the changes above.

## Development

The development database is pinned to ArangoDB 3.12 and binds only to `127.0.0.1:18529`.

```sh
npm ci
npm run dev:setup
npm run dev
```

`npm run dev` builds the server, keeps `tsc --watch` running, and opens MCP Inspector 2; reconnect in the Inspector to pick up a rebuild. The packaged server and Inspector 2 both require Node.js 22.19 or newer. Inspector 2 does not forward the parent shell environment to the server, so `dev/dev.mjs` passes the disposable development credentials with `-e`; Inspector 2 may persist such `-e` values in the OS keychain or `~/.mcp-inspector/`, so never point it at real credentials this way.

The generated demo contains `ecommerce_db` and `library_db`. Tear it down with:

```sh
npm run dev:teardown
```

## Validation

```sh
npm run typecheck
npm run test:unit
npm run test:integration:docker
npm audit --omit=dev
npm run test:package
```

The Docker integration suite starts an isolated ArangoDB 3.12 container on a random loopback port, verifies strict allowlist and read-only enforcement (including a dedicated read-only database user), tests pagination and the separate write profiles, and removes the container afterward. The package smoke test installs the generated tarball in a temporary directory and executes its binary.

## Publishing

`npm pack` runs a clean build through `prepack`. A release should update the changelog/version, pass CI, and use npm provenance when the registry package is created.

## License

[MIT](LICENSE)

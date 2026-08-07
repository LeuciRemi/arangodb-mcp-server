# ArangoDB MCP Server

A safe, bounded [Model Context Protocol](https://modelcontextprotocol.io/) server for exploring and querying ArangoDB databases.

The server is schema-first and read-only by default. It supports multiple databases, AQL bind variables, optimizer plans, structured MCP output, explicit document sampling, and cursor-based result pagination.

## Safety model

- `readQuery` is executed inside an ArangoDB transaction with no write collections and `allowImplicit: false`.
- ArangoDB's optimizer plan is checked before execution; modification queries are rejected.
- Allowed collections are explicitly declared to transactions, so dynamic reads cannot escape the configured allowlist.
- Query time, memory, row count, serialized response size, buffered write-result size, cursor TTL, and active cursor count are capped.
- Revision-safe document CRUD and arbitrary write-capable AQL are separate opt-in capabilities.
- Database and collection allowlists can further restrict the ArangoDB user's permissions.
- Queries and bind values are not written to logs.

Use a dedicated ArangoDB user with **Read Only** collection permissions for the strongest database-side guarantee. Enabling the write tool does not grant permissions that the configured ArangoDB user does not already have.

## Tools

| Tool | Purpose | Default risk |
| --- | --- | --- |
| `listDatabases` | List databases visible to the user and policy | Read-only |
| `listCollections` | List non-system collections | Read-only |
| `describeCollection` | Return properties, count, JSON Schema, and indexes | Read-only |
| `sampleDocuments` | Explicitly sample up to 20 documents with field projection | Read-only |
| `explainQuery` | Validate and summarize a read-only AQL optimizer plan | Diagnostic opt-in |
| `readQuery` | Execute bounded AQL in a read-only transaction | Read-only |
| `continueQuery` | Consume the next page from an opaque cursor | Read-only |
| `healthCheck` | Report connectivity, version, policy, and limits | Diagnostic opt-in |
| `insertDocument` | Insert one bounded document | Document-write opt-in |
| `updateDocument` | Patch a document with mandatory `_rev` conflict protection | Document-write opt-in |
| `deleteDocument` | Delete a document with mandatory `_rev` conflict protection | Document-write opt-in |
| `readWriteQuery` | Execute arbitrary write-capable AQL | Separate higher-privilege opt-in |

All tools provide MCP `outputSchema`, `structuredContent`, text fallback content, and risk annotations.

The default minimal profile exposes six tools: `listDatabases`, `listCollections`,
`describeCollection`, `sampleDocuments`, `readQuery`, and `continueQuery`.
Set `ARANGO_ENABLE_DIAGNOSTIC_TOOLS=true` (or pass
`--enable-diagnostic-tools`) to additionally expose `explainQuery` and
`healthCheck`.

## Resources and prompt

Two application-controlled resource templates are exposed:

- `arangodb:///{database}/{collection}` returns collection metadata without document samples.
- `arangodb:///{database}/{collection}/{documentId}` returns one explicitly addressed document.

Database and collection template variables support MCP completion. Collections and documents are intentionally not enumerated through `resources/list`; the bounded listing tools should be used instead.

The `exploreDatabase` prompt guides clients through a schema-first, bounded exploration.

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
| `ARANGO_ALLOWED_DATABASES` | User-visible databases | Comma-separated database allowlist |
| `ARANGO_ALLOWED_COLLECTIONS` | User-visible collections | Comma-separated `database/collection` allowlist |
| `ARANGO_MCP_MAX_ROWS` | `100` | Maximum rows in one result page |
| `ARANGO_MCP_MAX_BYTES` | `512000` | Maximum serialized bytes in the complete MCP tool response envelope |
| `ARANGO_MCP_MAX_WRITE_SPOOL_BYTES` | `16777216` | Maximum total bytes buffered for all `readWriteQuery` results before commit |
| `ARANGO_MCP_MAX_RUNTIME` | `30` | ArangoDB query runtime limit in seconds |
| `ARANGO_MCP_MEMORY_LIMIT` | `134217728` | ArangoDB query memory limit in bytes |
| `ARANGO_MCP_REQUEST_TIMEOUT` | `35000` | arangojs request timeout in milliseconds |
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

When more rows are available, the result includes `hasMore: true` and an opaque `nextCursor`. Pass it to `continueQuery` before its TTL expires. Cursors are process-local and must not be persisted across server restarts.

Write-query results are fully consumed into a private temporary spool before the transaction commits, so writes never depend on a client consuming every continuation page. If the spool would exceed `ARANGO_MCP_MAX_WRITE_SPOOL_BYTES`, the cursor is closed and the transaction is rolled back before any write becomes visible. Return fewer or smaller values from write AQL, or raise the limit deliberately when larger result sets are expected.

`listDatabases` and `listCollections` also accept `limit` and an opaque `cursor`, and return `nextCursor` when another metadata page is available. Metadata cursors are bound to their list type, database context, and current access policy.

## Least-privilege ArangoDB user

Create a dedicated account and grant read-only access at the database or collection level. For example, in `arangosh` as an administrator:

```js
const users = require("@arangodb/users");
users.save("mcp_reader", "replace-with-a-secret");
users.grantDatabase("mcp_reader", "analytics", "ro");
users.grantCollection("mcp_reader", "analytics", "events", "ro");
users.grantCollection("mcp_reader", "analytics", "accounts", "ro");
```

Keep the database account read-only even when the MCP server's allowlists are configured; the two controls are complementary.

## Migrating from 1.x

Version 2.0 formalizes the structured, paginated response envelopes introduced by this branch. Clients should prefer `structuredContent` (query results are under `structuredContent.rows`; metadata lists use their named arrays and `nextCursor`). The text content also contains a compact JSON fallback for clients that do not yet expose `structuredContent` to the model.

The old `ARANGO_ENABLE_WRITE=true` setting now enables only targeted document CRUD. Set `ARANGO_ENABLE_READ_WRITE_QUERY=true` separately only when arbitrary destructive AQL is required. The complete MCP envelope, including both structured and text fallback content, remains bounded by `ARANGO_MCP_MAX_BYTES`.

## Development

The development database is pinned to ArangoDB 3.12 and binds only to `127.0.0.1:18529`.

```sh
npm ci
npm run dev:setup
npm run dev
```

The MCP Inspector used by `npm run dev` currently requires Node.js 22.7.5 or newer. The packaged server itself supports Node.js 20 and newer.

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

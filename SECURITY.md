# Security policy

## Supported versions

Security fixes are applied to the latest release on `main`.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisory feature. Do not include credentials, connection URLs, database documents, or production query text in a public issue.

Include the affected version, impact, minimal reproduction, and whether the server was configured with `ARANGO_ENABLE_DOCUMENT_WRITES` or `ARANGO_ENABLE_READ_WRITE_QUERY`.

## Deployment guidance

- Use a dedicated least-privilege ArangoDB user.
- Keep both write capabilities disabled unless the workflow explicitly requires them.
- Enable `ARANGO_ENABLE_READ_WRITE_QUERY` only for trusted workflows that require arbitrary destructive AQL; document CRUD is a lower-privilege, separate capability.
- Restrict databases and collections with both ArangoDB permissions and MCP allowlists.
- Use HTTPS with certificate verification for non-loopback connections. `ARANGO_TLS_REJECT_UNAUTHORIZED=false` disables server authentication and permits man-in-the-middle attacks; do not use it in production.
- Keep credentials in environment or secret-management facilities, not CLI arguments.
- Treat sampled documents and query results as potentially sensitive data.

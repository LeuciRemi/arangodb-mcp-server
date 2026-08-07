export interface ServerConfig {
  databaseUrl: string;
  username?: string;
  password?: string;
  enableDocumentWrites: boolean;
  enableReadWriteQuery: boolean;
  enableDiagnosticTools: boolean;
  allowedDatabases: Set<string>;
  allowedCollections: Set<string>;
  maxRows: number;
  maxBytes: number;
  maxWriteSpoolBytes: number;
  maxRuntimeSeconds: number;
  memoryLimitBytes: number;
  requestTimeoutMs: number;
  cursorTtlSeconds: number;
  maxActiveCursors: number;
  tlsCaFile?: string;
  tlsRejectUnauthorized: boolean;
  credentialsFromCli: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class HelpRequested extends Error {
  constructor() {
    super("Help requested");
    this.name = "HelpRequested";
  }
}

export const USAGE = [
  "Usage:",
  "  arangodb-mcp-server [flags] [url] [username] [password]",
  "",
  "Prefer environment variables for credentials:",
  "  ARANGO_URL, ARANGO_USERNAME, ARANGO_PASSWORD",
  "",
  "Flags:",
  "  --enable-document-writes          Expose revision-safe document CRUD",
  "  --enable-read-write-query         Expose arbitrary write-capable AQL",
  "  --enable-write                    Alias for --enable-document-writes",
  "  --enable-diagnostic-tools         Expose explainQuery and healthCheck",
  "  --allow-database=<name>           Restrict access to a database (repeatable)",
  "  --allow-collection=<db>/<name>    Restrict access to a collection (repeatable)",
  "  --max-rows=<number>               Hard row limit per result page",
  "  --max-bytes=<number>              Hard byte limit for the complete MCP response",
  "  --max-write-spool-bytes=<number>  Hard byte limit for buffered write-query results",
  "  --max-runtime=<seconds>           ArangoDB query runtime limit",
  "  --memory-limit=<bytes>            ArangoDB query memory limit",
  "  --request-timeout=<milliseconds>  Client-side request timeout",
  "  --cursor-ttl=<seconds>            Continuation cursor lifetime",
  "  --help                            Show this help",
].join("\n");

const DEFAULTS = {
  maxRows: 100,
  maxBytes: 512_000,
  maxWriteSpoolBytes: 16 * 1024 * 1024,
  maxRuntimeSeconds: 30,
  memoryLimitBytes: 128 * 1024 * 1024,
  requestTimeoutMs: 35_000,
  cursorTtlSeconds: 30,
  maxActiveCursors: 32,
};

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }
  throw new ConfigError(`${name} must be a boolean`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new ConfigError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function parseCsv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function validateCollectionRule(value: string): string {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ConfigError(
      `Collection allowlist entry "${value}" must use the format database/collection`,
    );
  }
  return value;
}

function validateUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError("ARANGO_URL (or the positional URL) must be a valid URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ConfigError("ArangoDB URL must use http:// or https://");
  }
  return value.replace(/\/$/, "");
}

export function parseConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const positionals: string[] = [];
  const cliDatabases = new Set<string>();
  const cliCollections = new Set<string>();
  const numericFlags = new Map<string, string>();
  let enableDocumentWritesFlag = false;
  let enableReadWriteQueryFlag = false;
  let enableDiagnosticToolsFlag = false;

  for (const arg of args) {
    if (arg === "--help") {
      throw new HelpRequested();
    }
    if (arg === "--enable-document-writes" || arg === "--enable-write") {
      enableDocumentWritesFlag = true;
      continue;
    }
    if (arg === "--enable-read-write-query") {
      enableReadWriteQueryFlag = true;
      continue;
    }
    if (arg === "--enable-diagnostic-tools") {
      enableDiagnosticToolsFlag = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    if (equals === -1) {
      throw new ConfigError(`Unknown flag: ${arg}`);
    }
    const name = arg.slice(0, equals);
    const value = arg.slice(equals + 1).trim();
    if (!value) {
      throw new ConfigError(`${name} requires a value`);
    }

    if (name === "--allow-database") {
      cliDatabases.add(value);
    } else if (name === "--allow-collection") {
      cliCollections.add(validateCollectionRule(value));
    } else if (
      [
        "--max-rows",
        "--max-bytes",
        "--max-write-spool-bytes",
        "--max-runtime",
        "--memory-limit",
        "--request-timeout",
        "--cursor-ttl",
      ].includes(name)
    ) {
      numericFlags.set(name, value);
    } else {
      throw new ConfigError(`Unknown flag: ${name}`);
    }
  }

  if (positionals.length > 3) {
    throw new ConfigError("Too many positional arguments");
  }

  const databaseUrl = positionals[0] ?? env.ARANGO_URL ?? env.ARANGO_HOSTS;
  if (!databaseUrl) {
    throw new ConfigError("Please provide ARANGO_URL or a positional database URL");
  }

  const username = positionals[1] ?? env.ARANGO_USERNAME ?? env.ARANGO_ROOT_USERNAME;
  const password = positionals[2] ?? env.ARANGO_PASSWORD ?? env.ARANGO_ROOT_PASSWORD;
  if (password !== undefined && username === undefined) {
    throw new ConfigError("An ArangoDB password requires a username");
  }

  const allowedDatabases = cliDatabases.size
    ? cliDatabases
    : parseCsv(env.ARANGO_ALLOWED_DATABASES);
  const allowedCollections = cliCollections.size
    ? cliCollections
    : parseCsv(env.ARANGO_ALLOWED_COLLECTIONS);
  for (const entry of allowedCollections) {
    validateCollectionRule(entry);
    const database = entry.slice(0, entry.indexOf("/"));
    if (allowedDatabases.size > 0 && !allowedDatabases.has(database)) {
      throw new ConfigError(
        `Collection allowlist database "${database}" is not in ARANGO_ALLOWED_DATABASES`,
      );
    }
  }

  return {
    databaseUrl: validateUrl(databaseUrl),
    username,
    password,
    enableDocumentWrites:
      enableDocumentWritesFlag ||
      parseBoolean(
        env.ARANGO_ENABLE_DOCUMENT_WRITES ?? env.ARANGO_ENABLE_WRITE,
        false,
        env.ARANGO_ENABLE_DOCUMENT_WRITES === undefined
          ? "ARANGO_ENABLE_WRITE"
          : "ARANGO_ENABLE_DOCUMENT_WRITES",
      ),
    enableReadWriteQuery:
      enableReadWriteQueryFlag ||
      parseBoolean(
        env.ARANGO_ENABLE_READ_WRITE_QUERY,
        false,
        "ARANGO_ENABLE_READ_WRITE_QUERY",
      ),
    enableDiagnosticTools:
      enableDiagnosticToolsFlag ||
      parseBoolean(
        env.ARANGO_ENABLE_DIAGNOSTIC_TOOLS,
        false,
        "ARANGO_ENABLE_DIAGNOSTIC_TOOLS",
      ),
    allowedDatabases,
    allowedCollections,
    maxRows: parsePositiveInteger(
      numericFlags.get("--max-rows") ?? env.ARANGO_MCP_MAX_ROWS,
      DEFAULTS.maxRows,
      "max rows",
    ),
    maxBytes: parsePositiveInteger(
      numericFlags.get("--max-bytes") ?? env.ARANGO_MCP_MAX_BYTES,
      DEFAULTS.maxBytes,
      "max bytes",
      1_024,
    ),
    maxWriteSpoolBytes: parsePositiveInteger(
      numericFlags.get("--max-write-spool-bytes") ??
        env.ARANGO_MCP_MAX_WRITE_SPOOL_BYTES,
      DEFAULTS.maxWriteSpoolBytes,
      "max write spool bytes",
      1_024,
    ),
    maxRuntimeSeconds: parsePositiveInteger(
      numericFlags.get("--max-runtime") ?? env.ARANGO_MCP_MAX_RUNTIME,
      DEFAULTS.maxRuntimeSeconds,
      "max runtime",
    ),
    memoryLimitBytes: parsePositiveInteger(
      numericFlags.get("--memory-limit") ?? env.ARANGO_MCP_MEMORY_LIMIT,
      DEFAULTS.memoryLimitBytes,
      "memory limit",
    ),
    requestTimeoutMs: parsePositiveInteger(
      numericFlags.get("--request-timeout") ?? env.ARANGO_MCP_REQUEST_TIMEOUT,
      DEFAULTS.requestTimeoutMs,
      "request timeout",
      100,
    ),
    cursorTtlSeconds: parsePositiveInteger(
      numericFlags.get("--cursor-ttl") ?? env.ARANGO_MCP_CURSOR_TTL,
      DEFAULTS.cursorTtlSeconds,
      "cursor TTL",
    ),
    maxActiveCursors: parsePositiveInteger(
      env.ARANGO_MCP_MAX_ACTIVE_CURSORS,
      DEFAULTS.maxActiveCursors,
      "max active cursors",
    ),
    tlsCaFile: env.ARANGO_TLS_CA_FILE || undefined,
    tlsRejectUnauthorized: parseBoolean(
      env.ARANGO_TLS_REJECT_UNAUTHORIZED,
      true,
      "ARANGO_TLS_REJECT_UNAUTHORIZED",
    ),
    credentialsFromCli: positionals.length > 1,
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  HelpRequested,
  parseConfig,
} from "../../dist/src/config.js";

test("parses a secure environment-based configuration", () => {
  const config = parseConfig([], {
    ARANGO_URL: "https://db.example.test:8529/",
    ARANGO_USERNAME: "reader",
    ARANGO_PASSWORD: "secret",
    ARANGO_ALLOWED_DATABASES: "analytics, reporting",
    ARANGO_ALLOWED_COLLECTIONS: "analytics/events,reporting/totals",
    ARANGO_MCP_MAX_ROWS: "25",
  });

  assert.equal(config.databaseUrl, "https://db.example.test:8529");
  assert.equal(config.username, "reader");
  assert.equal(config.password, "secret");
  assert.equal(config.enableDocumentWrites, false);
  assert.equal(config.enableReadWriteQuery, false);
  assert.equal(config.enableDiagnosticTools, false);
  assert.equal(config.maxRows, 25);
  assert.equal(config.maxWriteSpoolBytes, 16 * 1024 * 1024);
  assert.deepEqual([...config.allowedDatabases], ["analytics", "reporting"]);
  assert.equal(config.credentialsFromCli, false);
});

test("keeps positional CLI compatibility and marks exposed credentials", () => {
  const config = parseConfig(
    [
      "--enable-document-writes",
      "--enable-read-write-query",
      "--enable-diagnostic-tools",
      "http://127.0.0.1:8529",
      "root",
      "password",
    ],
    {},
  );

  assert.equal(config.enableDocumentWrites, true);
  assert.equal(config.enableReadWriteQuery, true);
  assert.equal(config.enableDiagnosticTools, true);
  assert.equal(config.username, "root");
  assert.equal(config.credentialsFromCli, true);
});

test("keeps legacy write enablement limited to document CRUD", () => {
  const config = parseConfig([], {
    ARANGO_URL: "http://localhost:8529",
    ARANGO_ENABLE_WRITE: "true",
  });

  assert.equal(config.enableDocumentWrites, true);
  assert.equal(config.enableReadWriteQuery, false);

  const explicitlyDisabled = parseConfig([], {
    ARANGO_URL: "http://localhost:8529",
    ARANGO_ENABLE_DOCUMENT_WRITES: "false",
    ARANGO_ENABLE_WRITE: "true",
  });
  assert.equal(explicitlyDisabled.enableDocumentWrites, false);
});

test("supports repeatable policy and numeric flags", () => {
  const config = parseConfig(
    [
      "--allow-database=analytics",
      "--allow-collection=analytics/events",
      "--max-rows=10",
      "--max-bytes=4096",
      "--max-write-spool-bytes=8192",
      "http://localhost:8529",
    ],
    {},
  );

  assert.deepEqual([...config.allowedDatabases], ["analytics"]);
  assert.deepEqual([...config.allowedCollections], ["analytics/events"]);
  assert.equal(config.maxRows, 10);
  assert.equal(config.maxBytes, 4096);
  assert.equal(config.maxWriteSpoolBytes, 8192);
});

test("rejects invalid policies, protocols, and flags", () => {
  assert.throws(
    () =>
      parseConfig([], {
        ARANGO_URL: "ftp://localhost:8529",
      }),
    ConfigError,
  );
  assert.throws(
    () =>
      parseConfig([], {
        ARANGO_URL: "http://localhost:8529",
        ARANGO_ALLOWED_DATABASES: "analytics",
        ARANGO_ALLOWED_COLLECTIONS: "other/events",
      }),
    /not in ARANGO_ALLOWED_DATABASES/,
  );
  assert.throws(
    () => parseConfig(["--unknown=value", "http://localhost:8529"], {}),
    /Unknown flag/,
  );
  assert.throws(
    () =>
      parseConfig([], {
        ARANGO_URL: "http://localhost:8529",
        ARANGO_MCP_MAX_WRITE_SPOOL_BYTES: "1023",
      }),
    /max write spool bytes/,
  );
});

test("reports help without terminating the process", () => {
  assert.throws(() => parseConfig(["--help"], {}), HelpRequested);
});

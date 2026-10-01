import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ArangoDBService } from "../../dist/src/arangodb-service.js";
import { parseConfig } from "../../dist/src/config.js";

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

function serviceFor(t, url, env = {}) {
  const service = new ArangoDBService(parseConfig([], {
    ARANGO_URL: url,
    ...env,
  }));
  t.after(() => service.close());
  return service;
}

test("document selectors cannot redirect HTTP requests outside the allowed collection", async (t) => {
  const requests = [];
  const port = await listen(t, http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ _id: "public/key:1", _key: "key:1", _rev: "123" }));
  }));
  const service = serviceFor(t, `http://127.0.0.1:${port}`, {
    ARANGO_ALLOWED_COLLECTIONS: "db/public",
    ARANGO_ENABLE_DOCUMENT_WRITES: "true",
  });

  for (const selector of [
    "public/../secret/key",
    "public/../../document/secret/key",
    "public/key/extra",
    "secret/key",
    "public\\..\\secret\\key",
    "key?ignoreRevs=true",
    "key#fragment",
    ".",
    "..",
  ]) {
    await assert.rejects(service.readDocument("db", "public", selector), undefined, selector);
    await assert.rejects(service.updateDocument("db", "public", selector, "123", {}), undefined, selector);
    await assert.rejects(service.deleteDocument("db", "public", selector, "123"), undefined, selector);
  }
  assert.deepEqual(requests, [], "rejected selectors must never reach the database");

  await service.readDocument("db", "public", "key:1");
  await service.updateDocument("db", "public", "public/key:1", "123", { value: 1 });
  await service.deleteDocument("db", "public", "public/key:1", "123");
  assert.deepEqual(requests.map(({ method, url }) => ({
    method,
    path: new URL(url, "http://localhost").pathname,
  })), [
    { method: "GET", path: "/_db/db/_api/document/public/key:1" },
    { method: "PATCH", path: "/_db/db/_api/document/public/key:1" },
    { method: "DELETE", path: "/_db/db/_api/document/public/key:1" },
  ]);

  await service.readDocument("db", "public", "key%2Fpart");
  assert.equal(new URL(requests.at(-1).url, "http://localhost").pathname,
    "/_db/db/_api/document/public/key%252Fpart",
    "literal percent sequences must remain part of the key");
});

test("request timeout applies to root metadata, database metadata and document writes", { timeout: 5000 }, async (t) => {
  const received = [];
  const port = await listen(t, http.createServer((request) => {
    received.push(request.url);
    request.resume();
    // Intentionally leave the response pending until the client's timeout fires.
  }));
  const service = serviceFor(t, `http://127.0.0.1:${port}`, {
    ARANGO_MCP_REQUEST_TIMEOUT: "300",
    ARANGO_ENABLE_DOCUMENT_WRITES: "true",
  });
  const isTimeout = (error) => /timeout/i.test(`${error.name} ${error.message}`);
  await assert.rejects(service.listDatabases(), isTimeout);
  await assert.rejects(service.listCollections("db"), isTimeout);
  await assert.rejects(service.insertDocument("db", "public", { _key: "key" }), isTimeout);
  assert.equal(received.length, 3);
});

test("HTTPS verifies server certificates and accepts the configured CA", { timeout: 5000 }, async (t) => {
  // Public, test-only self-signed certificate and key; never use for deployments.
  const certPath = new URL("../fixtures/tls/localhost-cert.pem", import.meta.url);
  const [cert, key] = await Promise.all([
    readFile(certPath),
    readFile(new URL("../fixtures/tls/localhost-key.pem", import.meta.url)),
  ]);
  const port = await listen(t, https.createServer({ cert, key }, (request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: false, code: 200, result: ["db"] }));
  }));
  const url = `https://127.0.0.1:${port}`;
  const untrusted = serviceFor(t, url);
  await assert.rejects(untrusted.listDatabases(), (error) => {
    const causes = [];
    for (let cause = error; cause; cause = cause.cause) {
      causes.push(cause.code);
    }
    return causes.some((code) =>
      ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(code)
    );
  });

  const trusted = serviceFor(t, url, { ARANGO_TLS_CA_FILE: fileURLToPath(certPath) });
  assert.deepEqual(await trusted.listDatabases(), ["db"]);
});

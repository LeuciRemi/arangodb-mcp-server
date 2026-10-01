import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../../dist/src/config.js";
import { createArangoMcpServer } from "../../dist/src/server.js";

async function connect(t, env = {}) {
  const app = createArangoMcpServer(parseConfig([], {
    ARANGO_URL: "http://127.0.0.1:1",
    ...env,
  }), "test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "resource-error-test", version: "1" });
  t.after(async () => {
    await client.close();
    await app.close();
  });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { app, client };
}

function assertBoundedError(result, maxBytes = 1024) {
  assert.equal(result.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes);
  assert.ok(result.content[0].text.length > 0);
}

test("bounds policy errors containing a long database name", async (t) => {
  const { client } = await connect(t, {
    ARANGO_ALLOWED_DATABASES: "demo",
    ARANGO_MCP_MAX_BYTES: "1024",
  });
  const result = await client.callTool({
    name: "describeCollection",
    arguments: { databaseName: "x".repeat(20_000), collectionName: "col" },
  });
  assertBoundedError(result);
});

test("bounds SDK input validation and unknown-tool errors before callbacks run", async (t) => {
  const { app, client } = await connect(t, { ARANGO_MCP_MAX_BYTES: "1024" });
  let called = false;
  app.service.sampleDocuments = async () => {
    called = true;
    throw new Error("Unexpected service call");
  };
  const invalidInput = await client.callTool({
    name: "sampleDocuments",
    arguments: { databaseName: "db", collectionName: "col", fields: Array(300).fill(42) },
  });
  assertBoundedError(invalidInput);
  assert.match(invalidInput.content[0].text, /truncated/);
  assert.equal(called, false);

  const unknownTool = await client.callTool({ name: "missing".repeat(1000), arguments: {} });
  assertBoundedError(unknownTool);
});

test("bounds escaped UTF-8 backend errors and redacts credentials before truncating", async (t) => {
  const { app, client } = await connect(t, {
    ARANGO_MCP_MAX_BYTES: "1024",
    ARANGO_USERNAME: "review-user",
    ARANGO_PASSWORD: "review-secret",
  });
  app.service.listDatabases = async () => {
    throw new Error(`review-user review-secret ${'é😀"\\\n'.repeat(1000)}`);
  };
  const result = await client.callTool({ name: "listDatabases", arguments: {} });
  assertBoundedError(result);
  assert.doesNotMatch(result.content[0].text, /review-user|review-secret/);
  assert.match(result.content[0].text, /\[redacted\]/);
  assert.match(result.content[0].text, /truncated/);
});

test("decodes resource URI names and document keys exactly once", async (t) => {
  const { app, client } = await connect(t);
  app.service.describeCollection = async (databaseName, collectionName) => ({
    databaseName, collectionName,
  });
  app.service.readDocument = async (databaseName, collectionName, documentId) => ({
    databaseName, collectionName, documentId,
  });
  const metadata = await client.readResource({ uri: "arangodb:///donn%C3%A9es/caf%C3%A9" });
  assert.deepEqual(JSON.parse(metadata.contents[0].text), {
    databaseName: "données", collectionName: "café",
  });
  const document = await client.readResource({ uri: "arangodb:///db/caf%C3%A9/key%3A1" });
  assert.deepEqual(JSON.parse(document.contents[0].text), {
    databaseName: "db", collectionName: "café", documentId: "key:1",
  });
  const literalPercent = await client.readResource({ uri: "arangodb:///db/col/key%253A1" });
  assert.equal(JSON.parse(literalPercent.contents[0].text).documentId, "key%3A1");
});

test("rejects decoded URI separators, controls and malformed encodings before database access", async (t) => {
  const { app, client } = await connect(t);
  let called = false;
  app.service.readDocument = app.service.describeCollection = async () => {
    called = true;
    return {};
  };
  for (const uri of [
    "arangodb:///db/public%2F..%2Fsecret/key",
    "arangodb:///db/public/key%2F..%2Fsecret",
    "arangodb:///db/public/key%5Csecret",
    "arangodb:///db/public/key%3Fquery",
    "arangodb:///db/public/key%23fragment",
    "arangodb:///db/public/key%00",
    "arangodb:///db/public/key%E0%A4%A",
    "arangodb:///db/public%2Fsecret",
  ]) {
    await assert.rejects(client.readResource({ uri }), /Invalid .*resource URI segment/, uri);
  }
  assert.equal(called, false);
});

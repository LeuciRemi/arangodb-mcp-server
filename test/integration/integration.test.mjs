import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Database } from "arangojs";

const url = process.env.ARANGO_TEST_URL;
const username = process.env.ARANGO_TEST_USERNAME ?? "root";
const password = process.env.ARANGO_TEST_PASSWORD ?? "test";

function createClient(
  collectionNames,
  {
    database = "_system",
    databaseAllowlist = true,
    documentWrites = false,
    readWriteQuery = false,
    limits = {},
    credentials = { username, password },
  } = {},
) {
  const allowedCollections = (Array.isArray(collectionNames)
    ? collectionNames
    : [collectionNames]
  ).map((collectionName) => `${database}/${collectionName}`);
  const env = {
    ...process.env,
    ARANGO_URL: url,
    ARANGO_USERNAME: credentials.username,
    ARANGO_PASSWORD: credentials.password,
    ARANGO_ALLOWED_COLLECTIONS: allowedCollections.join(","),
    ARANGO_MCP_MAX_ROWS: String(limits.maxRows ?? 2),
    ARANGO_MCP_MAX_BYTES: String(limits.maxBytes ?? 65536),
    ARANGO_MCP_MAX_WRITE_SPOOL_BYTES: String(
      limits.maxWriteSpoolBytes ?? 16 * 1024 * 1024,
    ),
    ARANGO_MCP_MAX_ACTIVE_CURSORS: String(limits.maxActiveCursors ?? 32),
    ARANGO_MCP_CURSOR_TTL: String(limits.cursorTtlSeconds ?? 30),
    ARANGO_ENABLE_DOCUMENT_WRITES: documentWrites ? "true" : "false",
    ARANGO_ENABLE_READ_WRITE_QUERY: readWriteQuery ? "true" : "false",
    ARANGO_ENABLE_DIAGNOSTIC_TOOLS: "true",
  };
  if (databaseAllowlist) {
    env.ARANGO_ALLOWED_DATABASES = database;
  } else {
    // Leave the database allowlist unset so parseConfig must derive it.
    delete env.ARANGO_ALLOWED_DATABASES;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env,
  });
  return {
    client: new Client(
      { name: "integration-test", version: "1.0.0" },
      { capabilities: {} },
    ),
    transport,
  };
}

/** Walk a paginated metadata list; every page must respect maxRows. */
async function collectPages(client, name, arguments_, key) {
  const items = [];
  let cursor;
  for (;;) {
    const result = await client.callTool({
      name,
      arguments: { ...arguments_, ...(cursor ? { cursor } : {}) },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.ok(result.structuredContent[key].length <= arguments_.limit ?? Infinity);
    items.push(...result.structuredContent[key]);
    cursor = result.structuredContent.nextCursor;
    if (!cursor) {
      return items;
    }
  }
}

async function waitForViewDocuments(database, viewName, expectedCount, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // waitForSync is rejected inside the server's stream transactions, but it
    // is valid on this administrative connection outside a transaction.
    const cursor = await database.query(
      `FOR doc IN ${viewName} OPTIONS { waitForSync: true } COLLECT WITH COUNT INTO count RETURN count`,
    );
    const [count] = await cursor.all();
    if (count === expectedCount) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`View ${viewName} indexed ${count} of ${expectedCount} documents`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test(
  "enforces read-only AQL, paginates, and exposes metadata without implicit samples",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const collectionName = `mcp_integration_${Date.now()}`;
    const metadataCollectionNames = [
      collectionName,
      `${collectionName}_b`,
      `${collectionName}_c`,
    ];
    const collection = admin.collection(collectionName);
    await collection.create({
      schema: { rule: { properties: {} }, level: "moderate", message: "example" },
    });
    await admin.collection(metadataCollectionNames[1]).create();
    await admin.collection(metadataCollectionNames[2]).create();
    await collection.save([
      { _key: "a", value: 1, privateField: "secret-a" },
      { _key: "b", value: 2, privateField: "secret-b" },
      { _key: "c", value: 3, privateField: "secret-c" },
    ]);

    const { client, transport } = createClient(metadataCollectionNames);
    try {
      await client.connect(transport);

      const firstCollectionPage = await client.callTool({
        name: "listCollections",
        arguments: { databaseName: "_system", limit: 2 },
      });
      assert.equal(firstCollectionPage.structuredContent.collections.length, 2);
      assert.equal(firstCollectionPage.structuredContent.totalCollections, 3);
      assert.ok(firstCollectionPage.structuredContent.nextCursor);
      for (const collection of firstCollectionPage.structuredContent.collections) {
        assert.equal(collection.type, "document");
        assert.equal(typeof collection.count, "number");
        assert.equal(collection.isSystem, undefined);
        assert.equal(collection.status, undefined);
      }
      assert.equal(firstCollectionPage.structuredContent.truncated, undefined);
      const secondCollectionPage = await client.callTool({
        name: "listCollections",
        arguments: {
          databaseName: "_system",
          limit: 2,
          cursor: firstCollectionPage.structuredContent.nextCursor,
        },
      });
      assert.equal(secondCollectionPage.structuredContent.collections.length, 1);
      assert.equal(secondCollectionPage.structuredContent.nextCursor, undefined);

      const first = await client.callTool({
        name: "readQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR doc IN @@collection SORT doc._key RETURN KEEP(doc, ['_key', 'value'])",
          bindVars: { "@collection": collectionName },
          pageSize: 2,
        },
      });
      assert.notEqual(first.isError, true, JSON.stringify(first.content));
      assert.deepEqual(
        first.structuredContent.rows.map((row) => row._key),
        ["a", "b"],
      );
      assert.equal(first.structuredContent.hasMore, true);
      assert.ok(first.structuredContent.nextCursor);
      assert.equal(first.structuredContent.bytes, undefined);
      assert.equal(first.structuredContent.warnings, undefined);
      assert.equal(first.structuredContent.stats, undefined);

      const second = await client.callTool({
        name: "continueQuery",
        arguments: {
          cursor: first.structuredContent.nextCursor,
          pageSize: 2,
        },
      });
      assert.deepEqual(
        second.structuredContent.rows.map((row) => row._key),
        ["c"],
      );
      assert.equal(second.structuredContent.hasMore, false);

      const modificationQueries = [
        "INSERT { _key: 'blocked-insert' } INTO @@collection",
        "FOR doc IN @@collection LIMIT 1 UPDATE doc WITH { touched: true } IN @@collection",
        "FOR doc IN @@collection LIMIT 1 REPLACE doc WITH { _key: doc._key, replaced: true } IN @@collection",
        "FOR doc IN @@collection LIMIT 1 REMOVE doc IN @@collection",
        "UPSERT { _key: 'blocked-upsert' } INSERT { _key: 'blocked-upsert' } UPDATE { touched: true } IN @@collection",
      ];
      for (const aql of modificationQueries) {
        const rejectedWrite = await client.callTool({
          name: "readQuery",
          arguments: {
            databaseName: "_system",
            aql,
            bindVars: { "@collection": collectionName },
          },
        });
        assert.equal(rejectedWrite.isError, true, aql);
        assert.match(
          rejectedWrite.content[0].text,
          /rejected a data-modification query/,
        );
      }
      assert.equal(await collection.documentExists("blocked-insert"), false);
      assert.equal(await collection.documentExists("blocked-upsert"), false);
      assert.equal((await collection.document("a")).touched, undefined);

      const explained = await client.callTool({
        name: "explainQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR doc IN @@collection RETURN doc._key",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.equal(explained.structuredContent.isModificationQuery, false);
      assert.ok(explained.structuredContent.collections.length > 0);

      const sampled = await client.callTool({
        name: "sampleDocuments",
        arguments: {
          databaseName: "_system",
          collectionName,
          limit: 2,
          fields: ["_key", "value"],
        },
      });
      assert.equal(sampled.structuredContent.rows.length, 2);
      assert.equal(sampled.structuredContent.rows[0].privateField, undefined);

      const described = await client.callTool({
        name: "describeCollection",
        arguments: { databaseName: "_system", collectionName },
      });
      assert.notEqual(described.isError, true, JSON.stringify(described.content));
      const compact = described.structuredContent;
      assert.deepEqual(Object.keys(compact).sort(), [
        "collectionName",
        "databaseName",
        "documentCount",
        "indexes",
        "schema",
        "type",
      ]);
      assert.equal(compact.type, "document");
      assert.equal(compact.documentCount, 3);
      assert.equal(compact.details, undefined);
      assert.equal(compact.properties, undefined);
      assert.equal(compact.rawIndexes, undefined);
      assert.equal(compact.schema.level, "moderate");
      assert.ok(compact.indexes.some((index) => index.type === "primary"));

      const verbose = await client.callTool({
        name: "describeCollection",
        arguments: { databaseName: "_system", collectionName, verbose: true },
      });
      assert.equal(typeof verbose.structuredContent.properties, "object");
      assert.equal(
        verbose.structuredContent.rawIndexes.length,
        verbose.structuredContent.indexes.length,
      );
      assert.deepEqual(
        verbose.structuredContent.indexes,
        compact.indexes,
      );

      const resource = await client.readResource({
        uri: `arangodb:///_system/${collectionName}`,
      });
      const metadata = JSON.parse(resource.contents[0].text);
      assert.deepEqual(metadata, compact);
      assert.equal(metadata.documentCount, 3);
      assert.ok(Array.isArray(metadata.indexes));
      assert.equal(metadata.sampleDocuments, undefined);

      const health = await client.callTool({ name: "healthCheck", arguments: {} });
      assert.equal(health.structuredContent.health.status, "ok");
      assert.equal(
        health.structuredContent.health.limits.maxWriteSpoolBytes,
        16 * 1024 * 1024,
      );

      const { tools } = await client.listTools();
      assert.ok(!tools.some((tool) => tool.name === "readWriteQuery"));
    } finally {
      await client.close();
      await collection.drop().catch(() => undefined);
      await admin.collection(metadataCollectionNames[1]).drop().catch(() => undefined);
      await admin.collection(metadataCollectionNames[2]).drop().catch(() => undefined);
      admin.close();
    }
  },
);

test(
  "enforces collection allowlists for direct, dynamic, traversal, and graph reads",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const suffix = `${Date.now()}`;
    const allowedDocuments = `mcp_allowed_docs_${suffix}`;
    const forbiddenDocuments = `mcp_forbidden_docs_${suffix}`;
    const allowedVertices = `mcp_allowed_vertices_${suffix}`;
    const forbiddenVertices = `mcp_forbidden_vertices_${suffix}`;
    const allowedEdges = `mcp_allowed_edges_${suffix}`;
    const forbiddenEdges = `mcp_forbidden_edges_${suffix}`;
    const allowedGraphName = `mcp_allowed_graph_${suffix}`;
    const forbiddenGraphName = `mcp_forbidden_graph_${suffix}`;
    const collectionNames = [
      allowedDocuments,
      forbiddenDocuments,
      allowedVertices,
      forbiddenVertices,
      allowedEdges,
      forbiddenEdges,
    ];

    await Promise.all([
      admin.collection(allowedDocuments).create(),
      admin.collection(forbiddenDocuments).create(),
      admin.collection(allowedVertices).create(),
      admin.collection(forbiddenVertices).create(),
      admin.createEdgeCollection(allowedEdges),
      admin.createEdgeCollection(forbiddenEdges),
    ]);
    await admin.collection(allowedDocuments).save({ _key: "visible", value: 1 });
    await admin.collection(forbiddenDocuments).save({ _key: "secret", value: 2 });
    await admin.collection(allowedVertices).save([{ _key: "a" }, { _key: "b" }]);
    await admin.collection(forbiddenVertices).save([{ _key: "a" }, { _key: "b" }]);
    await admin.collection(allowedEdges).save({
      _from: `${allowedVertices}/a`,
      _to: `${allowedVertices}/b`,
    });
    await admin.collection(forbiddenEdges).save({
      _from: `${forbiddenVertices}/a`,
      _to: `${forbiddenVertices}/b`,
    });
    const allowedGraph = admin.graph(allowedGraphName);
    const forbiddenGraph = admin.graph(forbiddenGraphName);
    await allowedGraph.create([
      { collection: allowedEdges, from: [allowedVertices], to: [allowedVertices] },
    ]);
    await forbiddenGraph.create([
      {
        collection: forbiddenEdges,
        from: [forbiddenVertices],
        to: [forbiddenVertices],
      },
    ]);

    const { client, transport } = createClient([
      allowedDocuments,
      allowedVertices,
      allowedEdges,
    ]);
    try {
      await client.connect(transport);

      const allowedQueries = [
        {
          aql: `FOR doc IN ${allowedDocuments} RETURN doc._key`,
          bindVars: {},
        },
        {
          aql: "FOR doc IN @@collection RETURN doc._key",
          bindVars: { "@collection": allowedDocuments },
        },
        {
          aql: "RETURN DOCUMENT(@collectionName, @key)._key",
          bindVars: { collectionName: allowedDocuments, key: "visible" },
        },
        {
          aql: `WITH ${allowedVertices} FOR vertex IN 1..1 OUTBOUND @start @@edges RETURN vertex._key`,
          bindVars: {
            start: `${allowedVertices}/a`,
            "@edges": allowedEdges,
          },
        },
        {
          aql: "FOR vertex IN 1..1 OUTBOUND @start GRAPH @graph RETURN vertex._key",
          bindVars: { start: `${allowedVertices}/a`, graph: allowedGraphName },
        },
      ];
      for (const arguments_ of allowedQueries) {
        const result = await client.callTool({
          name: "readQuery",
          arguments: { databaseName: "_system", ...arguments_ },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
      }

      const forbiddenQueries = [
        {
          aql: `FOR doc IN ${forbiddenDocuments} RETURN doc._key`,
          bindVars: {},
        },
        {
          aql: "FOR doc IN @@collection RETURN doc._key",
          bindVars: { "@collection": forbiddenDocuments },
        },
        {
          aql: "RETURN DOCUMENT(@collectionName, @key)",
          bindVars: { collectionName: forbiddenDocuments, key: "secret" },
        },
        {
          aql: `WITH ${forbiddenVertices} FOR vertex IN 1..1 OUTBOUND @start @@edges RETURN vertex._key`,
          bindVars: {
            start: `${forbiddenVertices}/a`,
            "@edges": forbiddenEdges,
          },
        },
        {
          aql: "FOR vertex IN 1..1 OUTBOUND @start GRAPH @graph RETURN vertex._key",
          bindVars: { start: `${forbiddenVertices}/a`, graph: forbiddenGraphName },
        },
      ];
      for (const arguments_ of forbiddenQueries) {
        const result = await client.callTool({
          name: "readQuery",
          arguments: { databaseName: "_system", ...arguments_ },
        });
        assert.equal(result.isError, true, arguments_.aql);
      }
    } finally {
      await client.close();
      await allowedGraph.drop().catch(() => undefined);
      await forbiddenGraph.drop().catch(() => undefined);
      await Promise.all(
        collectionNames.map((name) =>
          admin.collection(name).drop().catch(() => undefined),
        ),
      );
      admin.close();
    }
  },
);

test(
  "exposes write AQL only when explicitly enabled",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const collectionName = `mcp_write_${Date.now()}`;
    const collection = admin.collection(collectionName);
    await collection.create();

    const { client, transport } = createClient(collectionName, {
      documentWrites: true,
      readWriteQuery: true,
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const writeTool = tools.find((tool) => tool.name === "readWriteQuery");
      assert.ok(writeTool);
      assert.equal(writeTool.annotations.readOnlyHint, false);
      assert.equal(writeTool.annotations.destructiveHint, true);
      assert.ok(tools.some((tool) => tool.name === "insertDocument"));
      assert.ok(tools.some((tool) => tool.name === "updateDocument"));
      assert.ok(tools.some((tool) => tool.name === "deleteDocument"));

      const explicitInsert = await client.callTool({
        name: "insertDocument",
        arguments: {
          databaseName: "_system",
          collectionName,
          document: { _key: "explicit", value: 1 },
        },
      });
      assert.notEqual(explicitInsert.isError, true, JSON.stringify(explicitInsert.content));
      const insertedMetadata = explicitInsert.structuredContent.metadata;
      assert.equal((await collection.document("explicit")).value, 1);

      const explicitUpdate = await client.callTool({
        name: "updateDocument",
        arguments: {
          databaseName: "_system",
          collectionName,
          documentId: "explicit",
          revision: insertedMetadata._rev,
          patch: { value: 2 },
        },
      });
      assert.notEqual(explicitUpdate.isError, true, JSON.stringify(explicitUpdate.content));
      const updatedMetadata = explicitUpdate.structuredContent.metadata;
      assert.equal((await collection.document("explicit")).value, 2);

      const staleUpdate = await client.callTool({
        name: "updateDocument",
        arguments: {
          databaseName: "_system",
          collectionName,
          documentId: "explicit",
          revision: insertedMetadata._rev,
          patch: { value: 3 },
        },
      });
      assert.equal(staleUpdate.isError, true);

      const explicitDelete = await client.callTool({
        name: "deleteDocument",
        arguments: {
          databaseName: "_system",
          collectionName,
          documentId: "explicit",
          revision: updatedMetadata._rev,
        },
      });
      assert.notEqual(explicitDelete.isError, true, JSON.stringify(explicitDelete.content));
      assert.equal(await collection.documentExists("explicit"), false);

      const inserted = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "INSERT { _key: @key, value: 42 } INTO @@collection RETURN NEW",
          bindVars: { "@collection": collectionName, key: "written" },
        },
      });
      assert.notEqual(inserted.isError, true, JSON.stringify(inserted.content));
      assert.equal(inserted.structuredContent.writesExecuted, 1);
      assert.equal(inserted.structuredContent.writesIgnored, 0);
      assert.equal((await collection.document("written")).value, 42);

      const paginatedInsert = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR value IN 1..3 INSERT { _key: CONCAT('page-', value), value } INTO @@collection RETURN NEW._key",
          bindVars: { "@collection": collectionName },
          pageSize: 1,
        },
      });
      assert.notEqual(
        paginatedInsert.isError,
        true,
        JSON.stringify(paginatedInsert.content),
      );
      assert.equal(paginatedInsert.structuredContent.hasMore, true);
      assert.equal(paginatedInsert.structuredContent.writesExecuted, 3);
      assert.equal(paginatedInsert.structuredContent.writesIgnored, 0);
      assert.ok(paginatedInsert.structuredContent.nextCursor);
      assert.deepEqual(
        await Promise.all(
          [1, 2, 3].map(async (value) =>
            (await collection.document(`page-${value}`)).value
          ),
        ),
        [1, 2, 3],
        "all writes must be committed before the first result page is returned",
      );

      const paginatedContinuation = await client.callTool({
        name: "continueQuery",
        arguments: {
          cursor: paginatedInsert.structuredContent.nextCursor,
          pageSize: 2,
        },
      });
      assert.notEqual(
        paginatedContinuation.isError,
        true,
        JSON.stringify(paginatedContinuation.content),
      );
      assert.deepEqual(
        paginatedContinuation.structuredContent.rows,
        ["page-2", "page-3"],
      );
      assert.equal(paginatedContinuation.structuredContent.hasMore, false);
      assert.equal(paginatedContinuation.structuredContent.writesExecuted, undefined);

      const oversizedWriteResult = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "INSERT { _key: 'large', value: REPEAT('x', 70000) } INTO @@collection RETURN NEW",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.notEqual(
        oversizedWriteResult.isError,
        true,
        JSON.stringify(oversizedWriteResult.content),
      );
      assert.equal(
        oversizedWriteResult.structuredContent.rows[0]._mcpResultOmitted,
        true,
      );
      assert.equal((await collection.document("large")).value.length, 70000);
    } finally {
      await client.close();
      await collection.drop().catch(() => undefined);
      admin.close();
    }
  },
);

test(
  "rejects document selectors that escape the collection allowlist",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({ url, databaseName: "_system", auth: { username, password } });
    const allowedName = `mcp_selector_allowed_${Date.now()}`;
    const forbiddenName = `${allowedName}_forbidden`;
    const allowed = admin.collection(allowedName);
    const forbidden = admin.collection(forbiddenName);
    const { client, transport } = createClient(allowedName, { documentWrites: true });
    try {
      await Promise.all([allowed.create(), forbidden.create()]);
      await forbidden.save({ _key: "protected", value: "unchanged" });
      const original = await forbidden.document("protected");
      await client.connect(transport);

      for (const documentId of [
        `${allowedName}/../${forbiddenName}/protected`,
        `${allowedName}/../../document/${forbiddenName}/protected`,
        `${forbiddenName}/protected`,
      ]) {
        for (const name of ["updateDocument", "deleteDocument"]) {
          const result = await client.callTool({
            name,
            arguments: {
              databaseName: "_system",
              collectionName: allowedName,
              documentId,
              revision: original._rev,
              ...(name === "updateDocument" ? { patch: { value: "modified" } } : {}),
            },
          });
          assert.equal(result.isError, true, `${name} must reject ${documentId}`);
          assert.deepEqual(await forbidden.document("protected"), original);
        }
      }
    } finally {
      await client.close();
      await Promise.all([allowed.drop(), forbidden.drop()].map((operation) =>
        operation.catch(() => undefined)
      ));
      admin.close();
    }
  },
);

test(
  "preserves the database-side read-only boundary with a dedicated user",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const suffix = `${Date.now()}`;
    const collectionName = `mcp_readonly_${suffix}`;
    const readerName = `mcp_reader_${suffix}`;
    const readerPassword = `reader-${suffix}`;
    const collection = admin.collection(collectionName);
    await collection.create();
    await collection.save({ _key: "visible", value: 1 });
    await admin.createUser(readerName, readerPassword);
    await admin.setUserAccessLevel(readerName, { database: "_system" }, "ro");

    const { client, transport } = createClient(collectionName, {
      readWriteQuery: true,
      credentials: { username: readerName, password: readerPassword },
    });
    try {
      await client.connect(transport);
      const read = await client.callTool({
        name: "readQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR doc IN @@collection RETURN doc._key",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.notEqual(read.isError, true, JSON.stringify(read.content));

      const rejected = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "INSERT { _key: 'blocked' } INTO @@collection",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.equal(rejected.isError, true);
      assert.equal(await collection.documentExists("blocked"), false);
    } finally {
      await client.close();
      await admin.removeUser(readerName).catch(() => undefined);
      await collection.drop().catch(() => undefined);
      admin.close();
    }
  },
);

test(
  "enforces exact and cumulative write-result spool limits",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const collectionName = `mcp_spool_limit_${Date.now()}`;
    const collection = admin.collection(collectionName);
    await collection.create();

    const { client, transport } = createClient(collectionName, {
      readWriteQuery: true,
      limits: { maxWriteSpoolBytes: 1024 },
    });
    try {
      await client.connect(transport);

      const exactBoundary = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "INSERT { _key: 'spool-exact', value: 1 } INTO @@collection RETURN REPEAT('x', 1014)",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.notEqual(exactBoundary.isError, true, JSON.stringify(exactBoundary.content));
      assert.equal(await collection.documentExists("spool-exact"), true);

      const oneByteOver = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "INSERT { _key: 'spool-over', value: 1 } INTO @@collection RETURN REPEAT('x', 1015)",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.equal(oneByteOver.isError, true);
      assert.equal(await collection.documentExists("spool-over"), false);

      const result = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR value IN 1..3 INSERT { _key: CONCAT('spool-', value), value } INTO @@collection RETURN REPEAT('x', 700)",
          bindVars: { "@collection": collectionName },
          pageSize: 1,
        },
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /write result spool|buffered write-query results/i);
      assert.deepEqual(
        await Promise.all(
          [1, 2, 3].map((value) => collection.documentExists(`spool-${value}`)),
        ),
        [false, false, false],
        "the transaction must roll back before any write becomes visible",
      );

      const recovery = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "INSERT { _key: 'spool-recovery', value: 1 } INTO @@collection RETURN NEW._key",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.notEqual(recovery.isError, true, JSON.stringify(recovery.content));
      assert.equal(await collection.documentExists("spool-recovery"), true);
    } finally {
      await client.close();
      await collection.drop().catch(() => undefined);
      admin.close();
    }
  },
);

test(
  "bounds the complete response envelope and reserves cursor capacity atomically",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const collectionName = `mcp_limits_${Date.now()}`;
    const collection = admin.collection(collectionName);
    await collection.create();
    await collection.save([
      { _key: "a", value: "x".repeat(420) },
      { _key: "b", value: "y".repeat(420) },
    ]);

    const { client, transport } = createClient(collectionName, {
      readWriteQuery: true,
      limits: {
        maxBytes: 1536,
        maxActiveCursors: 1,
        cursorTtlSeconds: 1,
      },
    });
    try {
      await client.connect(transport);

      const first = await client.callTool({
        name: "readQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR doc IN @@collection SORT doc._key RETURN doc",
          bindVars: { "@collection": collectionName },
          pageSize: 2,
        },
      });
      assert.notEqual(first.isError, true, JSON.stringify(first.content));
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({
            content: first.content,
            structuredContent: first.structuredContent,
          }),
          "utf8",
        ) <= 1536,
        "the complete MCP tool response must respect maxBytes",
      );
      assert.equal(first.structuredContent.rows.length, 1);
      assert.equal(first.structuredContent.hasMore, true);
      const continuation = await client.callTool({
        name: "continueQuery",
        arguments: {
          cursor: first.structuredContent.nextCursor,
          pageSize: 2,
        },
      });
      assert.equal(continuation.structuredContent.hasMore, false);

      const envelopeOversizedRead = await client.callTool({
        name: "readQuery",
        arguments: {
          databaseName: "_system",
          aql: "RETURN REPEAT('z', 900)",
          pageSize: 1,
        },
      });
      assert.equal(envelopeOversizedRead.isError, true);
      assert.match(envelopeOversizedRead.content[0].text, /complete MCP response envelope/);

      const envelopeOversizedWrite = await client.callTool({
        name: "readWriteQuery",
        arguments: {
          databaseName: "_system",
          aql: "INSERT { _key: 'envelope-write', value: REPEAT('z', 900) } INTO @@collection RETURN NEW.value",
          bindVars: { "@collection": collectionName },
          pageSize: 1,
        },
      });
      assert.notEqual(
        envelopeOversizedWrite.isError,
        true,
        JSON.stringify(envelopeOversizedWrite.content),
      );
      assert.equal(
        envelopeOversizedWrite.structuredContent.rows[0]._mcpResultOmitted,
        true,
      );
      assert.equal(envelopeOversizedWrite.structuredContent.hasMore, false);
      assert.equal(await collection.documentExists("envelope-write"), true);

      const expiring = await client.callTool({
        name: "readQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR doc IN @@collection SORT doc._key RETURN doc._key",
          bindVars: { "@collection": collectionName },
          pageSize: 1,
        },
      });
      assert.ok(expiring.structuredContent.nextCursor);
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      const expired = await client.callTool({
        name: "continueQuery",
        arguments: {
          cursor: expiring.structuredContent.nextCursor,
          pageSize: 1,
        },
      });
      assert.equal(expired.isError, true);
      assert.match(expired.content[0].text, /expired|not found/);

      const calls = await Promise.all([
        client.callTool({
          name: "readQuery",
          arguments: {
            databaseName: "_system",
            aql: "RETURN SLEEP(0.25)",
          },
        }),
        client.callTool({
          name: "readQuery",
          arguments: {
            databaseName: "_system",
            aql: "RETURN SLEEP(0.25)",
          },
        }),
      ]);
      assert.equal(
        calls.filter((result) => result.isError === true).length,
        1,
        "only one concurrent query may reserve the sole cursor slot",
      );
    } finally {
      await client.close();
      await collection.drop().catch(() => undefined);
      admin.close();
    }
  },
);

test(
  "serves a least-privilege user that has no access to _system",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const suffix = `${Date.now()}`;
    const databaseName = `mcp_lowpriv_${suffix}`;
    const collectionName = "documents";
    const readerName = `mcp_lowpriv_reader_${suffix}`;
    const readerPassword = `reader-${suffix}`;
    const { client, transport } = createClient(collectionName, {
      database: databaseName,
      credentials: { username: readerName, password: readerPassword },
    });
    let database;
    try {
      database = await admin.createDatabase(databaseName);
      const collection = database.collection(collectionName);
      await collection.create();
      await collection.save({ _key: "visible", value: 1 });
      await admin.createUser(readerName, readerPassword);
      await admin.setUserAccessLevel(readerName, { database: databaseName }, "ro");
      await admin.setUserAccessLevel(readerName, { database: "_system" }, "none");

      await client.connect(transport);

      const databases = await client.callTool({ name: "listDatabases", arguments: {} });
      assert.notEqual(databases.isError, true, JSON.stringify(databases.content));
      assert.deepEqual(databases.structuredContent.databases, [databaseName]);
      assert.equal(databases.structuredContent.totalDatabases, 1);
      assert.equal(databases.structuredContent.nextCursor, undefined);

      const health = await client.callTool({ name: "healthCheck", arguments: {} });
      assert.notEqual(health.isError, true, JSON.stringify(health.content));
      assert.equal(health.structuredContent.health.status, "ok");
      assert.match(health.structuredContent.health.arangoVersion, /^\d+\.\d+/);

      const read = await client.callTool({
        name: "readQuery",
        arguments: {
          databaseName,
          aql: "FOR doc IN @@collection RETURN doc._key",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.notEqual(read.isError, true, JSON.stringify(read.content));
      assert.deepEqual(read.structuredContent.rows, ["visible"]);
    } finally {
      await client.close().catch(() => undefined);
      await admin.removeUser(readerName).catch(() => undefined);
      database?.close();
      await admin.dropDatabase(databaseName).catch(() => undefined);
      admin.close();
    }
  },
);

test(
  "ignores allowlist entries for collections that do not exist",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const suffix = `${Date.now()}`;
    const collectionName = `mcp_stale_${suffix}`;
    const ghostName = `${collectionName}_ghost`;
    const collection = admin.collection(collectionName);
    await collection.create();
    await collection.save({ _key: "kept", value: 1 });

    const { client, transport } = createClient([collectionName, ghostName]);
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "readQuery",
        arguments: {
          databaseName: "_system",
          aql: "FOR doc IN @@collection RETURN doc._key",
          bindVars: { "@collection": collectionName },
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.deepEqual(result.structuredContent.rows, ["kept"]);
    } finally {
      await client.close().catch(() => undefined);
      await collection.drop().catch(() => undefined);
      admin.close();
    }
  },
);

test(
  "queries ArangoSearch views through their linked collections",
  { skip: !url, timeout: 90_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const suffix = `${Date.now()}`;
    const firstCollection = `mcp_view_first_${suffix}`;
    const secondCollection = `mcp_view_second_${suffix}`;
    const viewName = `mcp_view_${suffix}`;
    const aql = `FOR doc IN ${viewName} SORT doc._key RETURN doc._key`;
    const allowedClient = createClient([firstCollection, secondCollection], {
      limits: { maxRows: 10 },
    });
    const partialClient = createClient([firstCollection], { limits: { maxRows: 10 } });
    try {
      await admin.collection(firstCollection).create();
      await admin.collection(secondCollection).create();
      await admin.collection(firstCollection).save([
        { _key: "a", value: 1 },
        { _key: "b", value: 2 },
      ]);
      await admin.collection(secondCollection).save({ _key: "c", value: 3 });
      await admin.createView(viewName, {
        type: "arangosearch",
        links: {
          [firstCollection]: { includeAllFields: true },
          [secondCollection]: { includeAllFields: true },
        },
      });
      await waitForViewDocuments(admin, viewName, 3);

      await allowedClient.client.connect(allowedClient.transport);
      const result = await allowedClient.client.callTool({
        name: "readQuery",
        arguments: { databaseName: "_system", aql },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.deepEqual(result.structuredContent.rows, ["a", "b", "c"]);

      const explanation = await allowedClient.client.callTool({
        name: "explainQuery",
        arguments: { databaseName: "_system", aql },
      });
      assert.notEqual(explanation.isError, true, JSON.stringify(explanation.content));
      assert.deepEqual(explanation.structuredContent.views, [viewName]);
      assert.deepEqual(
        explanation.structuredContent.collections.map(({ name }) => name).sort(),
        [firstCollection, secondCollection].sort(),
      );

      await partialClient.client.connect(partialClient.transport);
      const rejected = await partialClient.client.callTool({
        name: "readQuery",
        arguments: { databaseName: "_system", aql },
      });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /is not allowed by server policy/);
      assert.match(rejected.content[0].text, new RegExp(secondCollection));
    } finally {
      await allowedClient.client.close().catch(() => undefined);
      await partialClient.client.close().catch(() => undefined);
      await admin.view(viewName).drop().catch(() => undefined);
      await Promise.all(
        [firstCollection, secondCollection].map((name) =>
          admin.collection(name).drop().catch(() => undefined)
        ),
      );
      admin.close();
    }
  },
);

test(
  "lists graphs and views under the collection allowlist and infers schemas",
  { skip: !url, timeout: 90_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const suffix = `${Date.now()}`;
    const verticesA = `mcp_graph_a_${suffix}`;
    const verticesB = `mcp_graph_b_${suffix}`;
    const orphan = `mcp_graph_orphan_${suffix}`;
    const forbiddenVertices = `mcp_graph_forbidden_${suffix}`;
    const allowedEdges = `mcp_graph_edges_${suffix}`;
    const forbiddenEdges = `mcp_graph_forbidden_edges_${suffix}`;
    const mixedEdges = `mcp_graph_mixed_edges_${suffix}`;
    const documents = `mcp_schema_docs_${suffix}`;
    const allowedGraphName = `mcp_graph_allowed_${suffix}`;
    const forbiddenGraphName = `mcp_graph_forbidden_${suffix}`;
    const mixedGraphName = `mcp_graph_mixed_${suffix}`;
    const allowedViewName = `mcp_view_allowed_${suffix}`;
    const forbiddenViewName = `mcp_view_forbidden_${suffix}`;
    const aliasViewName = `mcp_view_alias_${suffix}`;
    const indexName = `mcp_view_index_${suffix}`;
    const allowedCollections = [
      verticesA,
      verticesB,
      orphan,
      allowedEdges,
      mixedEdges,
      documents,
    ];
    const droppedCollections = [
      ...allowedCollections,
      forbiddenVertices,
      forbiddenEdges,
    ];

    await Promise.all([
      admin.collection(verticesA).create(),
      admin.collection(verticesB).create(),
      admin.collection(orphan).create(),
      admin.collection(forbiddenVertices).create(),
      admin.createEdgeCollection(allowedEdges),
      admin.createEdgeCollection(forbiddenEdges),
      admin.createEdgeCollection(mixedEdges),
      admin.collection(documents).create(),
    ]);
    await admin.collection(documents).save([
      { _key: "a", name: "x", address: { city: "Paris" }, tags: [{ name: "t" }], score: 1, nil: null },
      { _key: "b", name: "y", address: { city: "Lyon", zip: "1" }, tags: [], score: "high" },
      { _key: "c", tags: ["plain"], score: 2.5, flag: true },
    ]);
    await admin.collection(documents).ensureIndex({
      type: "inverted",
      name: indexName,
      fields: ["name"],
    });
    const allowedGraph = admin.graph(allowedGraphName);
    const forbiddenGraph = admin.graph(forbiddenGraphName);
    const mixedGraph = admin.graph(mixedGraphName);
    await allowedGraph.create([
      { collection: allowedEdges, from: [verticesA], to: [verticesB] },
    ]);
    await allowedGraph.addVertexCollection(orphan);
    await forbiddenGraph.create([
      { collection: forbiddenEdges, from: [forbiddenVertices], to: [forbiddenVertices] },
    ]);
    await mixedGraph.create([
      { collection: mixedEdges, from: [verticesA], to: [forbiddenVertices] },
    ]);
    await admin.createView(allowedViewName, {
      type: "arangosearch",
      links: {
        [documents]: { includeAllFields: true },
        [verticesA]: {
          fields: { name: { analyzers: ["identity"] } },
          storeValues: "id",
          trackListPositions: true,
        },
      },
      primarySort: [{ field: "name", direction: "asc" }],
    });
    await admin.createView(forbiddenViewName, {
      type: "arangosearch",
      links: { [forbiddenVertices]: { includeAllFields: true } },
    });
    await admin.createView(aliasViewName, {
      type: "search-alias",
      indexes: [{ collection: documents, index: indexName }],
    });

    const { client, transport } = createClient(allowedCollections);
    try {
      await client.connect(transport);

      const listedCollections = await collectPages(
        client,
        "listCollections",
        { databaseName: "_system", limit: 2 },
        "collections",
      );
      assert.deepEqual(
        listedCollections.map(({ name }) => name).sort(),
        [...allowedCollections].sort(),
      );
      assert.equal(
        listedCollections.find(({ name }) => name === documents)?.count,
        3,
      );

      const listedGraphs = await collectPages(
        client,
        "listGraphs",
        { databaseName: "_system", limit: 2 },
        "graphs",
      );
      const graphNames = listedGraphs.map(({ name }) => name);
      assert.ok(graphNames.includes(allowedGraphName));
      assert.ok(!graphNames.includes(forbiddenGraphName));
      assert.ok(
        !graphNames.includes(mixedGraphName),
        "a graph reading a non-allowlisted collection must be hidden",
      );
      const allowed = listedGraphs.find(({ name }) => name === allowedGraphName);
      assert.deepEqual(allowed.edgeDefinitions, [
        { collection: allowedEdges, from: [verticesA], to: [verticesB] },
      ]);
      assert.deepEqual(allowed.orphanCollections, [orphan]);

      const listedViews = await collectPages(
        client,
        "listViews",
        { databaseName: "_system", limit: 2 },
        "views",
      );
      const viewNames = listedViews.map(({ name }) => name);
      assert.ok(viewNames.includes(allowedViewName));
      assert.ok(viewNames.includes(aliasViewName));
      assert.ok(
        !viewNames.includes(forbiddenViewName),
        "a view linked to a non-allowlisted collection must be hidden",
      );
      const arangosearch = listedViews.find(({ name }) => name === allowedViewName);
      assert.deepEqual(arangosearch.collections, [documents, verticesA].sort());
      assert.equal(arangosearch.links[documents].includeAllFields, true);
      assert.equal(arangosearch.links[documents].storeValues, undefined);
      assert.equal(arangosearch.links[documents].trackListPositions, undefined);
      assert.deepEqual(arangosearch.links[verticesA].fields, { name: {} });
      assert.equal(arangosearch.links[verticesA].storeValues, "id");
      assert.equal(arangosearch.links[verticesA].trackListPositions, true);
      assert.equal(arangosearch.primarySort[0].field, "name");
      const alias = listedViews.find(({ name }) => name === aliasViewName);
      assert.deepEqual(alias.collections, [documents]);
      assert.deepEqual(alias.indexes, [{ collection: documents, index: indexName }]);

      const schema = await client.callTool({
        name: "inferSchema",
        arguments: { databaseName: "_system", collectionName: documents, sampleSize: 100 },
      });
      assert.notEqual(schema.isError, true, JSON.stringify(schema.content));
      assert.equal(schema.structuredContent.sampledDocuments, 3);
      assert.equal(schema.structuredContent.truncated, false);
      assert.deepEqual(schema.structuredContent.fields, [
        { path: "_id", types: { string: 3 } },
        { path: "_key", types: { string: 3 } },
        { path: "_rev", types: { string: 3 } },
        { path: "address", types: { object: 2 } },
        { path: "address.city", types: { string: 2 } },
        { path: "address.zip", types: { string: 1 } },
        { path: "flag", types: { bool: 1 } },
        { path: "name", types: { string: 2 } },
        { path: "nil", types: { null: 1 } },
        { path: "score", types: { number: 2, string: 1 } },
        { path: "tags", types: { array: 3 } },
        { path: "tags[].name", types: { string: 1 } },
      ]);

      const limited = await client.callTool({
        name: "inferSchema",
        arguments: { databaseName: "_system", collectionName: documents, sampleSize: 1 },
      });
      assert.equal(limited.structuredContent.sampledDocuments, 1);
      assert.deepEqual(limited.structuredContent.fields, [
        { path: "_id", types: { string: 1 } },
        { path: "_key", types: { string: 1 } },
        { path: "_rev", types: { string: 1 } },
        { path: "address", types: { object: 1 } },
        { path: "address.city", types: { string: 1 } },
        { path: "name", types: { string: 1 } },
        { path: "nil", types: { null: 1 } },
        { path: "score", types: { number: 1 } },
        { path: "tags", types: { array: 1 } },
        { path: "tags[].name", types: { string: 1 } },
      ]);

      const refused = await client.callTool({
        name: "inferSchema",
        arguments: {
          databaseName: "_system",
          collectionName: forbiddenVertices,
          sampleSize: 10,
        },
      });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /is not allowed by server policy/);
      assert.match(refused.content[0].text, new RegExp(forbiddenVertices));
    } finally {
      await client.close().catch(() => undefined);
      await Promise.all(
        [allowedViewName, forbiddenViewName, aliasViewName].map((name) =>
          admin.view(name).drop().catch(() => undefined),
        ),
      );
      await Promise.all(
        [allowedGraphName, forbiddenGraphName, mixedGraphName].map((name) =>
          admin.graph(name).drop().catch(() => undefined),
        ),
      );
      await Promise.all(
        droppedCollections.map((name) =>
          admin.collection(name).drop().catch(() => undefined),
        ),
      );
      admin.close();
    }
  },
);

test(
  "derives the database allowlist from collection entries",
  { skip: !url, timeout: 60_000 },
  async () => {
    const admin = new Database({
      url,
      databaseName: "_system",
      auth: { username, password },
    });
    const suffix = `${Date.now()}`;
    const visibleDatabase = `mcp_policy_visible_${suffix}`;
    const hiddenDatabase = `mcp_policy_hidden_${suffix}`;
    const collectionName = "documents";
    let visible;
    try {
      visible = await admin.createDatabase(visibleDatabase);
      const hidden = await admin.createDatabase(hiddenDatabase);
      await hidden.collection(collectionName).create();
      await visible.collection(collectionName).create();
      await visible.collection(collectionName).save({ _key: "kept", value: 1 });
      hidden.close();

      const { client, transport } = createClient(collectionName, {
        database: visibleDatabase,
        databaseAllowlist: false,
      });
      try {
        await client.connect(transport);

        const databases = await client.callTool({
          name: "listDatabases",
          arguments: {},
        });
        assert.notEqual(databases.isError, true, JSON.stringify(databases.content));
        assert.deepEqual(databases.structuredContent.databases, [visibleDatabase]);

        const rejected = await client.callTool({
          name: "readQuery",
          arguments: {
            databaseName: hiddenDatabase,
            aql: "FOR doc IN @@collection RETURN doc",
            bindVars: { "@collection": collectionName },
          },
        });
        assert.equal(rejected.isError, true);
        assert.match(
          rejected.content[0].text,
          new RegExp(`Database "${hiddenDatabase}" is not allowed by server policy`),
        );

        const accepted = await client.callTool({
          name: "readQuery",
          arguments: {
            databaseName: visibleDatabase,
            aql: "FOR doc IN @@collection RETURN doc._key",
            bindVars: { "@collection": collectionName },
          },
        });
        assert.notEqual(accepted.isError, true, JSON.stringify(accepted.content));
        assert.deepEqual(accepted.structuredContent.rows, ["kept"]);
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      visible?.close();
      await admin.dropDatabase(visibleDatabase).catch(() => undefined);
      await admin.dropDatabase(hiddenDatabase).catch(() => undefined);
      admin.close();
    }
  },
);

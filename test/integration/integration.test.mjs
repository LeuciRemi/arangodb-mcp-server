import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "arangojs";

const url = process.env.ARANGO_TEST_URL;
const username = process.env.ARANGO_TEST_USERNAME ?? "root";
const password = process.env.ARANGO_TEST_PASSWORD ?? "test";

function createClient(
  collectionNames,
  {
    documentWrites = false,
    readWriteQuery = false,
    limits = {},
    credentials = { username, password },
  } = {},
) {
  const allowedCollections = (Array.isArray(collectionNames)
    ? collectionNames
    : [collectionNames]
  ).map((collectionName) => `_system/${collectionName}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      ARANGO_URL: url,
      ARANGO_USERNAME: credentials.username,
      ARANGO_PASSWORD: credentials.password,
      ARANGO_ALLOWED_DATABASES: "_system",
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
    },
  });
  return {
    client: new Client(
      { name: "integration-test", version: "1.0.0" },
      { capabilities: {} },
    ),
    transport,
  };
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
    await collection.create();
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
      const secondCollectionPage = await client.callTool({
        name: "listCollections",
        arguments: {
          databaseName: "_system",
          limit: 2,
          cursor: firstCollectionPage.structuredContent.nextCursor,
        },
      });
      assert.equal(secondCollectionPage.structuredContent.collections.length, 1);
      assert.equal(secondCollectionPage.structuredContent.truncated, false);

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

      const resource = await client.readResource({
        uri: `arangodb:///_system/${collectionName}`,
      });
      const metadata = JSON.parse(resource.contents[0].text);
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

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("advertises the minimal structured tool profile by default", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      ARANGO_URL: "http://127.0.0.1:1",
      ARANGO_ENABLE_DOCUMENT_WRITES: "false",
      ARANGO_ENABLE_READ_WRITE_QUERY: "false",
    },
  });
  const client = new Client(
    { name: "contract-test", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes("readQuery"));
    assert.ok(names.includes("continueQuery"));
    assert.ok(names.includes("describeCollection"));
    assert.ok(names.includes("sampleDocuments"));
    assert.ok(!names.includes("explainQuery"));
    assert.ok(!names.includes("healthCheck"));
    assert.ok(!names.includes("readWriteQuery"));
    assert.equal(names.length, 6);

    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} has outputSchema`);
      assert.equal(tool.annotations?.openWorldHint, false);
    }
    assert.equal(
      tools.find((tool) => tool.name === "readQuery")?.annotations?.readOnlyHint,
      true,
    );
    const continueQuery = tools.find((tool) => tool.name === "continueQuery");
    assert.equal(continueQuery?.annotations?.readOnlyHint, true);
    assert.equal(continueQuery?.annotations?.idempotentHint, false);

    const { resourceTemplates } = await client.listResourceTemplates();
    assert.deepEqual(
      resourceTemplates.map((template) => template.uriTemplate).sort(),
      [
        "arangodb:///{database}/{collection}",
        "arangodb:///{database}/{collection}/{documentId}",
      ],
    );

    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((prompt) => prompt.name === "exploreDatabase"));
    assert.equal(client.getServerVersion()?.version, "2.0.0");
  } finally {
    await client.close();
  }
});

test("separates document CRUD from arbitrary write-capable AQL", async () => {
  async function listedTools(env) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: {
        ...process.env,
        ARANGO_URL: "http://127.0.0.1:1",
        ARANGO_ENABLE_DIAGNOSTIC_TOOLS: "false",
        ...env,
      },
    });
    const client = new Client(
      { name: "write-profile-contract-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      return (await client.listTools()).tools;
    } finally {
      await client.close();
    }
  }

  const documentTools = await listedTools({
    ARANGO_ENABLE_DOCUMENT_WRITES: "true",
    ARANGO_ENABLE_READ_WRITE_QUERY: "false",
  });
  const documentToolNames = documentTools.map((tool) => tool.name);
  assert.ok(documentToolNames.includes("insertDocument"));
  assert.ok(documentToolNames.includes("updateDocument"));
  assert.ok(documentToolNames.includes("deleteDocument"));
  assert.ok(!documentToolNames.includes("readWriteQuery"));

  const queryTools = await listedTools({
    ARANGO_ENABLE_DOCUMENT_WRITES: "false",
    ARANGO_ENABLE_READ_WRITE_QUERY: "true",
  });
  const queryToolNames = queryTools.map((tool) => tool.name);
  assert.ok(queryToolNames.includes("readWriteQuery"));
  assert.ok(!queryToolNames.includes("insertDocument"));
  assert.ok(!queryToolNames.includes("updateDocument"));
  assert.ok(!queryToolNames.includes("deleteDocument"));
  const writeContinuation = queryTools.find((tool) => tool.name === "continueQuery");
  assert.equal(writeContinuation?.annotations?.readOnlyHint, false);
  assert.equal(writeContinuation?.annotations?.destructiveHint, true);
  assert.equal(writeContinuation?.annotations?.idempotentHint, false);
});

test("adds diagnostic tools only when explicitly enabled", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      ARANGO_URL: "http://127.0.0.1:1",
      ARANGO_ENABLE_DOCUMENT_WRITES: "false",
      ARANGO_ENABLE_READ_WRITE_QUERY: "false",
      ARANGO_ENABLE_DIAGNOSTIC_TOOLS: "true",
    },
  });
  const client = new Client(
    { name: "diagnostic-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("explainQuery"));
    assert.ok(names.includes("healthCheck"));
    assert.equal(names.length, 8);
  } finally {
    await client.close();
  }
});

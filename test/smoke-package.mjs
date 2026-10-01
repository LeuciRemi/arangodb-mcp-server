import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const installDirectory = mkdtempSync(join(tmpdir(), "arangodb-mcp-package-"));
const testEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("ARANGO_")),
);
let databaseRequests = 0;
const databaseServer = createServer((request, response) => {
  if (!/^\/_db\/_system\/_api\/database(?:\/user)?$/.test(request.url)) {
    response.writeHead(404).end();
    return;
  }
  databaseRequests += 1;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: false, code: 200, result: ["package_smoke"] }));
});
let tarballPath;
let client;

try {
  const packed = spawnSync("npm", ["pack", "--json"], {
    cwd: projectDirectory,
    encoding: "utf8",
  });
  assert.equal(
    packed.status,
    0,
    packed.error?.message ?? packed.stderr ?? packed.stdout ?? "npm pack failed",
  );
  const parsedPackResult = JSON.parse(packed.stdout);
  const packEntries = Array.isArray(parsedPackResult)
    ? parsedPackResult
    : Object.values(parsedPackResult);
  assert.equal(packEntries.length, 1);
  tarballPath = join(projectDirectory, packEntries[0].filename);

  const installed = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: installDirectory, encoding: "utf8" },
  );
  assert.equal(
    installed.status,
    0,
    installed.error?.message ?? installed.stderr ?? installed.stdout ?? "npm install failed",
  );

  const binary = join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "arangodb-mcp-server.cmd" : "arangodb-mcp-server",
  );
  const smoke = spawnSync(binary, ["--help"], {
    cwd: installDirectory,
    encoding: "utf8",
  });
  assert.equal(
    smoke.status,
    0,
    smoke.error?.message ?? smoke.stderr ?? smoke.stdout ?? "package binary failed",
  );
  assert.match(`${smoke.stdout}\n${smoke.stderr}`, /Usage:\s+arangodb-mcp-server/);

  databaseServer.listen(0, "127.0.0.1");
  await once(databaseServer, "listening");
  const address = databaseServer.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installDirectory, "node_modules", "arangodb-mcp-server", "dist", "index.js")],
    cwd: installDirectory,
    env: {
      ...testEnvironment,
      ARANGO_URL: `http://127.0.0.1:${address.port}`,
      ARANGO_ALLOWED_DATABASES: "package_smoke",
      ARANGO_MCP_REQUEST_TIMEOUT: "5000",
    },
  });
  client = new Client({ name: "package-smoke-test", version: "1.0.0" });
  await client.connect(transport, { timeout: 10_000 });
  assert.equal(client.getServerVersion()?.version, packEntries[0].version);
  const { tools } = await client.listTools(undefined, { timeout: 10_000 });
  assert.ok(tools.some((tool) => tool.name === "listDatabases"));
  assert.ok(tools.some((tool) => tool.name === "readQuery"));
  const databases = await client.callTool(
    { name: "listDatabases", arguments: {} },
    undefined,
    { timeout: 10_000 },
  );
  assert.notEqual(databases.isError, true, JSON.stringify(databases.content));
  assert.deepEqual(databases.structuredContent.databases, [{ name: "package_smoke" }]);
  assert.equal(databaseRequests, 1);
} finally {
  await client?.close();
  if (databaseServer.listening) {
    databaseServer.closeAllConnections();
    await new Promise((resolve, reject) =>
      databaseServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(installDirectory, { recursive: true, force: true });
}

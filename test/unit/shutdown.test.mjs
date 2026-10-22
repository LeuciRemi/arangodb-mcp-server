import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";

import { parseConfig } from "../../dist/src/config.js";
import { createArangoMcpServer } from "../../dist/src/server.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("transport disconnection closes the service once, including concurrent application closes", async (t) => {
  const app = createArangoMcpServer(parseConfig([], { ARANGO_URL: "http://127.0.0.1:1" }), "test");
  const originalClose = app.service.close.bind(app.service);
  let closes = 0;
  app.service.close = async () => {
    closes += 1;
    await originalClose();
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shutdown-test", version: "1" });
  t.after(async () => {
    await client.close();
    await app.close();
  });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.close();
  await new Promise(setImmediate);
  assert.equal(closes, 1, "transport EOF must initiate service cleanup on its own");
  const first = app.close();
  const second = app.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(closes, 1);
});

test("service cleanup still runs if transport shutdown fails", async () => {
  const app = createArangoMcpServer(parseConfig([], { ARANGO_URL: "http://127.0.0.1:1" }), "test");
  const originalClose = app.service.close.bind(app.service);
  let closes = 0;
  app.service.close = async () => {
    closes += 1;
    await originalClose();
  };
  app.server.close = async () => { throw new Error("transport close failed"); };
  await assert.rejects(app.close(), /transport close failed/);
  await assert.rejects(app.close(), /transport close failed/);
  assert.equal(closes, 1);
});

test("normal stdin EOF removes pending write-result spool files before exit", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "arangodb-mcp-shutdown-test-"));
  const spoolPath = join(directory, "pending-results");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { open } from "node:fs/promises";
    import { ArangoDBService } from "./dist/src/arangodb-service.js";
    const close = ArangoDBService.prototype.close;
    ArangoDBService.prototype.close = async function () {
      await close.call(this);
      process.stderr.write("REVIEW_CLEANUP_COMPLETE\\n");
    };
    ArangoDBService.prototype.listDatabases = async function () {
      const path = process.env.REVIEW_SPOOL_PATH;
      const file = await open(path, "wx+", 0o600);
      const contents = "private query result";
      await file.writeFile(contents);
      this.cursorSessions.set("pending-write", {
        token: "pending-write", databaseName: "db", isWrite: true,
        expiresAt: Date.now() + 30_000, pending: [], cursor: { hasNext: false },
        spool: { file, path, offset: 0, size: Buffer.byteLength(contents) },
      });
      return ["db"];
    };
    await import("./dist/index.js");
  `], {
    cwd: repository,
    env: { ARANGO_URL: "http://127.0.0.1:1", REVIEW_SPOOL_PATH: spoolPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      for (const request of pending.values()) {
        request.reject(new Error(`Child exited before responding: ${stderr}`));
      }
      resolve({ code, signal });
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "eof-test", version: "1" },
  });
  assert.ok(initialized.result);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const result = await request(2, "tools/call", { name: "listDatabases", arguments: {} });
  assert.equal(result.result?.isError, undefined);
  assert.equal(await readFile(spoolPath, "utf8"), "private query result");

  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(stderr.split("REVIEW_CLEANUP_COMPLETE").length - 1, 1);
  await assert.rejects(stat(spoolPath), { code: "ENOENT" });
});

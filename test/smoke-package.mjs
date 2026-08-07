import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectDirectory = resolve(import.meta.dirname, "..");
const installDirectory = mkdtempSync(join(tmpdir(), "arangodb-mcp-package-"));
let tarballPath;

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
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(installDirectory, { recursive: true, force: true });
}

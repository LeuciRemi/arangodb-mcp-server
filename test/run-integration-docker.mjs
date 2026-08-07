import { execFileSync, spawnSync } from "node:child_process";
import net from "node:net";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const port = await reservePort();
const containerName = `arangodb-mcp-integration-${process.pid}`;
const url = `http://127.0.0.1:${port}`;

try {
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `127.0.0.1:${port}:8529`,
      "--env",
      "ARANGO_ROOT_PASSWORD=test",
      "arangodb:3.12",
    ],
    { stdio: "inherit" },
  );

  const authorization = `Basic ${Buffer.from("root:test").toString("base64")}`;
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/_api/version`, {
        headers: { authorization },
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // ArangoDB is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    throw new Error("ArangoDB integration container did not become ready within 60 seconds");
  }

  const result = spawnSync("npm", ["run", "test:integration"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ARANGO_TEST_URL: url,
      ARANGO_TEST_USERNAME: "root",
      ARANGO_TEST_PASSWORD: "test",
    },
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore" });
}

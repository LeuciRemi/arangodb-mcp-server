// Development loop: recompile on change and serve the build through MCP Inspector.
// Inspector starts a new server process on every connection, so reconnecting in
// its UI is enough to pick up a rebuild.
import { spawn, spawnSync } from "node:child_process";

const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const children = [
  spawn("npx", ["tsc", "--watch", "--preserveWatchOutput"], { stdio: "inherit" }),
  spawn(
    "npx",
    [
      "--yes",
      "@modelcontextprotocol/inspector@2.12.0",
      // Inspector 2 does not forward the parent environment to the server.
      "-e",
      "ARANGO_URL=http://127.0.0.1:18529",
      "-e",
      "ARANGO_USERNAME=root",
      "-e",
      "ARANGO_PASSWORD=root",
      "--",
      "node",
      "dist/index.js",
    ],
    { stdio: "inherit" },
  ),
];

const stop = () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children) {
  child.once("exit", stop);
}

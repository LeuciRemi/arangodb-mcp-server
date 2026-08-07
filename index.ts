#!/usr/bin/env node

import { createRequire } from "node:module";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, HelpRequested, parseConfig, USAGE } from "./src/config.js";
import { createArangoMcpServer } from "./src/server.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.error(USAGE);
      return;
    }
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}\n\n${USAGE}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (config.credentialsFromCli) {
    console.error(
      "Security warning: prefer ARANGO_USERNAME and ARANGO_PASSWORD over CLI credentials so secrets are not visible in the process list.",
    );
  }

  const application = createArangoMcpServer(config, packageJson.version);
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await application.close().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Shutdown error: ${message}`);
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await application.server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Server startup failed: ${message}`);
  process.exitCode = 1;
});

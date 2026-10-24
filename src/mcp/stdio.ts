#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createBusMcpServer } from "./server.ts";

const handle = serveStdio(() => createBusMcpServer(), {
  onerror: (error) => console.error(`MCP transport error: ${error.message}`),
});

process.once("SIGINT", () => {
  void handle.close().finally(() => process.exit(0));
});

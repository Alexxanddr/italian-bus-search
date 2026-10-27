#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createBusMcpServer } from "./server.ts";

const handle = serveStdio(() => createBusMcpServer(), {
  onerror: () => console.error("MCP transport error"),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  const deadline = setTimeout(() => process.exit(1), 5_000);
  deadline.unref();
  void handle.close().finally(() => { clearTimeout(deadline); process.exit(0); });
});

import { createServer } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535");

const server = createServer().listen(port, host, () => {
  console.log(`Italian transport API and MCP server listening on http://${host}:${port}`);
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 20_000);
  deadline.unref();
  server.close(() => { clearTimeout(deadline); process.exit(0); });
});

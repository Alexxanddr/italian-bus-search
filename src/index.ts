import { createServer } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535");

createServer().listen(port, "127.0.0.1", () => {
  console.log(`Unofficial bus search API listening on http://127.0.0.1:${port}`);
});

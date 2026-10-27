import { AppError } from "./domain.ts";

export async function responseBytes(response: Response, label: string, maximumBytes = 5_000_000): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get("content-length")) > maximumBytes) throw new Error("oversized");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error("oversized");
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new AppError("INCOMPATIBLE_RESPONSE", `${label} response is unreadable or too large`, 502);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

export async function responseText(response: Response, label: string, maximumBytes?: number): Promise<string> {
  return (await responseBytes(response, label, maximumBytes)).toString("utf8");
}

export async function responseJson(response: Response, label: string, maximumBytes?: number): Promise<unknown> {
  const text = await responseText(response, label, maximumBytes);
  try { return JSON.parse(text); }
  catch { throw new AppError("INCOMPATIBLE_RESPONSE", `Invalid ${label} response`, 502); }
}

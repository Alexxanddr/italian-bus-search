import assert from "node:assert/strict";
import test from "node:test";
import { TtlCache } from "../src/cache.ts";
import { responseJson } from "../src/upstream.ts";
import { validateSearchInput } from "../src/validation.ts";
import { AppError } from "../src/domain.ts";

test("bounds caches and expires observations", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const cache = new TtlCache<number>(60, 2);
  cache.set("a", 1); cache.set("b", 2); cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  context.mock.timers.tick(61);
  assert.equal(cache.get("b"), undefined);
  cache.set("d", 4);
  assert.equal(cache.get("d"), 4);
});

test("cancels oversized streamed responses without exposing upstream data", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("private-upstream-body")); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(responseJson(response, "synthetic", 10), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE" && !error.message.includes("private-upstream-body"));
  assert.equal(cancelled, true);
  assert.deepEqual(await responseJson(Response.json({ ok: true }), "synthetic"), { ok: true });
});

test("uses the Italian calendar date at midnight and validates bounded text", () => {
  const input = { origin: "Roma", destination: "Cosenza", date: "2026-10-28" };
  assert.throws(() => validateSearchInput(input, new Date("2026-10-27T23:30:00Z")), /future date/);
  assert.equal(validateSearchInput({ ...input, date: "2026-10-29" }, new Date("2026-10-27T23:30:00Z")).date, "2026-10-29");
  assert.throws(() => validateSearchInput({ ...input, date: "2027-01-01", origin: "a".repeat(201) }, new Date("2026-10-27T12:00:00Z")), /200 characters/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { SearchSnapshots } from "../src/snapshots.ts";

const start = { snapshot: true, offset: 0, limit: 1, hasQuery: true };
test("pins order, prices, total and partial failures despite upstream changes or returned-object mutations", async () => {
  const snapshots = new SearchSnapshots();
  let calls = 0;
  const result = { journeys: [{ id: 1, price: 10 }, { id: 2, price: 20 }], errors: [{ provider: "italo", code: "QUOTE_UNAVAILABLE" as const, message: "down" }] };
  const load = async () => { calls++; return result; };
  const first = await snapshots.page("train", load, start);
  result.journeys.reverse(); result.journeys[0]!.price = 999; result.errors.length = 0;
  first.journeys[0]!.price = 777; first.errors.length = 0;
  const next = await snapshots.page("train", load, { searchId: first.searchId, offset: 1, limit: 1, hasQuery: false });
  assert.equal(calls, 1); assert.deepEqual(next.journeys, [{ id: 2, price: 20 }]);
  assert.equal(next.errors[0]?.code, "QUOTE_UNAVAILABLE"); assert.equal(next.total, 2);
  assert.equal(next.truncated, false); assert.equal(next.expiresAt, first.expiresAt);
  const fresh = await snapshots.page("train", load, start);
  assert.equal(calls, 2); assert.equal(fresh.errors.length, 0);
});

test("expires without renewing on reads, rejects evicted or restarted IDs and binds IDs to transport mode", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const snapshots = new SearchSnapshots();
  const load = async () => ({ journeys: [1, 2], errors: [] });
  const first = await snapshots.page("bus", load, start);
  const next = { searchId: first.searchId!, offset: 1, limit: 1, hasQuery: false };
  await assert.rejects(snapshots.page("train", load, next), (e: unknown) => e instanceof AppError && e.code === "SEARCH_EXPIRED");
  await assert.rejects(new SearchSnapshots().page("bus", load, next), /expired/);
  context.mock.timers.tick(299_999); await snapshots.page("bus", load, next);
  context.mock.timers.tick(1); await assert.rejects(snapshots.page("bus", load, next), /expired/);
  const evicted = await snapshots.page("bus", load, start);
  for (let i = 0; i < 32; i++) await snapshots.page("bus", load, start);
  await assert.rejects(snapshots.page("bus", load, { ...next, searchId: evicted.searchId! }), /expired/);
});

test("validates pagination and conflicting query parameters before loading", async () => {
  const snapshots = new SearchSnapshots(); let calls = 0;
  const load = async () => { calls++; return { journeys: [1], errors: [] }; };
  for (const options of [{ ...start, offset: -1 }, { ...start, offset: 1 }, { ...start, limit: 51 }, { ...start, limit: 0 }, { ...start, searchId: "bad" }, { ...start, searchId: "00000000-0000-0000-0000-000000000000" }])
    await assert.rejects(snapshots.page("bus", load, options), (e: unknown) => e instanceof AppError && e.code === "INVALID_INPUT");
  assert.equal(calls, 0);
});

test("bounds snapshot size and preserves legacy pages without metadata", async () => {
  const snapshots = new SearchSnapshots();
  const load = async () => ({ journeys: ["a".repeat(1_048_576)], errors: [] });
  await assert.rejects(snapshots.page("bus", load, start), (e: unknown) => e instanceof AppError && e.code === "SEARCH_TOO_LARGE");
  const legacy = await snapshots.page("bus", load, { ...start, snapshot: false });
  assert.equal("searchId" in legacy, false); assert.equal(legacy.total, 1);
  const empty = await snapshots.page("bus", async () => ({ journeys: [], errors: [] }), start);
  assert.equal(empty.total, 0); assert.equal(empty.truncated, false); assert.ok(empty.searchId);
});

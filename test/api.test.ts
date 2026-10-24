import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import type { Provider } from "../src/providers/provider.ts";

const provider: Provider = {
  id: "itabus",
  status: "available",
  searchLocations: async (query) => query === "Roma" ? [{
    provider: "itabus",
    id: "ROM1",
    name: "Roma (Tiburtina Terminal Bus)",
    city: "Roma",
    source: "live",
  }] : [],
  searchJourneys: async () => [],
};

test("serves health and validates journey input", async () => {
  const app = createApp([provider]);

  const health = await app(new Request("http://localhost/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const invalid = await app(new Request("http://localhost/journeys?origin=Roma&destination=Milano&date=bad"));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: { code: "INVALID_INPUT", message: "date must be a real future date in YYYY-MM-DD format" },
  });
});

test("finds Itabus locations", async () => {
  const app = createApp([provider]);

  const response = await app(new Request("http://localhost/locations?query=Roma&provider=itabus"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { locations: Array<{ id: string }> };
  assert.equal(body.locations[0]?.id, "ROM1");
});

test("enables every live provider by default", async () => {
  const app = createApp();

  const response = await app(new Request("http://localhost/providers"));
  assert.equal(response.status, 200);
  assert.deepEqual(
    ((await response.json()) as { providers: Array<{ id: string; status: string }> }).providers
      .map(({ id, status }) => ({ id, status })),
    [
      { id: "itabus", status: "available" },
      { id: "salemi", status: "available" },
      { id: "federico", status: "available" },
      { id: "marinobus", status: "available" },
    { id: "flixbus", status: "available" },
    ],
  );
});

test("rate limits a client after 60 requests per minute", async () => {
  const app = createApp([provider]);
  for (let request = 0; request < 60; request += 1) {
    assert.equal((await app(new Request("http://localhost/health"), "client")).status, 200);
  }
  const response = await app(new Request("http://localhost/health"), "client");
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: { code: "RATE_LIMITED", message: "Rate limit exceeded" },
  });
});

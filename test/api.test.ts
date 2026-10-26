import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import type { Provider } from "../src/providers/provider.ts";
import type { RailLiveProvider, RailQuoteProvider, RailScheduleProvider } from "../src/rail/provider.ts";

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

test("lists train providers and configured price/live capabilities separately from buses", async () => {
  const rail: RailScheduleProvider = { id: "italo", searchLocations: async () => [], searchJourneys: async () => [] };
  const quote: RailQuoteProvider = { id: "italo", searchQuotes: async () => [] };
  const live: RailLiveProvider = { id: "italo", getTrainStatus: async () => { throw new Error("unused"); }, getStationBoard: async () => { throw new Error("unused"); } };
  const app = createApp([provider], [rail], [live], [quote]);
  assert.deepEqual(await (await app(new Request("http://localhost/train-providers"))).json(), {
    providers: [{ id: "italo", capabilities: { schedule: true, price: true, liveStatus: true, stationBoard: true } }],
  });
  assert.deepEqual(((await (await app(new Request("http://localhost/providers"))).json()) as { providers: Array<{ id: string }> }).providers.map(({ id }) => id), ["itabus"]);
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

test("exposes every rail capability through HTTP before MCP", async () => {
  const date = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
  const rail: RailScheduleProvider = {
    id: "italo",
    searchLocations: async () => [{ provider: "italo", id: "RMT", name: "Roma Termini", city: "Roma", source: "historical_snapshot", observedAt: "2026-10-25T08:00:00Z" }],
    searchJourneys: async () => [{ provider: "italo", journeyId: "italo-9920", origin: { id: "RMT", name: "Roma Termini" }, destination: { id: "MC-", name: "Milano Centrale" }, departure: `${date}T08:00:00+01:00`, arrival: `${date}T11:10:00+01:00`, durationMinutes: 190, changes: 0, legs: [], available: null, price: null, timetableSource: { source: "Italian NAP NeTEx", publishedAt: "2026-10-25T08:00:00Z", validFrom: date, validThrough: date } }],
  };
  const live: RailLiveProvider = {
    id: "italo",
    getTrainStatus: async () => ({ observedAt: "2026-10-25T10:00:00Z", source: "Italo In Viaggio", freshness: "date_unverified", delayMinutes: 12 }),
    getStationBoard: async ({ direction }) => ({ provider: "italo", station: { id: "RMT", name: "Roma Termini" }, direction, observedAt: "2026-10-25T10:00:00Z", source: "Italo In Viaggio (date unverified)", services: [{ trainNumber: "9920", scheduledTime: "10:00", delayMinutes: 12 }] }),
  };
  const app = createApp([], [rail], [live]);
  assert.equal((await app(new Request("http://localhost/train-locations?query=Roma&provider=italo"))).status, 200);
  const journeys = await app(new Request(`http://localhost/train-journeys?origin=RMT&destination=MC-&date=${date}&provider=italo`));
  assert.equal(journeys.status, 200);
  assert.equal(((await journeys.json()) as { journeys: unknown[] }).journeys.length, 1);
  assert.equal((await app(new Request(`http://localhost/train-status?provider=italo&trainNumber=9920&serviceDate=${date}&origin=RMT`))).status, 200);
  const board = await app(new Request("http://localhost/station-board?provider=italo&stationId=RMT&stationName=Roma%20Termini&direction=departures"));
  assert.equal(board.status, 200);
  assert.equal(((await board.json()) as { services: unknown[] }).services.length, 1);
});

test("enriches rail HTTP results with an exact quote without changing bus routes", async () => {
  const date = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
  const rail: RailScheduleProvider = { id: "italo", searchLocations: async () => [], searchJourneys: async () => [{ provider: "italo", journeyId: "italo-9904", origin: { id: "RMT", name: "Roma Termini" }, destination: { id: "MC_", name: "Milano Centrale" }, departure: `${date}T05:40:00+01:00`, arrival: `${date}T09:20:00+01:00`, durationMinutes: 220, changes: 0, legs: [{ trainNumber: "9904", origin: { id: "RMT", name: "Roma Termini" }, destination: { id: "MC_", name: "Milano Centrale" }, departure: `${date}T05:40:00+01:00`, arrival: `${date}T09:20:00+01:00` }], available: null, price: null, bookingUrl: "https://biglietti.italotreno.com/it/booking/ricerca", timetableSource: { source: "fixture", publishedAt: `${date}T00:00:00Z`, validFrom: date, validThrough: date } }] };
  const quote: RailQuoteProvider = { id: "italo", searchQuotes: async () => [{ trainNumbers: ["9904"], departure: `${date}T05:40:00+01:00`, arrival: `${date}T09:20:00+01:00`, available: true, price: { amount: 34.9, currency: "EUR", observedAt: `${date}T00:00:00Z`, source: "fixture quote" }, observedAt: `${date}T00:00:00Z`, source: "fixture quote" }] };
  const app = createApp([provider], [rail], [], [quote]);
  const train = await app(new Request(`http://localhost/train-journeys?origin=Roma%20Termini&destination=Milano%20Centrale&date=${date}&provider=italo`));
  assert.equal(((await train.json()) as { journeys: Array<{ price: { amount: number }; bookingUrl: string }> }).journeys[0]?.price.amount, 34.9);
  const bus = await app(new Request("http://localhost/locations?query=Roma&provider=itabus"));
  assert.equal(bus.status, 200);
  assert.equal(((await bus.json()) as { locations: Array<{ id: string }> }).locations[0]?.id, "ROM1");
});

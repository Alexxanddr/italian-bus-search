import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { AppError, type Journey } from "../src/domain.ts";
import { createBusMcpServer } from "../src/mcp/server.ts";
import type { Provider } from "../src/providers/provider.ts";
import type { RailLiveProvider, RailQuoteProvider, RailScheduleProvider } from "../src/rail/provider.ts";

const futureDate = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
const journey: Journey = {
  provider: "working",
  tripId: "trip-1",
  origin: { id: "ROM", name: "Roma" },
  destination: { id: "MIL", name: "Milano" },
  departure: `${futureDate}T08:00:00+01:00`,
  arrival: `${futureDate}T14:00:00+01:00`,
  durationMinutes: 360,
  available: true,
  price: { amount: 20, currency: "EUR" },
  bookingUrl: `https://booking.example/from/Roma/${futureDate}/to/Milano`,
};

function workingProvider(calls: { locations: number; journeys: number }): Provider {
  return {
    id: "working",
    status: "available",
    statusReason: "fixture",
    searchLocations: async () => {
      calls.locations += 1;
      return [
        { provider: "working", id: "ROM", name: "Roma", city: "Roma", source: "live", synonyms: ["Rome"] },
        { provider: "working", id: "ROM2", name: "Roma East", city: "Roma", source: "live" },
        { provider: "working", id: "ROM3", name: "Roma West", city: "Roma", source: "live" },
      ];
    },
    searchJourneys: async () => {
      calls.journeys += 1;
      return [journey];
    },
  };
}

async function connect(providers: readonly Provider[], railProviders: readonly RailScheduleProvider[] = [], railLiveProviders: readonly RailLiveProvider[] = [], railQuoteProviders: readonly RailQuoteProvider[] = []) {
  const server = createBusMcpServer({ providers, railProviders, railLiveProviders, railQuoteProviders });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("discovers all read-only MCP tools and lists bus providers without network calls", async (context) => {
  const calls = { locations: 0, journeys: 0 };
  const { client, server } = await connect([workingProvider(calls)]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name), ["list_providers", "list_train_providers", "search_locations", "search_journeys", "search_train_locations", "search_train_journeys", "get_train_status", "get_station_board"]);
  assert.ok(tools.tools.every(({ annotations }) => annotations?.readOnlyHint === true && annotations.destructiveHint === false));

  const result = await client.callTool({ name: "list_providers", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    providers: [{ id: "working", status: "available", statusReason: "fixture" }],
  });
  assert.deepEqual(calls, { locations: 0, journeys: 0 });

  const trains = await client.callTool({ name: "list_train_providers", arguments: {} });
  assert.deepEqual(trains.structuredContent, { providers: [] });
});

test("returns scheduled rail results and explicit disabled live capability errors", async (context) => {
  const endpoint = (id: string, name: string) => ({ id, name });
  const railProvider: RailScheduleProvider = {
    id: "italo",
    searchLocations: async () => [{ provider: "italo", id: "NTV-ROM", name: "Roma Termini", city: "Roma Termini", source: "historical_snapshot", observedAt: "2026-10-25T09:00:00Z" }],
    searchJourneys: async (input) => [{ provider: "italo", journeyId: "italo:9920", origin: endpoint("NTV-ROM", "Roma Termini"), destination: endpoint("NTV-MIL", "Milano Centrale"), departure: `${input.date}T08:00:00+01:00`, arrival: `${input.date}T11:10:00+01:00`, durationMinutes: 190, changes: 0, legs: [{ trainNumber: "9920", origin: endpoint("NTV-ROM", "Roma Termini"), destination: endpoint("NTV-MIL", "Milano Centrale"), departure: `${input.date}T08:00:00+01:00`, arrival: `${input.date}T11:10:00+01:00` }], available: null, price: null, bookingUrl: "https://www.italotreno.com/", timetableSource: { source: "Italian NAP NeTEx", publishedAt: "2026-10-25T09:00:00Z", validFrom: "2026-10-01", validThrough: "2030-12-31" } }],
  };
  const { client, server } = await connect([], [railProvider]);
  context.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "search_train_journeys", arguments: { origin: "Roma Termini", destination: "Milano Centrale", date: futureDate } });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { journeys: unknown[] }).journeys.length, 1);
  const status = await client.callTool({ name: "get_train_status", arguments: { provider: "italo", trainNumber: "9920", serviceDate: futureDate, origin: "NTV-ROM" } });
  assert.equal(status.isError, true);
  assert.match(status.content[0]?.type === "text" ? status.content[0].text : "", /disabled pending verified protocol and authorization/);
});

test("returns verified live rail capabilities through MCP structured output", async (context) => {
  const live: RailLiveProvider = { id: "italo", getTrainStatus: async () => ({ observedAt: "2026-10-25T10:00:00Z", source: "Italo In Viaggio", freshness: "date_unverified", delayMinutes: 4 }), getStationBoard: async ({ direction }) => ({ provider: "italo", station: { id: "RMT", name: "Roma Termini" }, direction, observedAt: "2026-10-25T10:00:00Z", source: "Italo In Viaggio (date unverified)", services: [{ trainNumber: "9920", scheduledTime: "10:00", delayMinutes: 4 }] }) };
  const { client, server } = await connect([], [], [live]);
  context.after(async () => { await client.close(); await server.close(); });
  const status = await client.callTool({ name: "get_train_status", arguments: { provider: "italo", trainNumber: "9920", serviceDate: futureDate, origin: "RMT" } });
  assert.equal((status.structuredContent as { freshness: string }).freshness, "date_unverified");
  const board = await client.callTool({ name: "get_station_board", arguments: { provider: "italo", stationId: "RMT", stationName: "Roma Termini", direction: "departures" } });
  assert.equal((board.structuredContent as { services: unknown[] }).services.length, 1);
});

test("returns rail prices and official search links through MCP structured output", async (context) => {
  const endpoint = (id: string, name: string) => ({ id, name });
  const schedule: RailScheduleProvider = { id: "italo", searchLocations: async () => [], searchJourneys: async () => [{ provider: "italo", journeyId: "italo:9904", origin: endpoint("RMT", "Roma Termini"), destination: endpoint("MC_", "Milano Centrale"), departure: `${futureDate}T05:40:00+01:00`, arrival: `${futureDate}T09:20:00+01:00`, durationMinutes: 220, changes: 0, legs: [{ trainNumber: "9904", origin: endpoint("RMT", "Roma Termini"), destination: endpoint("MC_", "Milano Centrale"), departure: `${futureDate}T05:40:00+01:00`, arrival: `${futureDate}T09:20:00+01:00` }], available: null, price: null, bookingUrl: "https://biglietti.italotreno.com/it/booking/ricerca", timetableSource: { source: "fixture", publishedAt: `${futureDate}T00:00:00Z`, validFrom: futureDate, validThrough: futureDate } }] };
  const quote: RailQuoteProvider = { id: "italo", searchQuotes: async () => [{ trainNumbers: ["9904"], departure: `${futureDate}T05:40:00+01:00`, arrival: `${futureDate}T09:20:00+01:00`, available: true, price: { amount: 34.9, currency: "EUR", observedAt: `${futureDate}T00:00:00Z`, source: "fixture quote" } }] };
  const { client, server } = await connect([], [schedule], [], [quote]);
  context.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "search_train_journeys", arguments: { origin: "Roma Termini", destination: "Milano Centrale", date: futureDate, provider: "italo" } });
  const first = (result.structuredContent as { journeys: Array<{ price: { amount: number }; bookingUrl: string }> }).journeys[0];
  assert.equal(first?.price.amount, 34.9);
  assert.equal(first?.bookingUrl, "https://biglietti.italotreno.com/it/booking/ricerca");
});

test("keeps partial location results and reports truncation", async (context) => {
  const calls = { locations: 0, journeys: 0 };
  const failing: Provider = {
    id: "failing",
    status: "unavailable",
    searchLocations: async () => {
      throw new AppError("PROVIDER_UNAVAILABLE", "temporarily unavailable", 503);
    },
    searchJourneys: async () => [],
  };
  const { client, server } = await connect([workingProvider(calls), failing]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({ name: "search_locations", arguments: { query: "Roma", limit: 2 } });
  assert.equal(result.isError, undefined);
  const output = result.structuredContent as { locations: unknown[]; errors: unknown[]; total: number; truncated: boolean };
  assert.equal(output.locations.length, 2);
  assert.equal("synonyms" in (output.locations[0] as object), false);
  assert.equal(output.errors.length, 1);
  assert.equal(output.total, 3);
  assert.equal(output.truncated, true);
});

test("supports the location-to-journey flow with structured output and a manual booking link", async (context) => {
  const calls = { locations: 0, journeys: 0 };
  const { client, server } = await connect([workingProvider(calls)]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const locations = await client.callTool({ name: "search_locations", arguments: { query: "Roma" } });
  const origin = (locations.structuredContent as { locations: Array<{ id: string }> }).locations[0]?.id;
  const result = await client.callTool({
    name: "search_journeys",
    arguments: { origin, destination: "MIL", date: futureDate, adults: 1, children: 0 },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { journeys: [journey], errors: [], total: 1, truncated: false });
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Continue on working.*https:\/\/booking\.example/);
  assert.deepEqual(calls, { locations: 1, journeys: 1 });
});

test("returns tool errors for invalid journeys and unknown providers", async (context) => {
  const calls = { locations: 0, journeys: 0 };
  const { client, server } = await connect([workingProvider(calls)]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const invalidDate = await client.callTool({
    name: "search_journeys",
    arguments: { origin: "ROM", destination: "MIL", date: "bad" },
  });
  assert.equal(invalidDate.isError, true);

  const nonexistentDate = await client.callTool({
    name: "search_journeys",
    arguments: { origin: "ROM", destination: "MIL", date: "2027-02-30" },
  });
  assert.equal(nonexistentDate.isError, true);

  const pastDate = await client.callTool({
    name: "search_journeys",
    arguments: { origin: "ROM", destination: "MIL", date: "2000-01-01" },
  });
  assert.equal(pastDate.isError, true);

  const invalidPassengers = await client.callTool({
    name: "search_journeys",
    arguments: { origin: "ROM", destination: "MIL", date: futureDate, adults: 10 },
  });
  assert.equal(invalidPassengers.isError, true);

  const invalidChildren = await client.callTool({
    name: "search_journeys",
    arguments: { origin: "ROM", destination: "MIL", date: futureDate, children: -1 },
  });
  assert.equal(invalidChildren.isError, true);

  const unknownProvider = await client.callTool({
    name: "search_locations",
    arguments: { query: "Roma", provider: "missing" },
  });
  assert.equal(unknownProvider.isError, true);
  assert.match(unknownProvider.content[0]?.type === "text" ? unknownProvider.content[0].text : "", /Unknown provider/);
});

test("serves tool discovery over stdio without corrupting the protocol", async (context) => {
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", "src/mcp/stdio.ts"],
    cwd: repository,
    stderr: "pipe",
  });
  context.after(async () => client.close());

  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), [
    "list_providers",
    "list_train_providers",
    "search_locations",
    "search_journeys",
    "search_train_locations",
    "search_train_journeys",
    "get_train_status",
    "get_station_board",
  ]);
});

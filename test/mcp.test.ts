import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { AppError, type Journey } from "../src/domain.ts";
import { createApp, createMcpApp } from "../src/app.ts";
import { SearchSnapshots } from "../src/snapshots.ts";
import { createBusMcpServer } from "../src/mcp/server.ts";
import type { Provider } from "../src/providers/provider.ts";
import { LiveRailProvider } from "../src/rail/booking.ts";
import type { RailLiveProvider, RailQuoteProvider, RailProvider } from "../src/rail/provider.ts";

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

async function connect(providers: readonly Provider[], railProviders: readonly RailProvider[] = [], railLiveProviders: readonly RailLiveProvider[] = []) {
  const server = createBusMcpServer({ providers, railProviders, railLiveProviders });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("serves MCP over stateless streamable HTTP alongside the REST API", async (context) => {
  const app = createMcpApp();
  const client = new Client({ name: "http-test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (input, init) => app.fetch(new Request(input, init)),
  }));
  context.after(async () => {
    await client.close();
    await app.close();
  });

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  assert.equal(client.getServerVersion()?.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

test("enforces one search budget across stateless HTTP exchanges", async (context) => {
  const calls = { locations: 0, journeys: 0 };
  const app = createMcpApp({ providers: [workingProvider(calls)], railProviders: [] });
  const client = new Client({ name: "shared-budget", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (input, init) => app.fetch(new Request(input, init)),
  }));
  context.after(async () => { await client.close(); await app.close(); });
  for (let index = 0; index < 60; index += 1) {
    assert.notEqual((await client.callTool({ name: "search_locations", arguments: { query: "Roma" } })).isError, true);
  }
  const limited = await client.callTool({ name: "search_locations", arguments: { query: "Roma" } });
  assert.equal(limited.isError, true);
  assert.equal(calls.locations, 60);
});

test("paginates bus journeys without dropping results beyond fifty", async (context) => {
  const provider = workingProvider({ locations: 0, journeys: 0 });
  provider.searchJourneys = async () => Array.from({ length: 55 }, (_, index) => ({ ...journey, tripId: String(index) }));
  const { client, server } = await connect([provider]);
  context.after(async () => { await client.close(); await server.close(); });
  const args = { origin: "Roma", destination: "Milano", date: futureDate, limit: 50 };
  const first = (await client.callTool({ name: "search_journeys", arguments: args })).structuredContent as { journeys: Array<{ tripId: string }>; truncated: boolean; total: number };
  const last = (await client.callTool({ name: "search_journeys", arguments: { ...args, offset: 50 } })).structuredContent as typeof first;
  assert.equal(first.total, 55);
  assert.equal(first.truncated, true);
  assert.equal(last.truncated, false);
  assert.equal(new Set([...first.journeys, ...last.journeys].map(({ tripId }) => tripId)).size, 55);
});

test("rejects oversized MCP bodies before creating expensive provider work", async () => {
  const app = createMcpApp({ providers: [], railProviders: [] });
  try {
    const response = await app.fetch(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: " ".repeat(65_537),
    }));
    assert.equal(response.status, 413);
  } finally { await app.close(); }
});

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
  assert.match(tools.tools.find(({ name }) => name === "search_journeys")?.description ?? "", /BUS ONLY.*Never use for trains/);
  const trainSearch = tools.tools.find(({ name }) => name === "search_train_journeys");
  assert.match(trainSearch?.description ?? "", /TRAINS ONLY.*always pass adults and children explicitly/);
  assert.match(JSON.stringify(trainSearch?.inputSchema), /Number of child passengers/);

  const result = await client.callTool({ name: "list_providers", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    providers: [{ id: "working", status: "available", statusReason: "fixture" }],
  });
  assert.deepEqual(calls, { locations: 0, journeys: 0 });

  const trains = await client.callTool({ name: "list_train_providers", arguments: {} });
  assert.deepEqual(trains.structuredContent, { providers: [] });
});

test("returns live rail results and explicit disabled live capability errors", async (context) => {
  const endpoint = (id: string, name: string) => ({ id, name });
  const railProvider: RailProvider = {
    id: "italo",
    searchLocations: async () => [{ provider: "italo", id: "NTV-ROM", name: "Roma Termini", city: "Roma Termini", source: "live", observedAt: "2026-10-25T09:00:00Z" }],
    searchJourneys: async (input) => [{ provider: "italo", journeyId: "italo:9920", origin: endpoint("NTV-ROM", "Roma Termini"), destination: endpoint("NTV-MIL", "Milano Centrale"), departure: `${input.date}T08:00:00+01:00`, arrival: `${input.date}T11:10:00+01:00`, durationMinutes: 190, changes: 0, legs: [{ trainNumber: "9920", origin: endpoint("NTV-ROM", "Roma Termini"), destination: endpoint("NTV-MIL", "Milano Centrale"), departure: `${input.date}T08:00:00+01:00`, arrival: `${input.date}T11:10:00+01:00` }], available: null, price: null, bookingUrl: "https://www.italotreno.com/", timetableSource: { source: "synthetic booking search", publishedAt: "2026-10-25T09:00:00Z", validFrom: "2026-10-01", validThrough: "2030-12-31" } }],
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
  const schedule: RailProvider = { id: "italo", searchLocations: async () => [], searchJourneys: async () => [{ provider: "italo", journeyId: "italo:9904", origin: endpoint("RMT", "Roma Termini"), destination: endpoint("MC_", "Milano Centrale"), departure: `${futureDate}T05:40:00+01:00`, arrival: `${futureDate}T09:20:00+01:00`, durationMinutes: 220, changes: 0, legs: [{ trainNumber: "9904", origin: endpoint("RMT", "Roma Termini"), destination: endpoint("MC_", "Milano Centrale"), departure: `${futureDate}T05:40:00+01:00`, arrival: `${futureDate}T09:20:00+01:00` }], available: null, price: null, bookingUrl: "https://biglietti.italotreno.com/it/booking/ricerca", timetableSource: { source: "fixture", publishedAt: `${futureDate}T00:00:00Z`, validFrom: futureDate, validThrough: futureDate } }] };
  const quote: RailQuoteProvider = { id: "italo", searchLocations: async () => [], searchQuotes: async () => [{ trainNumbers: ["9904"], departure: `${futureDate}T05:40:00+01:00`, arrival: `${futureDate}T09:20:00+01:00`, available: true, price: { amount: 34.9, currency: "EUR", observedAt: `${futureDate}T00:00:00Z`, source: "fixture quote" }, observedAt: `${futureDate}T00:00:00Z`, source: "fixture quote", legs: (await schedule.searchJourneys({ origin: "Roma Termini", destination: "Milano Centrale", date: futureDate, adults: 1, children: 0 }))[0]!.legs }] };
  const { client, server } = await connect([], [new LiveRailProvider(quote)], []);
  context.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "search_train_journeys", arguments: { origin: "Roma Termini", destination: "Milano Centrale", date: futureDate, provider: "italo" } });
  const first = (result.structuredContent as { journeys: Array<{ price: { amount: number }; bookingUrl: string }> }).journeys[0];
  assert.equal(first?.price.amount, 34.9);
  assert.equal(first?.bookingUrl, "https://biglietti.italotreno.com/it/booking/ricerca");
  const nextPage = await client.callTool({ name: "search_train_journeys", arguments: { origin: "Roma Termini", destination: "Milano Centrale", date: futureDate, provider: "italo", offset: 1, limit: 1 } });
  assert.deepEqual((nextPage.structuredContent as { journeys: unknown[]; total: number; truncated: boolean }), { journeys: [], errors: [], total: 1, truncated: false });
});

test("returns explicit live rail failures without scheduled fallback through MCP", async (context) => {
  const quote: RailQuoteProvider = { id: "italo", searchLocations: async () => [], searchQuotes: async () => { throw new AppError("QUOTE_UNAVAILABLE", "Italo unavailable", 503); } };
  const { client, server } = await connect([], [new LiveRailProvider(quote)]);
  context.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "search_train_journeys", arguments: { origin: "Roma Termini", destination: "Paola", date: futureDate } });
  assert.deepEqual(result.structuredContent, { journeys: [], errors: [{ provider: "italo", code: "QUOTE_UNAVAILABLE", message: "Italo unavailable" }], total: 0, truncated: false });
});

test("shares immutable train snapshots across stateless MCP exchanges and HTTP", async (context) => {
  let calls = 0;
  const rail: RailProvider = { id: "italo", searchLocations: async () => [], searchJourneys: async () => {
    calls++;
    return [1, 2].map((id) => ({ ...journey, provider: "italo" as const, journeyId: String(id), changes: 0, legs: [], price: { amount: calls * 10 + id, currency: "EUR", observedAt: "2026-10-27T10:00:00Z", source: "fixture" }, timetableSource: { source: "fixture booking", publishedAt: "2026-10-27T10:00:00Z", validFrom: futureDate, validThrough: futureDate } }));
  } };
  const snapshots = new SearchSnapshots();
  const app = createMcpApp({ providers: [], railProviders: [rail], snapshots });
  const client = new Client({ name: "snapshot-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch: (input, init) => app.fetch(new Request(input, init)) }));
  context.after(async () => { await client.close(); await app.close(); });
  const first = await client.callTool({ name: "search_train_journeys", arguments: { origin: "Roma", destination: "Milano", date: futureDate, snapshot: true, limit: 1 } });
  const saved = first.structuredContent as { searchId: string; total: number };
  assert.equal(saved.total, 2); assert.ok(saved.searchId);
  const next = await client.callTool({ name: "search_train_journeys", arguments: { searchId: saved.searchId, offset: 1, limit: 1 } });
  assert.equal((next.structuredContent as { journeys: Array<{ price: { amount: number } }> }).journeys[0]?.price.amount, 12);
  assert.equal(calls, 1);
  const http = createApp([], [rail], [], snapshots);
  const response = await http(new Request(`http://localhost/train-journeys?searchId=${saved.searchId}&offset=1&limit=1`));
  assert.deepEqual(await response.json(), next.structuredContent);
  const conflict = await client.callTool({ name: "search_train_journeys", arguments: { searchId: saved.searchId, adults: 2 } });
  assert.equal(conflict.isError, true);
  const missing = await client.callTool({ name: "search_train_journeys", arguments: { searchId: "00000000-0000-0000-0000-000000000000" } });
  assert.equal(missing.isError, true);
});

test("preserves stop addresses and excluded urban transfer warnings in MCP output and text", async (context) => {
  const bus: Provider = { id: "working", status: "available", searchLocations: async () => [], searchJourneys: async () => [{ ...journey, destination: { ...journey.destination, name: "Rende Cosenza Nord", city: "Cosenza", address: "via Synthetic" } }] };
  const rail: RailProvider = { id: "trenitalia", searchLocations: async () => [], searchJourneys: async () => [{
    ...journey, provider: "trenitalia", journeyId: "urban", changes: 0,
    price: { amount: 20, currency: "EUR", source: "fixture quote", observedAt: "2026-10-27T10:00:00Z" },
    warnings: ["Transfer not included in quoted price: Roma Termini → Roma Ostiense"],
    legs: [{ trainNumber: "UB", transportMode: "urban_transfer", includedInPrice: false, description: "Urban transport", origin: journey.origin, destination: journey.destination, departure: journey.departure, arrival: journey.arrival }],
    timetableSource: { source: "fixture booking", publishedAt: "2026-10-27T10:00:00Z", validFrom: futureDate, validThrough: futureDate },
  }] };
  const { client, server } = await connect([bus], [rail]);
  context.after(async () => { await client.close(); await server.close(); });
  const args = { origin: "Roma", destination: "Cosenza", date: futureDate };
  const buses = await client.callTool({ name: "search_journeys", arguments: args });
  assert.equal((buses.structuredContent as { journeys: Array<{ destination: { address: string } }> }).journeys[0]?.destination.address, "via Synthetic");
  assert.match(JSON.stringify(buses.content), /via Synthetic/);
  const trains = await client.callTool({ name: "search_train_journeys", arguments: args });
  const first = (trains.structuredContent as { journeys: Array<{ warnings: string[]; legs: Array<{ includedInPrice: boolean }> }> }).journeys[0]!;
  assert.equal(first.legs[0]?.includedInPrice, false); assert.equal(first.warnings.length, 1);
  assert.match(JSON.stringify(trains.content), /Transfer not included/);
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

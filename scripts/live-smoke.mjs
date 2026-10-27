import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3099/mcp");
const date = process.env.SMOKE_DATE ?? new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
let token = process.env.MCPHUB_API_KEY;
if (process.argv.includes("--token-stdin")) {
  const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  token = (await reader.question("Token (input hidden by the caller):\n")).trim();
  reader.close();
}
const client = new Client({ name: "italian-travel-live-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));

function data(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text ?? "{}";
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function summary(value) {
  const journeys = value.journeys;
  return journeys ? {
    count: journeys.length, priced: journeys.filter(({ price }) => price !== null).length,
    total: value.total, truncated: value.truncated, errors: value.errors,
    samples: journeys.slice(0, 2).map(({ provider, departure, arrival, price, available }) => ({ provider, departure, arrival, price, available })),
  } : value.services ? { services: value.services.length, station: value.station, source: value.source }
    : value.locations ? { locations: value.locations.length, total: value.total, truncated: value.truncated, errors: value.errors }
      : value;
}

try {
  const all = (await client.listTools()).tools;
  const tools = all.filter(({ name }) => name.includes("italian-travel-search"));
  const names = tools.length ? tools : all;
  assert.equal(names.length, 8);
  console.log(JSON.stringify({ test: "discovery", server: client.getServerVersion(), tools: names.map(({ name }) => name) }));
  async function call(suffix, args) {
    const name = names.find((tool) => tool.name === suffix || tool.name.endsWith(`-${suffix}`))?.name;
    assert.ok(name, `Missing tool ${suffix}`);
    const result = await client.callTool({ name, arguments: args });
    const value = data(result);
    console.log(JSON.stringify({ test: suffix, provider: args.provider, isError: result.isError === true, ...summary(value) }));
    return { result, value };
  }
  await call("list_providers", {});
  await call("list_train_providers", {});
  await call("search_locations", { query: "Roma", limit: 50 });
  await call("search_locations", { query: "Cosenza", limit: 50 });
  const args = { origin: "Roma", destination: "Cosenza", date, adults: 1, children: 0, limit: 50 };
  const buses = await call("search_journeys", args);
  assert.ok(buses.value.journeys?.length > 0, "No bus results");
  const stations = await call("search_train_locations", { query: "Roma Termini", limit: 50 });
  await call("search_train_locations", { query: "Cosenza", limit: 50 });
  const trains = await call("search_train_journeys", { ...args, origin: "Roma Termini", offset: 0, limit: 10 });
  const accumulated = [...(trains.value.journeys ?? [])];
  for (let offset = 10; offset < (trains.value.total ?? 0); offset += 10) {
    accumulated.push(...(await call("search_train_journeys", { ...args, origin: "Roma Termini", offset, limit: 10 })).value.journeys);
  }
  assert.equal(accumulated.length, trains.value.total);
  assert.equal(new Set(accumulated.map(({ journeyId }) => journeyId)).size, accumulated.length);
  for (const journey of accumulated) {
    assert.ok(journey.bookingUrl);
    assert.ok(journey.legs.length > 0);
    if (journey.price !== null) assert.ok(journey.price.source && journey.price.observedAt && journey.price.amount >= 0);
  }
  console.log(JSON.stringify({ test: "train-pagination", count: accumulated.length, priced: accumulated.filter(({ price }) => price !== null).length }));
  await call("search_train_journeys", { ...args, origin: "Roma Termini", destination: "Milano Centrale", provider: "italo", offset: 0 });
  for (const station of stations.value.locations ?? []) {
    for (const direction of ["departures", "arrivals"]) {
      const board = await call("get_station_board", { provider: station.provider, stationId: station.id, stationName: station.name, direction });
      if (process.env.HTTP_BASE_URL) {
        const params = new URLSearchParams({ provider: station.provider, stationId: station.id, stationName: station.name, direction });
        const response = await fetch(new URL(`/station-board?${params}`, process.env.HTTP_BASE_URL));
        console.log(JSON.stringify({ test: "http-board", provider: station.provider, direction, status: response.status, ...summary(await response.json()) }));
      }
      if (direction !== "departures") continue;
      const trainNumber = board.value.services?.[0]?.trainNumber ?? (station.provider === "italo" ? "9920" : "9516");
      await call("get_train_status", { provider: station.provider, trainNumber, serviceDate: today, origin: station.name });
      if (process.env.HTTP_BASE_URL) {
        const params = new URLSearchParams({ provider: station.provider, trainNumber, serviceDate: today, origin: station.name });
        const response = await fetch(new URL(`/train-status?${params}`, process.env.HTTP_BASE_URL));
        console.log(JSON.stringify({ test: "http-status", provider: station.provider, status: response.status, ...summary(await response.json()) }));
      }
    }
  }
  if (process.env.HTTP_BASE_URL) {
    const base = new URL(process.env.HTTP_BASE_URL);
    for (const path of ["health", "providers", "train-providers", "locations?query=Roma", "train-locations?query=Roma", `journeys?${new URLSearchParams(args)}`, `train-journeys?${new URLSearchParams({ ...args, origin: "Roma Termini" })}`]) {
      const response = await fetch(new URL(`/${path}`, base));
      const value = await response.json();
      console.log(JSON.stringify({ test: "http", route: path.split("?")[0], ...summary(value), httpStatus: response.status }));
      assert.equal(response.status, 200);
    }
  }
} finally {
  await client.close();
}

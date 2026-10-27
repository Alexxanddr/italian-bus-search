import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { LiveRailProvider } from "../src/rail/booking.ts";
import { createDefaultRailProviders } from "../src/rail/default.ts";
import type { RailOperator, RailQuote, RailQuoteProvider } from "../src/rail/provider.ts";
import { RailSearchService } from "../src/rail/search.ts";
import { offsetRomeDateTime } from "../src/rail/time.ts";

const input = { origin: "Roma Termini", destination: "Paola", date: "2027-01-15", adults: 1, children: 0 };
const observedAt = "2026-10-27T10:00:00Z";
function quote(departure = "2027-01-15T08:00:00+01:00", arrival = "2027-01-15T11:10:00+01:00"): RailQuote {
  return { trainNumbers: ["1000"], departure, arrival, available: true,
    price: { amount: 44.9, currency: "EUR", source: "synthetic quote", observedAt }, source: "synthetic booking search", observedAt,
    legs: [{ trainNumber: "1000", origin: { id: "ROM", name: "Roma Termini" }, destination: { id: "PAO", name: "Paola" }, departure, arrival }] };
}
function source(id: RailOperator, quotes: RailQuote[] = [quote()]): RailQuoteProvider {
  return { id, searchQuotes: async () => quotes, searchLocations: async () => [{ provider: id, id: "ROM", name: "Roma Termini", city: "Roma", source: "live", observedAt }] };
}

test("uses live catalogs and booking solutions with prices, provenance and overnight timing", async () => {
  const service = new RailSearchService([new LiveRailProvider(source("trenitalia", [quote("2027-01-15T23:30:00+01:00", "2027-01-16T02:45:00+01:00")])), new LiveRailProvider(source("italo"))]);
  const result = await service.searchJourneys(input);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.journeys.map(({ provider }) => provider), ["italo", "trenitalia"]);
  assert.equal(result.journeys[1]?.durationMinutes, 195);
  assert.equal(result.journeys[0]?.price?.amount, 44.9);
  assert.equal(result.journeys[0]?.timetableSource.source, "synthetic booking search");
  assert.ok(result.journeys.every(({ bookingUrl }) => bookingUrl?.startsWith("https://")));
  const locations = await service.searchLocations("Roma");
  assert.equal(locations.locations.length, 2);
  assert.ok(locations.locations.every(({ source }) => source === "live"));
});

test("preserves all live connection legs and nullable unavailable fares", async () => {
  const connection = quote();
  connection.price = null; connection.available = false;
  connection.legs!.push({ trainNumber: "R 2", origin: { id: "PAO", name: "Paola" }, destination: { id: "COS", name: "Cosenza" }, departure: "2027-01-15T11:30:00+01:00", arrival: "2027-01-15T12:00:00+01:00" });
  connection.arrival = "2027-01-15T12:00:00+01:00"; connection.trainNumbers.push("R 2");
  const journey = (await new LiveRailProvider(source("trenitalia", [connection])).searchJourneys(input))[0]!;
  assert.equal(journey.changes, 1); assert.equal(journey.legs.length, 2);
  assert.equal(journey.destination.name, "Cosenza"); assert.equal(journey.durationMinutes, 240);
  assert.equal(journey.price, null); assert.equal(journey.available, false);
});

test("does not fabricate schedules on upstream failure and keeps other provider data", async () => {
  const failing = source("trenitalia");
  failing.searchQuotes = async () => { throw new AppError("QUOTE_UNAVAILABLE", "down", 503); };
  failing.searchLocations = async () => { throw new AppError("RATE_LIMITED", "limited", 429); };
  const service = new RailSearchService([new LiveRailProvider(failing), new LiveRailProvider(source("italo"))]);
  const journeys = await service.searchJourneys(input);
  assert.deepEqual(journeys.journeys.map(({ provider }) => provider), ["italo"]);
  assert.equal(journeys.errors[0]?.code, "QUOTE_UNAVAILABLE");
  const locations = await service.searchLocations("Roma");
  assert.equal(locations.locations.length, 1); assert.equal(locations.errors[0]?.code, "RATE_LIMITED");
  assert.deepEqual((await service.searchJourneys(input, "trenitalia")).journeys, []);
});

test("successful empty searches stay empty and unknown failures never leak detail", async () => {
  const provider = source("italo", []);
  const service = new RailSearchService([new LiveRailProvider(provider)]);
  const empty = await service.searchJourneys(input);
  assert.deepEqual(empty.journeys, []); assert.equal(empty.errors[0]?.code, "NO_JOURNEYS");
  provider.searchQuotes = async () => { throw new Error("secret upstream payload"); };
  assert.deepEqual((await service.searchJourneys(input)).errors, [{ provider: "italo", code: "PROVIDER_UNAVAILABLE", message: "Rail provider request failed" }]);
});

test("rejects malformed live timing, money and missing legs", async () => {
  for (const invalid of [
    { ...quote(), departure: "bad" }, { ...quote(), arrival: "2027-01-15T07:00:00+01:00" },
    { ...quote(), price: { ...quote().price!, amount: -1 } },
    { ...quote(), legs: [] }, { ...quote(), legs: undefined },
  ]) await assert.rejects(new LiveRailProvider(source("italo", [invalid])).searchJourneys(input), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
});

test("selects configured operators and lists live search capabilities without network or files", async () => {
  const service = new RailSearchService([new LiveRailProvider(source("italo"))]);
  await assert.rejects(service.searchJourneys(input, "unknown"), (error: unknown) => error instanceof AppError && error.code === "INVALID_INPUT");
  await assert.rejects(service.searchJourneys(input, "trenitalia"), (error: unknown) => error instanceof AppError && error.code === "PROVIDER_UNAVAILABLE");
  assert.deepEqual(new RailSearchService(createDefaultRailProviders()).listProviders(["italo", "trenitalia"]), ["trenitalia", "italo"].map((id) => ({ id, capabilities: { schedule: true, price: true, liveStatus: true, stationBoard: true } })));
});

test("preserves Europe/Rome winter/summer offsets and rejects DST gaps and folds", () => {
  assert.equal(offsetRomeDateTime("2027-01-15T08:00:00"), "2027-01-15T08:00:00+01:00");
  assert.equal(offsetRomeDateTime("2027-07-15T08:00:00"), "2027-07-15T08:00:00+02:00");
  for (const local of ["2027-03-28T02:30:00", "2027-10-31T02:30:00"]) assert.throws(() => offsetRomeDateTime(local), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
});

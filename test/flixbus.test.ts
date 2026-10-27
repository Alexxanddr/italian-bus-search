import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/domain.ts";
import { FlixBusProvider, parseFlixBusJourneys } from "../src/providers/flixbus.ts";

const input = { origin: "Roma", destination: "Cosenza", date: "2026-11-10", adults: 1, children: 0 };
const origin = { id: "rome-id", name: "Roma", country: "IT", bookable: true };
const destination = { id: "cosenza-id", name: "Cosenza", country: "IT", bookable: true };

function payload() {
  return {
    platform_fee_in_price_required: true,
    stations: { rome: { name: "Roma Tiburtina" }, cosenza: { name: "Cosenza Autostazione" } },
    trips: [{ results: {
      ok: { uid: "trip-ok", status: "available", departure: { date: "2026-11-10T08:00:00+01:00", station_id: "rome" }, arrival: { date: "2026-11-10T15:00:00+01:00", station_id: "cosenza" }, duration: { hours: 7, minutes: 0 }, price: { total: 20, total_with_platform_fee: 22 } },
      missingFee: { uid: "trip-missing-fee", status: "available", departure: { date: "2026-11-10T09:00:00+01:00" }, arrival: { date: "2026-11-10T16:00:00+01:00" }, duration: { hours: 7, minutes: 0 }, price: { total: 18 } },
    } }],
  };
}

test("normalizes FlixBus journeys and keeps unknown fee totals nullable", () => {
  const journeys = parseFlixBusJourneys(payload(), input, origin, destination);
  assert.equal(journeys[0]?.price?.amount, 22);
  assert.equal(journeys[1]?.price, null);
  assert.equal(journeys[0]?.origin.name, "Roma Tiburtina");
  assert.match(journeys[0]?.bookingUrl ?? "", /shop\.flixbus\.com\/search/);
});

test("uses autocomplete and search endpoints with cache", async () => {
  const calls: string[] = [];
  const provider = new FlixBusProvider(async (request) => {
    const url = request.toString(); calls.push(url);
    if (url.includes("autocomplete")) return Response.json([{ id: "rome-id", name: "Roma", country: "IT", is_flixbus_city: true }, { id: "cosenza-id", name: "Cosenza", country: "IT", is_flixbus_city: true }]);
    return Response.json(payload());
  });
  assert.equal((await provider.searchJourneys(input)).length, 2);
  assert.equal((await provider.searchJourneys(input)).length, 2);
  assert.equal(calls.filter((url) => url.includes("autocomplete")).length, 2);
  assert.equal(calls.filter((url) => url.includes("service/v4/search")).length, 1);
});

test("does not reuse one city's autocomplete results for another query", async () => {
  const calls: string[] = [];
  const provider = new FlixBusProvider(async (request) => {
    const url = request.toString(); calls.push(url);
    if (url.includes("q=Roma")) return Response.json([{ id: "rome-id", name: "Roma", country: "IT", is_flixbus_city: true }]);
    if (url.includes("q=Cosenza")) return Response.json([{ id: "cosenza-id", name: "Cosenza", country: "IT", is_flixbus_city: true }]);
    return Response.json(payload());
  });
  await provider.searchLocations("Roma");
  assert.equal((await provider.searchJourneys(input)).length, 2);
  assert.equal(calls.filter((url) => url.includes("q=Cosenza")).length, 1);
});

test("rejects invalid timestamps", () => {
  const invalid = payload();
  invalid.trips[0].results.ok.departure.date = "not-a-date";
  assert.throws(() => parseFlixBusJourneys(invalid, input, origin, destination), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
});

test("reuses discovered city IDs without autocompleting opaque IDs", async () => {
  const provider = new FlixBusProvider(async (request) => {
    const url = String(request);
    if (url.includes("q=Roma")) return Response.json([{ id: origin.id, name: origin.name, is_flixbus_city: true }]);
    if (url.includes("q=Cosenza")) return Response.json([{ id: destination.id, name: destination.name, is_flixbus_city: true }]);
    if (url.includes("autocomplete")) throw new Error("Opaque ID must come from the location cache");
    return Response.json(payload());
  });
  await provider.searchLocations("Roma");
  await provider.searchLocations("Cosenza");
  assert.equal((await provider.searchJourneys({ ...input, origin: origin.id, destination: destination.id })).length, 2);
});

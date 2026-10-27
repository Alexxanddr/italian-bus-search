import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AppError } from "../src/domain.ts";
import { ItabusProvider, parseItabusJourneys } from "../src/providers/itabus.ts";

test("normalizes an Itabus route fixture", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("fixtures/itabus-travels.json", import.meta.url), "utf8"),
  ) as unknown;

  assert.deepEqual(parseItabusJourneys(fixture), [
    {
      provider: "itabus",
      tripId: "fixture-trip-1",
      origin: { id: "ROM1", name: "Roma (Tiburtina Terminal)" },
      destination: { id: "MIL1", name: "Milano Lampugnano" },
      departure: "2026-11-10T08:00:00+01:00",
      arrival: "2026-11-10T14:15:00+01:00",
      durationMinutes: 375,
      available: true,
      price: { amount: 19.99, currency: "EUR" },
      fare: "ECONOMY_COMFORT",
      bookingUrl: "https://app.itabus.it/",
    },
  ]);
});

test("rejects an incompatible Itabus response", () => {
  assert.throws(
    () => parseItabusJourneys({ data: {} }),
    (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE",
  );
});

test("keeps missing Itabus prices nullable and rejects invalid datetimes", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/itabus-travels.json", import.meta.url), "utf8"));
  fixture.data.outbound.routes[0].rates = { price: null };
  assert.equal(parseItabusJourneys(fixture)[0]?.price, null);
  fixture.data.outbound.routes[0].departure_timestamp = "not-a-date";
  assert.throws(() => parseItabusJourneys(fixture), /duration is invalid/);
});

test("searches live locations and journeys through an injected HTTP client", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("fixtures/itabus-travels.json", import.meta.url), "utf8"),
  ) as unknown;
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();
    calls.push(url);
    if (url.includes("Api-Stations")) {
      return Response.json({
        data: [
          { code: "ROM_T", name: "Roma" },
          { code: "ROM1", name: "Roma (Tiburtina Terminal Bus)", parent: "ROM_T" },
          { code: "MIL_T", name: "Milano" },
          { code: "MIL1", name: "Milano (Lampugnano M1)", parent: "MIL_T" },
          { code: "COS_T", name: "Cosenza" },
          { code: "COS1", name: "Cosenza (Terminal Bus)", parent: "COS_T" },
        ],
      });
    }
    return Response.json(fixture);
  };
  const provider = new ItabusProvider(fetcher);

  assert.equal((await provider.searchLocations("Roma"))[0]?.source, "live");
  const input = {
    origin: "Roma",
    destination: "Cosenza",
    date: "2026-11-10",
    adults: 1,
    children: 0,
  };
  assert.equal((await provider.searchJourneys(input))[0]?.price?.amount, 19.99);
  assert.equal((await provider.searchJourneys(input))[0]?.price?.amount, 19.99);
  assert.equal(calls.filter((url) => url.includes("Api-Stations")).length, 1);
  assert.equal(calls.filter((url) => url.includes("Api-Travels")).length, 1);
  assert.match(calls.at(-1) ?? "", /origin=ROM_T/);
  assert.match(calls.at(-1) ?? "", /destination=COS_T/);
});

test("preserves city scope, exact stop IDs and verified booking link parameters", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/itabus-travels.json", import.meta.url), "utf8"));
  const calls: URL[] = [];
  const provider = new ItabusProvider(async (input) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname.endsWith("Api-Stations")) return Response.json({ data: [
      { code: "COS1", name: "Cosenza", parent: "COS_T" },
      { code: "ROM_T", name: "Roma" }, { code: "ROM1", name: "Roma Tiburtina", parent: "ROM_T" },
      { code: "COS_T", name: "Cosenza" }, { code: "COS3", name: "Rende (Cosenza Nord)", parent: "COS_T" },
    ] });
    const routes = [fixture.data.outbound.routes[0], { ...fixture.data.outbound.routes[0], id: "rende", destination: { code: "COS3", name: "Rende (Cosenza Nord)" } }];
    return Response.json({ data: { outbound: { routes: url.searchParams.get("destination") === "COS_T" ? routes : [routes[1]] } } });
  });
  const input = { origin: "Roma", destination: "Cosenza", date: "2026-11-10", adults: 2, children: 1 };
  const city = await provider.searchJourneys(input);
  assert.equal(city.length, 2);
  const link = new URL(city[0]!.bookingUrl!);
  assert.equal(link.searchParams.get("origin"), "ROM_T"); assert.equal(link.searchParams.get("destination"), "COS_T");
  assert.equal(link.searchParams.get("datestart"), input.date); assert.equal(link.searchParams.has("date"), false);
  assert.equal(link.searchParams.get("adults"), "2"); assert.equal(link.searchParams.get("children"), "1");
  const stop = await provider.searchJourneys({ ...input, origin: "ROM1", destination: "COS3" });
  assert.equal(stop.length, 1); assert.equal(calls.at(-1)!.searchParams.get("destination"), "COS3");
  assert.equal(new URL(stop[0]!.bookingUrl!).searchParams.get("origin"), "ROM1");
});

test("does not resolve Paola as Pietrapaola", async () => {
  const provider = new ItabusProvider(async () => Response.json({
    data: [
      { code: "ROM_T", name: "Roma" },
      { code: "ROM1", name: "Roma (Tiburtina Terminal Bus)", parent: "ROM_T" },
      { code: "PIE_T", name: "Pietrapaola" },
      { code: "PIE1", name: "Pietrapaola", parent: "PIE_T" },
    ],
  }));

  await assert.rejects(
    provider.searchJourneys({
      origin: "Roma",
      destination: "Paola",
      date: "2026-11-10",
      adults: 1,
      children: 0,
    }),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN_LOCATION",
  );
});

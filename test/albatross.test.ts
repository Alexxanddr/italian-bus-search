import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FedericoProvider, MarinoBusProvider, parseAlbatrossJourneys, SalemiProvider } from "../src/providers/albatross.ts";

const origin = { provider: "federico", id: "ROM", name: "Roma", city: "Roma", source: "live" as const, names: [] };
const destination = { provider: "federico", id: "REG", name: "Reggio Calabria", city: "Reggio Calabria", source: "live" as const, names: [] };

test("normalizes a multi-leg Albatross journey fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/albatross-search.json", import.meta.url), "utf8")) as unknown;

  assert.deepEqual(parseAlbatrossJourneys(fixture, "federico", origin, destination, "https://booking.example/"), [{
    provider: "federico",
    tripId: "fixture-leg-1+fixture-leg-2",
    origin: { id: "ROM-STOP", name: "Roma" },
    destination: { id: "REG-STOP", name: "Reggio Calabria" },
    departure: "2026-11-10T21:30:00+00:00",
    arrival: "2026-11-11T06:35:00+00:00",
    durationMinutes: 545,
    available: true,
    price: { amount: 37.5, currency: "EUR" },
    bookingUrl: "https://booking.example/",
  }]);
});

test("does not turn a missing Albatross price into zero", () => {
  const fixture = [{
    trips: [{
      trip: { tripId: "trip", blocked: false, canceled: false },
      departureStopId: "ROM-STOP",
      departureDateTime: "2026-11-10T10:00:00+00:00",
      arrivalStopId: "REG-STOP",
      arrivalDateTime: "2026-11-10T11:00:00+00:00",
    }],
    calculatedPrice: null,
  }];

  assert.equal(parseAlbatrossJourneys(fixture, "federico", origin, destination, "https://booking.example/")[0]?.price, null);
});

test("searches Albatross localities and journeys with the anonymous protocol", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/albatross-search.json", import.meta.url), "utf8")) as unknown;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    calls.push({ url, init });
    if (url.includes("locations/from")) return Response.json([{ id: "ROM", description: "Roma" }]);
    if (url.includes("locations/to")) return Response.json([{ id: "REG", description: "Reggio Calabria" }]);
    if (url.includes("fareCategories")) {
      return Response.json([{ id: "CHILD", description: "Ridotto 0-11", enabled: true, type: 0 }]);
    }
    return Response.json(fixture);
  };
  const provider = new FedericoProvider(fetcher);

  assert.equal((await provider.searchLocations("rom"))[0]?.id, "ROM");
  const input = { origin: "Roma", destination: "Reggio Calabria", date: "2026-11-10", adults: 2, children: 1 };
  const journey = (await provider.searchJourneys(input))[0];
  assert.equal(journey?.price?.amount, 37.5);
  assert.equal(journey?.bookingUrl, "https://booking.autolineefederico.it/it/from/Roma/261110/to/Reggio%20Calabria/?adulti=2");
  assert.equal((await provider.searchJourneys(input))[0]?.price?.amount, 37.5);

  const searchCalls = calls.filter(({ url }) => url.includes("/search/s/"));
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(searchCalls[0]?.init?.body)), [
    { fId: null, extra: {}, subGroupId: 0 },
    { fId: null, extra: {}, subGroupId: 1 },
    { fId: "CHILD", extra: {}, subGroupId: 2 },
  ]);
  assert.equal(new Headers(searchCalls[0]?.init?.headers).get("albatross-tenant"), "autolineefederico");
});

test("enriches actual stops with locality and address, caches metadata and preserves journeys on metadata failure", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/albatross-search.json", import.meta.url), "utf8"));
  for (const failure of [false, true]) {
    let stopCalls = 0;
    const provider = new FedericoProvider(async (input) => {
      const url = String(input);
      if (url.includes("stopsFrom")) {
        stopCalls++;
        if (failure) throw new Error("metadata unavailable");
        return Response.json([{ id: "REG-STOP", shortDescription: "Rende Cosenza Nord", address: "via Synthetic" }]);
      }
      if (url.includes("locations/from")) return Response.json([{ id: "ROM", description: "Roma" }]);
      if (url.includes("locations/to")) return Response.json([{ id: "REG", description: "Cosenza" }]);
      return Response.json(fixture);
    });
    const input = { origin: "Roma", destination: "Cosenza", date: "2026-11-10", adults: 1, children: 0 };
    const result = await provider.searchJourneys(input);
    assert.equal(result.length, 1); assert.equal(result[0]?.price?.amount, 37.5);
    assert.deepEqual(result[0]?.destination, failure ? { id: "REG-STOP", name: "Cosenza" } : { id: "REG-STOP", name: "Rende Cosenza Nord", city: "Cosenza", address: "via Synthetic" });
    await provider.searchJourneys({ ...input, date: "2026-11-11" });
    assert.equal(stopCalls, failure ? 2 : 1);
  }
});

test("configures every Albatross tenant adapter as available", () => {
  assert.deepEqual([new SalemiProvider(), new FedericoProvider(), new MarinoBusProvider()].map(({ id, status }) => ({ id, status })), [
    { id: "salemi", status: "available" },
    { id: "federico", status: "available" },
    { id: "marinobus", status: "available" },
  ]);
});

test("builds verified Albatross booking search links for every tenant", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/albatross-search.json", import.meta.url), "utf8")) as unknown;
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();
    if (url.includes("locations/from")) return Response.json([{ id: "ROM", description: "Roma" }]);
    if (url.includes("locations/to")) return Response.json([{ id: "MIL", description: "Milano" }]);
    return Response.json(fixture);
  };
  const cases = [
    [new SalemiProvider(fetcher), "booking.autoservizisalemi.it"],
    [new FedericoProvider(fetcher), "booking.autolineefederico.it"],
    [new MarinoBusProvider(fetcher), "booking.marinobus.it"],
  ] as const;

  for (const [provider, host] of cases) {
    const result = await provider.searchJourneys({
      origin: "Roma",
      destination: "Milano",
      date: "2026-11-10",
      adults: 1,
      children: 0,
    });
    assert.equal(result[0]?.bookingUrl, `https://${host}/it/from/Roma/261110/to/Milano/?adulti=1`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { TrenitaliaQuoteProvider } from "../src/rail/trenitalia-quote.ts";

const input = { origin: "Roma Termini", destination: "Milano Centrale", date: "2026-11-10", adults: 1, children: 0 };

test("normalizes saleability and prices from a synthetic lefrecce quote", async () => {
  const fetcher: typeof fetch = async (request) => String(request).includes("locations/search")
    ? Response.json([{ id: String(request).includes("Roma") ? 1 : 2, name: String(request).includes("Roma") ? "Roma Termini" : "Milano Centrale" }])
    : Response.json({ solutions: [{ solution: { id: "synthetic-1", departureTime: "2026-11-10T08:10:00+01:00", arrivalTime: "2026-11-10T11:50:00+01:00", status: "SALEABLE", price: { amount: 44.9, currency: "€", hideAmount: false }, trains: [{ name: "9516" }], nodes: [{ origin: "Roma Termini", bdoOrigin: "S08409", destination: "Milano Centrale", departureTime: "2026-11-10T08:10:00+01:00", arrivalTime: "2026-11-10T11:50:00+01:00", train: { name: "9516" } }] } }, { solution: { id: "synthetic-2", departureTime: "2026-11-10T09:00:00+01:00", arrivalTime: "2026-11-10T13:00:00+01:00", status: "NOT_SALEABLE", trains: [{ acronym: "UB" }], nodes: [{ origin: "Roma Termini", destination: "Milano Centrale", departureTime: "2026-11-10T09:00:00+01:00", arrivalTime: "2026-11-10T13:00:00+01:00", train: { acronym: "UB" } }] } }] });
  const quotes = await new TrenitaliaQuoteProvider(fetcher).searchQuotes(input);
  assert.deepEqual(quotes[0]?.trainNumbers, ["9516"]);
  assert.equal(quotes[0]?.price?.amount, 44.9);
  assert.equal(quotes[0]?.price?.currency, "EUR");
  assert.equal(quotes[0]?.legs?.[0]?.origin.id, "S08409");
  assert.equal(quotes[1]?.available, false);
  assert.equal(quotes[1]?.price, null);
  assert.deepEqual(quotes[1]?.trainNumbers, ["UB"]);
});

test("fails safely on quote rate limits and ambiguous locations", async () => {
  await assert.rejects(new TrenitaliaQuoteProvider(async () => new Response("", { status: 429 })).searchQuotes(input), (error: unknown) => error instanceof AppError && error.code === "RATE_LIMITED");
  await assert.rejects(new TrenitaliaQuoteProvider(async () => Response.json([{ id: 1, name: "Roma Termini" }, { id: 2, name: "Roma Termini" }])).searchQuotes(input), (error: unknown) => error instanceof AppError && error.code === "AMBIGUOUS_LOCATION");
});

test("reports the upstream pagination bound instead of silently returning a truncated set", async () => {
  const provider = new TrenitaliaQuoteProvider(async () => Response.json({ solutions: Array.from({ length: 10 }, (_, index) => ({ solution: {
    id: String(index), departureTime: "2026-11-10T08:00:00+01:00", arrivalTime: "2026-11-10T10:00:00+01:00", nodes: [],
  } })) }));
  await assert.rejects(provider.searchQuotes({ ...input, origin: "IT::StopPlace:otherTRENITALIA:1", destination: "IT::StopPlace:otherTRENITALIA:2" }), /pagination safety limit/);
});

test("provides cached live station discovery without a timetable cache", async () => {
  let requests = 0;
  const provider = new TrenitaliaQuoteProvider(async () => { requests += 1; return Response.json([{ id: 123, name: "Roma Termini" }]); });
  const stations = await provider.searchLocations("Roma");
  assert.equal(stations[0]?.id, "IT::StopPlace:otherTRENITALIA:123");
  assert.equal(stations[0]?.source, "live");
  await provider.searchLocations("Roma");
  assert.equal(requests, 1);
});

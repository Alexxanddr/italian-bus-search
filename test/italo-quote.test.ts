import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { ItaloQuoteProvider } from "../src/rail/italo-quote.ts";

const input = { origin: "Roma Termini", destination: "Milano Centrale", date: "2026-11-10", adults: 1, children: 1 };

test("normalizes an anonymous synthetic Italo booking quote and cleans up its session", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  let bookingBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (request, init) => {
    const url = String(request);
    calls.push({ url, method: init?.method });
    if (url.endsWith("/api/login")) return Response.json({ status: 200, isAnonymous: true }, { headers: { "set-cookie": "BIGSessionToken=synthetic-token; Path=/; Secure" } });
    if (url.endsWith("stations/list")) return Response.json({ RMT: { name: "Roma Termini", isDisabled: false }, MC_: { name: "Milano Centrale", isDisabled: false } });
    if (url.endsWith("/booking") && init?.method === "POST") { bookingBody = JSON.parse(String(init.body)) as Record<string, unknown>; return Response.json({ operationId: "synthetic-operation", pollAfter: 0 }, { status: 202 }); }
    if (url.includes("booking/status/")) return Response.json({ bookingId: "synthetic-booking", trips: [{ direction: "forward", travelSolutions: [{ journeys: [{ serviceProvider: "ITALO", segments: [{ trainNumber: "9904", std: "2026-11-10T05:40:00", sta: "2026-11-10T09:20:00", fares: [{ availableCount: 3, offerType: "Economy", productClass: "Smart", paxFares: [{ fullPaxDiscountPrice: 29.9 }, { fullPaxDiscountPrice: 14.9 }] }] }] }] }] }] });
    return Response.json({});
  };
  const provider = new ItaloQuoteProvider(fetcher);
  const stations = await provider.searchLocations("Roma");
  const quote = (await provider.searchQuotes({ ...input, origin: stations[0]!.id, destination: "IT::StopPlace:MC_" }))[0];
  assert.equal(quote?.price?.amount, 44.8);
  assert.equal(quote?.price?.fareName, "Economy");
  assert.equal(quote?.price?.travelClass, "Smart");
  assert.deepEqual(quote?.legs?.map(({ trainNumber }) => trainNumber), ["9904"]);
  assert.equal(quote?.departure, "2026-11-10T05:40:00+01:00");
  assert.equal(quote?.available, true);
  assert.equal(quote?.legs?.[0]?.origin.name, "Roma Termini");
  assert.equal(quote?.legs?.[0]?.destination.name, "Milano Centrale");
  assert.equal(bookingBody?.childPassengers, 1);
  assert.equal(bookingBody?.promocodeAlias, "");
  assert.ok(calls.some(({ url, method }) => url.endsWith("/synthetic-booking") && method === "DELETE"));
  assert.ok(calls.some(({ url, method }) => url.endsWith("/working-sessions") && method === "DELETE"));
});

test("retries a transient polling failure within the bounded operation window", async () => {
  let polls = 0;
  const provider = new ItaloQuoteProvider(async (request, init) => {
    const url = String(request);
    if (url.endsWith("/api/login")) return Response.json({}, { headers: { "set-cookie": "BIGSessionToken=synthetic-token; Path=/" } });
    if (url.endsWith("stations/list")) return Response.json({ RMT: { name: "Roma Termini" }, MC_: { name: "Milano Centrale" } });
    if (url.endsWith("/booking") && init?.method === "POST") return Response.json({ operationId: "operation", pollAfter: 0, operationTimeout: 1_000 }, { status: 202 });
    if (url.includes("booking/status/")) {
      polls += 1;
      return polls === 1 ? new Response("", { status: 500 }) : Response.json({ trips: [{ direction: "forward", travelSolutions: [] }] });
    }
    return Response.json({});
  });
  assert.deepEqual(await provider.searchQuotes(input), []);
  assert.equal(polls, 2);
});

test("fails safely when the anonymous Italo session is unavailable", async () => {
  await assert.rejects(new ItaloQuoteProvider(async () => Response.json({ status: 200 })).searchQuotes(input), (error: unknown) => error instanceof AppError && error.code === "QUOTE_UNAVAILABLE");
});

test("cleans up sessions on timeout and never prices empty passenger fares as zero", async () => {
  for (const timedOut of [true, false]) {
    let cleaned = false;
    const provider = new ItaloQuoteProvider(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/api/login")) return Response.json({}, { headers: { "set-cookie": "BIGSessionToken=synthetic; Path=/" } });
      if (url.endsWith("stations/list")) return Response.json({ RMT: { name: "Roma Termini" }, MC_: { name: "Milano Centrale" } });
      if (url.endsWith("/booking") && init?.method === "POST") return Response.json({ operationId: "test", pollAfter: 0, operationTimeout: timedOut ? 0 : 1000 }, { status: 202 });
      if (url.includes("booking/status")) return Response.json({ trips: [{ direction: "forward", travelSolutions: [{ journeys: [{ serviceProvider: "ITALO", segments: [{ trainNumber: "1", std: "2026-11-10T08:00:00", sta: "2026-11-10T10:00:00", fares: [{ availableCount: 1, paxFares: [] }] }] }] }] }] });
      if (url.endsWith("working-sessions")) cleaned = true;
      return Response.json({});
    });
    if (timedOut) await assert.rejects(provider.searchQuotes(input), /timed out/);
    else assert.equal((await provider.searchQuotes(input))[0]?.price, null);
    assert.equal(cleaned, true);
  }
});

test("discovers enabled Italo stations anonymously and preserves their IDs", async () => {
  const provider = new ItaloQuoteProvider(async (_, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({ RMT: { name: "Roma Termini", isDisabled: false }, XXX: { name: "Roma Disabled", isDisabled: true } });
  });
  const stations = await provider.searchLocations("Roma");
  assert.equal(stations.length, 1);
  assert.equal(stations[0]?.id, "IT::StopPlace:RMT");
  assert.equal(stations[0]?.source, "live");
});

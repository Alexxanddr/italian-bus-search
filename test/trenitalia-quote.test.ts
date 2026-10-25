import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { TrenitaliaQuoteProvider } from "../src/rail/trenitalia-quote.ts";

const input = { origin: "Roma Termini", destination: "Milano Centrale", date: "2026-11-10", adults: 1, children: 0 };

test("normalizes saleability and prices from a synthetic lefrecce quote", async () => {
  const fetcher: typeof fetch = async (request) => String(request).includes("locations/search")
    ? Response.json([{ id: String(request).includes("Roma") ? 1 : 2, name: String(request).includes("Roma") ? "Roma Termini" : "Milano Centrale" }])
    : Response.json({ solutions: [{ solution: { id: "synthetic-1", departureTime: "2026-11-10T08:10:00+01:00", arrivalTime: "2026-11-10T11:50:00+01:00", status: "SALEABLE", price: { amount: 44.9, currency: "€", hideAmount: false }, trains: [{ name: "9516" }] } }, { solution: { id: "synthetic-2", departureTime: "2026-11-10T09:00:00+01:00", arrivalTime: "2026-11-10T13:00:00+01:00", status: "NOT_SALEABLE", trains: [{ description: "9999" }] } }] });
  const quotes = await new TrenitaliaQuoteProvider(fetcher).searchQuotes(input);
  assert.deepEqual(quotes[0]?.trainNumbers, ["9516"]);
  assert.equal(quotes[0]?.price?.amount, 44.9);
  assert.equal(quotes[0]?.price?.currency, "EUR");
  assert.equal(quotes[1]?.available, false);
  assert.equal(quotes[1]?.price, null);
});

test("fails safely on quote rate limits and ambiguous locations", async () => {
  await assert.rejects(new TrenitaliaQuoteProvider(async () => new Response("", { status: 429 })).searchQuotes(input), (error: unknown) => error instanceof AppError && error.code === "RATE_LIMITED");
  await assert.rejects(new TrenitaliaQuoteProvider(async () => Response.json([{ id: 1, name: "Roma Termini" }, { id: 2, name: "Roma Termini" }])).searchQuotes(input), (error: unknown) => error instanceof AppError && error.code === "AMBIGUOUS_LOCATION");
});

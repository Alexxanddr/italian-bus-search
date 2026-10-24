import assert from "node:assert/strict";
import test from "node:test";

import { AppError, type Journey, type SearchInput } from "../src/domain.ts";
import type { Provider } from "../src/providers/provider.ts";
import { SearchService } from "../src/search.ts";

const input: SearchInput = {
  origin: "Roma",
  destination: "Milano",
  date: "2026-11-10",
  adults: 1,
  children: 0,
};

const journey: Journey = {
  provider: "working",
  tripId: "1",
  origin: { id: "ROM", name: "Roma" },
  destination: { id: "MIL", name: "Milano" },
  departure: "2026-11-10T08:00:00+01:00",
  arrival: "2026-11-10T14:00:00+01:00",
  durationMinutes: 360,
  available: true,
  price: { amount: 20, currency: "EUR" },
};

test("keeps partial results when one provider is unavailable", async () => {
  const working: Provider = {
    id: "working",
    status: "available",
    searchLocations: async () => [],
    searchJourneys: async () => [journey],
  };
  const failing: Provider = {
    id: "failing",
    status: "unavailable",
    searchLocations: async () => [],
    searchJourneys: async () => {
      throw new AppError("PROVIDER_UNAVAILABLE", "temporarily unavailable", 503);
    },
  };

  assert.deepEqual(await new SearchService([working, failing]).searchJourneys(input), {
    journeys: [journey],
    errors: [
      {
        provider: "failing",
        code: "PROVIDER_UNAVAILABLE",
        message: "temporarily unavailable",
      },
    ],
  });
});

test("distinguishes no journeys from provider failure", async () => {
  const empty: Provider = {
    id: "empty",
    status: "available",
    searchLocations: async () => [],
    searchJourneys: async () => [],
  };

  assert.deepEqual(await new SearchService([empty]).searchJourneys(input), {
    journeys: [],
    errors: [
      {
        provider: "empty",
        code: "NO_JOURNEYS",
        message: "No journeys found",
      },
    ],
  });
});

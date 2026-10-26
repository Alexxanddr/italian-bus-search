import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { AppError } from "../domain.ts";
import type { RailLiveProvider, RailQuoteProvider, RailScheduleProvider } from "../rail/provider.ts";
import { createDefaultRailProviders, createDefaultRailQuoteProviders } from "../rail/default.ts";
import { RailSearchService } from "../rail/search.ts";
import { ItaloLiveProvider } from "../rail/italo-live.ts";
import { TrenitaliaLiveProvider } from "../rail/trenitalia-live.ts";
import { createDefaultProviders } from "../providers/default.ts";
import type { Provider } from "../providers/provider.ts";
import { createRateLimiter } from "../rate-limit.ts";
import { SearchService } from "../search.ts";
import { defaultResultLimit, maximumResultLimit, validateLocationQuery, validateResultLimit, validateSearchInput, validateServiceDate } from "../validation.ts";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const errorCodeSchema = z.enum([
  "INVALID_INPUT",
  "UNKNOWN_LOCATION",
  "NO_JOURNEYS",
  "PROVIDER_UNAVAILABLE",
  "INCOMPATIBLE_RESPONSE",
  "RATE_LIMITED",
  "AMBIGUOUS_LOCATION",
  "COVERAGE_UNAVAILABLE",
  "QUOTE_UNAVAILABLE",
  "LIVE_STATUS_UNAVAILABLE",
  "TRAIN_NOT_FOUND",
]);
const providerErrorSchema = z.object({ provider: z.string(), code: errorCodeSchema, message: z.string() });
const locationSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  city: z.string(),
  address: z.string().optional(),
  source: z.enum(["live", "historical_snapshot"]),
  observedAt: z.string().optional(),
});
const journeySchema = z.object({
  provider: z.string(),
  tripId: z.string(),
  origin: z.object({ id: z.string(), name: z.string() }),
  destination: z.object({ id: z.string(), name: z.string() }),
  departure: z.string(),
  arrival: z.string(),
  durationMinutes: z.number(),
  available: z.boolean(),
  price: z.object({ amount: z.number(), currency: z.string() }).nullable(),
  fare: z.string().optional(),
  bookingUrl: z.string().optional(),
});
const dataSourceSchema = z.object({ source: z.string(), publishedAt: z.string(), validFrom: z.string(), validThrough: z.string() });
const railLegSchema = z.object({
  trainNumber: z.string(),
  origin: z.object({ id: z.string(), name: z.string() }),
  destination: z.object({ id: z.string(), name: z.string() }),
  departure: z.string(),
  arrival: z.string(),
});
const liveStatusSchema = z.object({
  observedAt: z.string(), source: z.string(), freshness: z.enum(["current", "stale", "date_unverified"]),
  delayMinutes: z.number().int().optional(), cancelled: z.boolean().optional(),
});
const railJourneySchema = z.object({
  provider: z.enum(["trenitalia", "italo"]), journeyId: z.string(),
  origin: z.object({ id: z.string(), name: z.string() }), destination: z.object({ id: z.string(), name: z.string() }),
  departure: z.string(), arrival: z.string(), durationMinutes: z.number().int().nonnegative(), changes: z.number().int().nonnegative(),
  legs: z.array(railLegSchema), available: z.boolean().nullable(),
  price: z.object({ amount: z.number(), currency: z.string(), fareName: z.string().optional(), travelClass: z.string().optional(), observedAt: z.string(), source: z.string() }).nullable(),
  bookingUrl: z.string().optional(), timetableSource: dataSourceSchema, liveStatus: liveStatusSchema.optional(),
});

export type BusMcpDependencies = {
  providers?: readonly Provider[];
  railProviders?: readonly RailScheduleProvider[];
  railLiveProviders?: readonly RailLiveProvider[];
  railQuoteProviders?: readonly RailQuoteProvider[];
  consumeSearch?: () => void;
};

export function createBusMcpServer(dependencies: BusMcpDependencies = {}): McpServer {
  const service = new SearchService(dependencies.providers ?? createDefaultProviders());
  const railService = new RailSearchService(dependencies.railProviders ?? createDefaultRailProviders(), dependencies.railQuoteProviders ?? (dependencies.railProviders === undefined ? createDefaultRailQuoteProviders() : []));
  const railLiveProviders = dependencies.railLiveProviders ?? [new TrenitaliaLiveProvider(), new ItaloLiveProvider()];
  const limiter = createRateLimiter();
  const consumeSearch = dependencies.consumeSearch ?? (() => limiter("mcp"));
  const server = new McpServer({ name: "italian-bus-search", version: "0.2.4" });

  server.registerTool("list_providers", {
    title: "List Italian bus providers",
    description: "BUS ONLY. List configured bus/coach providers and their status. Never use this tool for trains or rail; use list_train_providers instead.",
    outputSchema: z.object({
      providers: z.array(z.object({
        id: z.string(),
        status: z.enum(["available", "limited", "unavailable", "blocked"]),
        statusReason: z.string().optional(),
      })),
    }),
    annotations,
  }, () => {
    const output = { providers: service.listProviders() };
    const text = output.providers.map(({ id, status, statusReason }) =>
      `- ${id}: ${status}${statusReason === undefined ? "" : ` — ${statusReason}`}`
    ).join("\n");
    return toolResult(output, text || "No providers are configured.");
  });

  server.registerTool("list_train_providers", {
    title: "List Italian train providers",
    description: "TRAINS ONLY. Use for requests involving trains or rail. Lists train operators and whether schedule, price, live-status, and station-board capabilities are enabled.",
    outputSchema: z.object({
      providers: z.array(z.object({
        id: z.enum(["trenitalia", "italo"]),
        capabilities: z.object({ schedule: z.boolean(), price: z.boolean(), liveStatus: z.boolean(), stationBoard: z.boolean() }),
      })),
    }),
    annotations,
  }, () => {
    const output = { providers: railService.listProviders(railLiveProviders.map(({ id }) => id)) };
    return toolResult(output, output.providers.map(({ id, capabilities }) => `- ${id}: schedule=${capabilities.schedule}, price=${capabilities.price}, live=${capabilities.liveStatus}, board=${capabilities.stationBoard}`).join("\n") || "No train providers are configured.");
  });

  server.registerTool("search_locations", {
    title: "Search Italian bus locations",
    description: "BUS ONLY. Find bus/coach location IDs and exact names. Never use for train stations; use search_train_locations instead. For an aggregate bus search, reuse exact names shared across providers.",
    inputSchema: z.object({
      query: z.string().describe("Partial city, stop, or location name"),
      provider: z.string().optional().describe("Provider ID; omit to search every provider"),
      limit: z.number().int().min(1).max(maximumResultLimit).default(defaultResultLimit),
    }),
    outputSchema: z.object({
      locations: z.array(locationSchema),
      errors: z.array(providerErrorSchema),
      total: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    annotations,
  }, async ({ query, provider, limit }) => {
    try {
      consumeSearch();
      const result = await service.searchLocations(validateLocationQuery(query), provider);
      const total = result.locations.length;
      const output = {
        locations: result.locations.slice(0, validateResultLimit(limit)).map((location) => locationSchema.parse(location)),
        errors: result.errors,
        total,
        truncated: total > limit,
      };
      const locations = output.locations.map(({ provider: id, name, city, id: locationId }) =>
        `- [${id}] ${name} (${city}) — ID: ${locationId}`
      );
      return toolResult(output, [...locations, ...formatErrors(output.errors)].join("\n") || "No locations found.");
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("search_journeys", {
    title: "Search Italian bus journeys",
    description: "BUS ONLY. Search one-way bus/coach journeys. Never use for trains or rail; use search_train_journeys instead. Results include official links for continuing manually on provider sites.",
    inputSchema: z.object({
      origin: z.string().describe("Exact shared location name for aggregate searches, or a provider-specific ID when provider is set"),
      destination: z.string().describe("Exact shared location name for aggregate searches, or a provider-specific ID when provider is set"),
      date: z.string().describe("Real future date in YYYY-MM-DD format"),
      adults: z.number().int().min(1).max(9).default(1),
      children: z.number().int().min(0).max(9).default(0),
      provider: z.string().optional().describe("Provider ID; omit to search every provider"),
      limit: z.number().int().min(1).max(maximumResultLimit).default(defaultResultLimit),
    }),
    outputSchema: z.object({
      journeys: z.array(journeySchema),
      errors: z.array(providerErrorSchema),
      total: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    annotations,
  }, async ({ origin, destination, date, adults, children, provider, limit }) => {
    try {
      consumeSearch();
      const result = await service.searchJourneys(validateSearchInput({ origin, destination, date, adults, children }), provider);
      const total = result.journeys.length;
      const output = {
        journeys: result.journeys.slice(0, validateResultLimit(limit)),
        errors: result.errors,
        total,
        truncated: total > limit,
      };
      return toolResult(output, [...output.journeys.map(formatJourney), ...formatErrors(output.errors)].join("\n") || "No journeys found.");
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("search_train_locations", {
    title: "Search Italian train stations",
    description: "TRAINS ONLY. Use for every request involving trains or rail to find operator-aware stations. Prefer names across operators; station IDs are operator-specific.",
    inputSchema: z.object({ query: z.string(), provider: z.enum(["trenitalia", "italo"]).optional(), limit: z.number().int().min(1).max(maximumResultLimit).default(defaultResultLimit) }),
    outputSchema: z.object({ locations: z.array(locationSchema), errors: z.array(providerErrorSchema), total: z.number().int().nonnegative(), truncated: z.boolean() }), annotations,
  }, async ({ query, provider, limit }) => {
    try {
      consumeSearch();
      const result = await railService.searchLocations(validateLocationQuery(query), provider);
      const total = result.locations.length;
      const output = { locations: result.locations.slice(0, validateResultLimit(limit)).map((location) => locationSchema.parse(location)), errors: result.errors, total, truncated: total > limit };
      return toolResult(output, [...output.locations.map(({ provider: id, name, id: stationId }) => `- [${id}] ${name} — ID: ${stationId}`), ...formatErrors(output.errors)].join("\n") || "No train stations found.");
    } catch (error) { return toolError(error); }
  });

  server.registerTool("search_train_journeys", {
    title: "Search Italian train journeys",
    description: "TRAINS ONLY. Requires origin, destination, and date. When the user states passenger counts, always pass adults and children explicitly. Each price is the total for those passengers; never infer discounts or convert it to a per-person price.",
    inputSchema: z.object({ origin: z.string(), destination: z.string(), date: z.string(), adults: z.number().int().min(1).max(9).default(1).describe("Number of adult passengers; pass explicitly when stated by the user"), children: z.number().int().min(0).max(9).default(0).describe("Number of child passengers; pass explicitly when stated by the user, including zero"), provider: z.enum(["trenitalia", "italo"]).optional(), offset: z.number().int().min(0).default(0).describe("Result offset; paginate by adding the previous limit when truncated is true"), limit: z.number().int().min(1).max(maximumResultLimit).default(defaultResultLimit) }),
    outputSchema: z.object({ journeys: z.array(railJourneySchema), errors: z.array(providerErrorSchema), total: z.number().int().nonnegative(), truncated: z.boolean() }), annotations,
  }, async ({ origin, destination, date, adults, children, provider, offset, limit }) => {
    try {
      consumeSearch();
      const result = await railService.searchJourneys(validateSearchInput({ origin, destination, date, adults, children }), provider);
      const total = result.journeys.length;
      const output = { journeys: result.journeys.slice(offset, offset + validateResultLimit(limit)), errors: result.errors, total, truncated: total > offset + limit };
      return toolResult(output, [...output.journeys.map((journey) => `- [${journey.provider}] ${journey.origin.name} → ${journey.destination.name}: ${journey.departure} → ${journey.arrival}, ${journey.price === null ? "price unavailable" : `${journey.price.currency} ${journey.price.amount.toFixed(2)}`}${journey.bookingUrl === undefined ? "" : ` — [Continue on ${journey.provider}](${journey.bookingUrl})`}`), ...formatErrors(output.errors)].join("\n") || "No train journeys found.");
    } catch (error) { return toolError(error); }
  });

  server.registerTool("get_train_status", {
    title: "Get train status",
    description: "Get live status using operator, train number, service date, and origin identity. Live status may be unavailable independently of schedules.",
    inputSchema: z.object({ provider: z.enum(["trenitalia", "italo"]), trainNumber: z.string(), serviceDate: z.string(), origin: z.string() }),
    outputSchema: liveStatusSchema, annotations,
  }, async ({ provider, trainNumber, serviceDate, origin }) => {
    try {
      consumeSearch();
      validateServiceDate(serviceDate);
      const adapter = railLiveProviders.find(({ id }) => id === provider);
      if (adapter === undefined) throw new AppError("LIVE_STATUS_UNAVAILABLE", `${provider} live status is disabled pending verified protocol and authorization`, 503);
      const output = await adapter.getTrainStatus({ trainNumber, serviceDate, origin });
      return toolResult(output, `${provider} ${trainNumber}: ${output.freshness}${output.delayMinutes === undefined ? "" : `, ${output.delayMinutes} min delay`}`);
    } catch (error) { return toolError(error); }
  });

  server.registerTool("get_station_board", {
    title: "Get train station board",
    description: "Get an operator station board with its observation timestamp. Live boards may be unavailable independently of schedules.",
    inputSchema: z.object({ provider: z.enum(["trenitalia", "italo"]), stationId: z.string(), stationName: z.string(), direction: z.enum(["arrivals", "departures"]) }),
    outputSchema: z.object({ provider: z.enum(["trenitalia", "italo"]), station: z.object({ id: z.string(), name: z.string() }), direction: z.enum(["arrivals", "departures"]), observedAt: z.string(), source: z.string(), services: z.array(z.object({ trainNumber: z.string(), scheduledTime: z.string(), delayMinutes: z.number().int().optional(), cancelled: z.boolean().optional() })) }), annotations,
  }, async ({ provider, stationId, stationName, direction }) => {
    try {
      consumeSearch();
      const adapter = railLiveProviders.find(({ id }) => id === provider);
      if (adapter === undefined) throw new AppError("LIVE_STATUS_UNAVAILABLE", `${provider} station boards are disabled pending verified protocol and authorization`, 503);
      const output = await adapter.getStationBoard({ stationId: validateLocationQuery(stationId), stationName: validateLocationQuery(stationName), direction });
      return toolResult(output, `${output.station.name} ${direction}, observed ${output.observedAt}: ${output.services.length} services`);
    } catch (error) { return toolError(error); }
  });

  return server;
}

function toolResult(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof AppError ? error.message : "Unexpected server error";
  return { isError: true, content: [{ type: "text", text: message }] };
}

function formatJourney(journey: z.infer<typeof journeySchema>): string {
  const price = journey.price === null ? "price unavailable" : `${journey.price.currency} ${journey.price.amount.toFixed(2)}`;
  const availability = journey.available ? "available" : "unavailable";
  const booking = journey.bookingUrl === undefined ? "" : ` — [Continue on ${journey.provider}](${journey.bookingUrl})`;
  const hours = Math.floor(journey.durationMinutes / 60);
  const minutes = journey.durationMinutes % 60;
  const duration = hours === 0 ? `${minutes} min` : `${hours}h${minutes === 0 ? "" : ` ${minutes}m`}`;
  return `- [${journey.provider}] ${journey.origin.name} → ${journey.destination.name}: ${journey.departure} → ${journey.arrival}, ${duration}, ${price}, ${availability}${booking}`;
}

function formatErrors(errors: Array<z.infer<typeof providerErrorSchema>>): string[] {
  return errors.map(({ provider, code, message }) => `- ${provider} ${code}: ${message}`);
}

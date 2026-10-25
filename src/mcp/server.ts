import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { AppError } from "../domain.ts";
import { createDefaultProviders } from "../providers/default.ts";
import type { Provider } from "../providers/provider.ts";
import { createRateLimiter } from "../rate-limit.ts";
import { SearchService } from "../search.ts";
import { defaultResultLimit, maximumResultLimit, validateLocationQuery, validateResultLimit, validateSearchInput } from "../validation.ts";

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

export type BusMcpDependencies = {
  providers?: readonly Provider[];
  consumeSearch?: () => void;
};

export function createBusMcpServer(dependencies: BusMcpDependencies = {}): McpServer {
  const service = new SearchService(dependencies.providers ?? createDefaultProviders());
  const limiter = createRateLimiter();
  const consumeSearch = dependencies.consumeSearch ?? (() => limiter("mcp"));
  const server = new McpServer({ name: "italian-bus-search", version: "0.1.0" });

  server.registerTool("list_providers", {
    title: "List Italian bus providers",
    description: "List configured journey providers and their status without contacting provider systems.",
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

  server.registerTool("search_locations", {
    title: "Search Italian bus locations",
    description: "Find provider location IDs and exact names. For an aggregate search, reuse exact names shared across providers; IDs are provider-specific and should only be used with the provider field set.",
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
    description: "Search one-way journeys. When provider is omitted, use exact location names shared across providers; use provider-specific IDs only together with provider. Results include official links for continuing manually on provider sites.",
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

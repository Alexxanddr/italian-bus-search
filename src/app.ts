import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { AppError } from "./domain.ts";
import { createDefaultProviders } from "./providers/default.ts";
import type { Provider } from "./providers/provider.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { SearchService } from "./search.ts";
import { validateLocationQuery, validateSearchInput, validateServiceDate } from "./validation.ts";
import { createDefaultRailProviders, createDefaultRailQuoteProviders } from "./rail/default.ts";
import { ItaloLiveProvider } from "./rail/italo-live.ts";
import type { RailLiveProvider, RailQuoteProvider, RailScheduleProvider } from "./rail/provider.ts";
import { RailSearchService } from "./rail/search.ts";
import { TrenitaliaLiveProvider } from "./rail/trenitalia-live.ts";
import { createBusMcpServer, type BusMcpDependencies } from "./mcp/server.ts";

type Handler = (request: Request, clientId?: string) => Promise<Response>;
const loggedRoutes = new Set(["/mcp", "/providers", "/train-providers", "/locations", "/journeys", "/train-locations", "/train-journeys", "/train-status", "/station-board"]);

export function createApp(providers: readonly Provider[] = createDefaultProviders(), railProviders?: readonly RailScheduleProvider[], railLiveProviders: readonly RailLiveProvider[] = [new TrenitaliaLiveProvider(), new ItaloLiveProvider()], railQuoteProviders?: readonly RailQuoteProvider[]): Handler {
  const service = new SearchService(providers);
  const railService = new RailSearchService(railProviders ?? createDefaultRailProviders(), railQuoteProviders ?? (railProviders === undefined ? createDefaultRailQuoteProviders() : []));
  const rateLimit = createRateLimiter();
  return async (request, clientId = "local") => {
    try {
      if (new URL(request.url).pathname !== "/health") rateLimit(clientId);
      return await route(request, service, railService, railLiveProviders);
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError("PROVIDER_UNAVAILABLE", "Unexpected server error", 500);
      return json(appError.status, { error: { code: appError.code, message: appError.message } });
    }
  };
}

export function createServer(dependencies: BusMcpDependencies = {}) {
  const shared = sharedDependencies(dependencies);
  const app = createApp(shared.providers, shared.railProviders, shared.railLiveProviders, shared.railQuoteProviders);
  const mcp = createMcpApp(shared);
  const server = createHttpServer(async (request, response) => {
    const started = Date.now();
    try {
      const webRequest = await toWebRequest(request);
      const result = new URL(webRequest.url).pathname === "/mcp"
        ? await mcp.fetch(webRequest)
        : await app(webRequest, request.socket.remoteAddress);
      await sendWebResponse(response, result);
      const path = new URL(webRequest.url).pathname;
      if (path !== "/health") console.error(JSON.stringify({ event: "http_request", method: request.method, route: loggedRoutes.has(path) ? path : "unknown", status: result.status, durationMs: Date.now() - started }));
    } catch {
      if (!response.destroyed && !response.headersSent) response.writeHead(500).end("Internal server error");
    }
  });
  server.on("close", () => void mcp.close());
  return server;
}

export function createMcpApp(dependencies: BusMcpDependencies = {}) {
  const shared = sharedDependencies(dependencies);
  return createMcpHandler(() => createBusMcpServer(shared), {
    maxRequestBodySize: 64 * 1024,
    onerror: () => console.error("MCP transport error"),
  });
}

function sharedDependencies(dependencies: BusMcpDependencies): BusMcpDependencies {
  const limiter = createRateLimiter();
  return {
    providers: dependencies.providers ?? createDefaultProviders(),
    railProviders: dependencies.railProviders ?? createDefaultRailProviders(),
    railQuoteProviders: dependencies.railQuoteProviders ?? (dependencies.railProviders === undefined ? createDefaultRailQuoteProviders() : []),
    railLiveProviders: dependencies.railLiveProviders ?? [new TrenitaliaLiveProvider(), new ItaloLiveProvider()],
    consumeSearch: dependencies.consumeSearch ?? (() => limiter("mcp")),
  };
}

function toWebRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`), {
    method: request.method,
    headers,
    body: hasBody ? Readable.toWeb(request) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit & { duplex?: "half" });
}

async function sendWebResponse(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, Object.fromEntries(result.headers));
  if (result.body === null) return void response.end();
  await pipeline(Readable.fromWeb(result.body as import("node:stream/web").ReadableStream), response);
}

async function route(request: Request, service: SearchService, railService: RailSearchService, railLiveProviders: readonly RailLiveProvider[]): Promise<Response> {
  if (request.method !== "GET") throw new AppError("INVALID_INPUT", "Only GET is supported", 405);
  const url = new URL(request.url);

  if (url.pathname === "/health") return json(200, { status: "ok" });
  if (url.pathname === "/providers") return json(200, { providers: service.listProviders() });
  if (url.pathname === "/train-providers") return json(200, { providers: railService.listProviders(railLiveProviders.map(({ id }) => id)) });
  if (url.pathname === "/locations") {
    const query = validateLocationQuery(optional(url, "query"));
    const result = await service.searchLocations(query, optional(url, "provider"));
    return json(result.locations.length === 0 && result.errors.length > 0 ? 503 : 200, result);
  }
  if (url.pathname === "/journeys") {
    const result = await service.searchJourneys(validateSearchInput({
      origin: optional(url, "origin"),
      destination: optional(url, "destination"),
      date: optional(url, "date"),
      adults: optional(url, "adults"),
      children: optional(url, "children"),
    }), optional(url, "provider"));
    return json(result.journeys.length === 0 && result.errors.some(({ code }) => code !== "NO_JOURNEYS") ? 503 : 200, result);
  }
  if (url.pathname === "/train-locations") {
    const result = await railService.searchLocations(validateLocationQuery(optional(url, "query")), optional(url, "provider"));
    return json(result.locations.length === 0 && result.errors.length > 0 ? 503 : 200, result);
  }
  if (url.pathname === "/train-journeys") {
    const result = await railService.searchJourneys(validateSearchInput({ origin: optional(url, "origin"), destination: optional(url, "destination"), date: optional(url, "date"), adults: optional(url, "adults"), children: optional(url, "children") }), optional(url, "provider"));
    return json(result.journeys.length === 0 && result.errors.some(({ code }) => code !== "NO_JOURNEYS") ? 503 : 200, result);
  }
  if (url.pathname === "/train-status") {
    const provider = liveProvider(railLiveProviders, optional(url, "provider"));
    return json(200, await provider.getTrainStatus({ trainNumber: validateLocationQuery(optional(url, "trainNumber")), serviceDate: validateServiceDate(optional(url, "serviceDate")), origin: validateLocationQuery(optional(url, "origin")) }));
  }
  if (url.pathname === "/station-board") {
    const provider = liveProvider(railLiveProviders, optional(url, "provider"));
    const direction = optional(url, "direction");
    if (direction !== "arrivals" && direction !== "departures") throw new AppError("INVALID_INPUT", "direction must be arrivals or departures", 400);
    return json(200, await provider.getStationBoard({ stationId: validateLocationQuery(optional(url, "stationId")), stationName: validateLocationQuery(optional(url, "stationName")), direction }));
  }
  throw new AppError("INVALID_INPUT", "Route not found", 404);
}

function liveProvider(providers: readonly RailLiveProvider[], id: string | undefined) {
  if (id === undefined) throw new AppError("INVALID_INPUT", "provider is required", 400);
  const provider = providers.find((value) => value.id === id);
  if (provider === undefined) throw new AppError("LIVE_STATUS_UNAVAILABLE", `${id} live status is not enabled`, 503);
  return provider;
}

function optional(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value === "" || value === undefined ? undefined : value;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

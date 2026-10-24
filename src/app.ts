import { createServer as createHttpServer } from "node:http";

import { AppError, type SearchInput } from "./domain.ts";
import { FedericoProvider, MarinoBusProvider, SalemiProvider } from "./providers/albatross.ts";
import { ItabusProvider } from "./providers/itabus.ts";
import type { Provider } from "./providers/provider.ts";
import { SearchService } from "./search.ts";

const defaultProviders: readonly Provider[] = [
  new ItabusProvider(),
  new SalemiProvider(),
  new FedericoProvider(),
  new MarinoBusProvider(),
];

type Handler = (request: Request, clientId?: string) => Promise<Response>;

export function createApp(providers: readonly Provider[] = defaultProviders): Handler {
  const service = new SearchService(providers);
  const requests = new Map<string, { count: number; resetAt: number }>();
  return async (request, clientId = "local") => {
    try {
      rateLimit(clientId, requests);
      return await route(request, service);
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError("PROVIDER_UNAVAILABLE", "Unexpected server error", 500);
      return json(appError.status, { error: { code: appError.code, message: appError.message } });
    }
  };
}

export function createServer() {
  const app = createApp();
  return createHttpServer(async (request, response) => {
    const result = await app(
      new Request(new URL(request.url ?? "/", "http://localhost"), { method: request.method }),
      request.socket.remoteAddress,
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
}

async function route(request: Request, service: SearchService): Promise<Response> {
  if (request.method !== "GET") throw new AppError("INVALID_INPUT", "Only GET is supported", 405);
  const url = new URL(request.url);

  if (url.pathname === "/health") return json(200, { status: "ok" });
  if (url.pathname === "/providers") return json(200, { providers: service.listProviders() });
  if (url.pathname === "/locations") {
    const query = required(url, "query");
    const result = await service.searchLocations(query, optional(url, "provider"));
    return json(result.locations.length === 0 && result.errors.length > 0 ? 503 : 200, result);
  }
  if (url.pathname === "/journeys") {
    const result = await service.searchJourneys(parseSearchInput(url), optional(url, "provider"));
    return json(result.journeys.length === 0 && result.errors.length > 0 ? 503 : 200, result);
  }
  throw new AppError("INVALID_INPUT", "Route not found", 404);
}

function parseSearchInput(url: URL): SearchInput {
  const date = required(url, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) invalidDate();
  const parsedDate = new Date(`${date}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date || parsedDate <= today) invalidDate();

  return {
    origin: required(url, "origin"),
    destination: required(url, "destination"),
    date,
    adults: passengerCount(url, "adults", 1, 1),
    children: passengerCount(url, "children", 0, 0),
  };
}

function invalidDate(): never {
  throw new AppError("INVALID_INPUT", "date must be a real future date in YYYY-MM-DD format", 400);
}

function passengerCount(url: URL, name: string, fallback: number, minimum: number): number {
  const raw = optional(url, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > 9) {
    throw new AppError("INVALID_INPUT", `${name} must be an integer from ${minimum} to 9`, 400);
  }
  return value;
}

function required(url: URL, name: string): string {
  const value = optional(url, name);
  if (value === undefined) throw new AppError("INVALID_INPUT", `${name} is required`, 400);
  return value;
}

function optional(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value === "" || value === undefined ? undefined : value;
}

function rateLimit(clientId: string, requests: Map<string, { count: number; resetAt: number }>): void {
  const now = Date.now();
  const current = requests.get(clientId);
  if (current === undefined || current.resetAt <= now) {
    requests.set(clientId, { count: 1, resetAt: now + 60_000 });
    return;
  }
  current.count += 1;
  if (current.count > 60) throw new AppError("RATE_LIMITED", "Rate limit exceeded", 429);
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

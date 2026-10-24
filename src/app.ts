import { createServer as createHttpServer } from "node:http";

import { AppError } from "./domain.ts";
import { createDefaultProviders } from "./providers/default.ts";
import type { Provider } from "./providers/provider.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { SearchService } from "./search.ts";
import { validateLocationQuery, validateSearchInput } from "./validation.ts";

type Handler = (request: Request, clientId?: string) => Promise<Response>;

export function createApp(providers: readonly Provider[] = createDefaultProviders()): Handler {
  const service = new SearchService(providers);
  const rateLimit = createRateLimiter();
  return async (request, clientId = "local") => {
    try {
      rateLimit(clientId);
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
    return json(result.journeys.length === 0 && result.errors.length > 0 ? 503 : 200, result);
  }
  throw new AppError("INVALID_INPUT", "Route not found", 404);
}

function optional(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value === "" || value === undefined ? undefined : value;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

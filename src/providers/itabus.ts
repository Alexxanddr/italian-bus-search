import { AppError, type Journey, type Location, type SearchInput } from "../domain.ts";
import type { Provider } from "./provider.ts";

const baseUrl = "https://app.itabus.it/on/demandware.store/Sites-ITABUS-Site/it";
const bookingUrl = "https://app.itabus.it/";
const timeoutMs = 5_000;
const locationCacheMs = 60 * 60_000;
const journeyCacheMs = 60_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;
type Station = Location & { parent?: string; synonyms: string[] };

function record(value: unknown, field: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("INCOMPATIBLE_RESPONSE", `Itabus field ${field} is invalid`, 502);
  }
  return value as RecordValue;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("INCOMPATIBLE_RESPONSE", `Itabus field ${field} is invalid`, 502);
  }
  return value;
}

function durationMinutes(value: unknown, departure: string, arrival: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (clock !== null) return Number(clock[1]) * 60 + Number(clock[2]);
    const words = /^(\d+)h(?:\s*(\d+)m)?$/.exec(value);
    if (words !== null) return Number(words[1]) * 60 + Number(words[2] ?? 0);
  }
  const difference = (Date.parse(arrival) - Date.parse(departure)) / 60_000;
  if (!Number.isFinite(difference) || difference < 0) {
    throw new AppError("INCOMPATIBLE_RESPONSE", "Itabus travel duration is invalid", 502);
  }
  return difference;
}

function cheapestRate(value: unknown): { fare?: string; amount?: number; currency?: string; available: boolean } {
  const rates = record(value, "rates");
  const candidates: Array<{ fare: string; amount: number; currency: string; available: boolean }> = [];

  function visit(node: unknown, path: string[]): void {
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, path));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const rate = node as RecordValue;
    const amount = typeof rate.price === "number" ? rate.price : Number(rate.price);
    if (Number.isFinite(amount)) {
      candidates.push({
        fare: typeof rate.product_family_id === "string" ? rate.product_family_id : path.at(-1) ?? "UNKNOWN",
        amount,
        currency: typeof rate.currency === "string" ? rate.currency : "EUR",
        available: rate.available !== false,
      });
      return;
    }
    for (const [key, child] of Object.entries(rate)) visit(child, [...path, key]);
  }

  visit(rates, []);
  const cheapest = candidates.sort((left, right) => left.amount - right.amount)[0];
  return cheapest === undefined ? { available: rates.available === true } : cheapest;
}

export function parseItabusJourneys(payload: unknown): Journey[] {
  const root = record(payload, "response");
  const data = record(root.data, "data");
  const outbound = record(data.outbound, "data.outbound");
  if (!Array.isArray(outbound.routes)) {
    throw new AppError("INCOMPATIBLE_RESPONSE", "Itabus routes are missing", 502);
  }

  return outbound.routes.map((raw, index) => {
    const route = record(raw, `routes[${index}]`);
    const origin = record(route.origin, `routes[${index}].origin`);
    const destination = record(route.destination, `routes[${index}].destination`);
    const departure = string(route.departure_timestamp, "departure_timestamp");
    const arrival = string(route.arrival_timestamp, "arrival_timestamp");
    const rate = cheapestRate(route.rates);
    return {
      provider: "itabus",
      tripId: typeof route.id === "string" ? route.id : string(route.service_name, "service_name"),
      origin: {
        id: typeof origin.code === "string" ? origin.code : string(origin.name, "origin.name"),
        name: string(origin.name, "origin.name"),
      },
      destination: {
        id: typeof destination.code === "string" ? destination.code : string(destination.name, "destination.name"),
        name: string(destination.name, "destination.name"),
      },
      departure,
      arrival,
      durationMinutes: durationMinutes(route.travel_duration, departure, arrival),
      available: route.available !== false && rate.available,
      price: rate.amount === undefined ? null : { amount: rate.amount, currency: rate.currency ?? "EUR" },
      ...(rate.fare === undefined ? {} : { fare: rate.fare }),
      bookingUrl,
    };
  });
}

function parseStations(payload: unknown): Station[] {
  const root = record(payload, "response");
  if (!Array.isArray(root.data)) {
    throw new AppError("INCOMPATIBLE_RESPONSE", "Itabus stations are missing", 502);
  }
  const rawStations = root.data.map((raw, index) => record(raw, `data[${index}]`));
  const names = new Map(rawStations.flatMap((station) =>
    typeof station.code === "string" && typeof station.name === "string" ? [[station.code, station.name] as const] : []
  ));

  return rawStations.map((station, index) => {
    const id = string(station.code, `data[${index}].code`);
    const name = string(station.name, `data[${index}].name`);
    const parent = typeof station.parent === "string" ? station.parent : undefined;
    return {
      provider: "itabus",
      id,
      name,
      city: parent === undefined ? name : names.get(parent) ?? name,
      source: "live",
      ...(parent === undefined ? {} : { parent }),
      synonyms: Array.isArray(station.synonyms)
        ? station.synonyms.filter((value): value is string => typeof value === "string")
        : [],
    };
  });
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("it").trim();
}

function matches(station: Station, value: string): boolean {
  const query = normalize(value);
  return [station.id, station.name, station.city, ...station.synonyms]
    .some((candidate) => normalize(candidate).includes(query));
}

function resolveStation(stations: Station[], value: string): Station {
  const query = normalize(value);
  const exact = stations.find((station) => normalize(station.id) === query || normalize(station.name) === query);
  if (exact?.parent !== undefined) return exact;
  if (exact !== undefined) {
    const prefix = exact.id.replace(/_T$/, "");
    return stations.find((station) => station.parent === exact.id && station.id === `${prefix}1`)
      ?? stations.find((station) => station.parent === exact.id && /^[A-Z]{3}\d+$/.test(station.id))
      ?? exact;
  }
  const candidates = stations.filter((station) =>
    [station.id, station.name, station.city, ...station.synonyms]
      .some((candidate) => normalize(candidate) === query)
  );
  const physical = candidates.find((station) => station.parent !== undefined && /^[A-Z]{3}\d+$/.test(station.id));
  if (physical !== undefined) return physical;
  throw new AppError("UNKNOWN_LOCATION", `Unknown Itabus location: ${value}`, 404);
}

export class ItabusProvider implements Provider {
  readonly id = "itabus";
  readonly status = "available";
  readonly statusReason = "Authorized live integration with timeout and in-memory cache";
  private readonly fetcher: Fetcher;
  private stationsCache?: { expiresAt: number; value: Station[] };
  private readonly journeysCache = new Map<string, { expiresAt: number; value: Journey[] }>();

  constructor(fetcher: Fetcher = fetch) {
    this.fetcher = fetcher;
  }

  async searchLocations(query: string): Promise<Location[]> {
    return (await this.stations()).filter((station) => matches(station, query));
  }

  async searchJourneys(input: SearchInput): Promise<Journey[]> {
    const stations = await this.stations();
    let origin: Station;
    let destination: Station;
    try {
      origin = resolveStation(stations, input.origin);
    } catch (error) {
      if (error instanceof AppError && error.code === "UNKNOWN_LOCATION") {
        throw new AppError("UNKNOWN_LOCATION", `Unknown Itabus origin: ${input.origin}`, 404);
      }
      throw error;
    }
    try {
      destination = resolveStation(stations, input.destination);
    } catch (error) {
      if (error instanceof AppError && error.code === "UNKNOWN_LOCATION") {
        throw new AppError("UNKNOWN_LOCATION", `Unknown Itabus destination: ${input.destination}`, 404);
      }
      throw error;
    }

    const parameters = new URLSearchParams({
      origin: origin.id,
      destination: destination.id,
      datestart: input.date,
      adults: String(input.adults),
      children: String(input.children),
      membership: "false",
      code: "",
    });
    const url = `${baseUrl}/Api-Travels?${parameters}`;
    const cached = this.journeysCache.get(url);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const journeys = parseItabusJourneys(await this.getJson(url));
    this.journeysCache.set(url, { expiresAt: Date.now() + journeyCacheMs, value: journeys });
    return journeys;
  }

  private async stations(): Promise<Station[]> {
    if (this.stationsCache !== undefined && this.stationsCache.expiresAt > Date.now()) {
      return this.stationsCache.value;
    }
    const value = parseStations(await this.getJson(`${baseUrl}/Api-Stations`));
    this.stationsCache = { expiresAt: Date.now() + locationCacheMs, value };
    return value;
  }

  private async getJson(url: string): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        headers: { accept: "application/json", "user-agent": "italian-bus-search-api/0.1" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429) throw new AppError("RATE_LIMITED", "Itabus rate limit exceeded", 429);
      if (!response.ok) throw new AppError("PROVIDER_UNAVAILABLE", `Itabus responded with HTTP ${response.status}`, 503);
      try {
        return await response.json();
      } catch {
        throw new AppError("INCOMPATIBLE_RESPONSE", "Itabus returned invalid JSON", 502);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PROVIDER_UNAVAILABLE", "Itabus request timed out or failed", 503);
    }
  }
}

import { AppError, type Journey, type Location, type SearchInput } from "../domain.ts";
import type { Provider } from "./provider.ts";

const apiBaseUrl = "https://global.api.flixbus.com";
const timeoutMs = 5_000;
const locationCacheMs = 60 * 60_000;
const journeyCacheMs = 60_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;
type City = { id: string; name: string; country: string; bookable: boolean };

function record(value: unknown, field: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", `FlixBus field ${field} is invalid`, 502);
  return value as RecordValue;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AppError("INCOMPATIBLE_RESPONSE", `FlixBus field ${field} is invalid`, 502);
  return value;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("it").trim();
}

function parseCities(payload: unknown): City[] {
  if (!Array.isArray(payload)) throw new AppError("INCOMPATIBLE_RESPONSE", "FlixBus cities are missing", 502);
  return payload.map((value, index) => {
    const city = record(value, `cities[${index}]`);
    return {
      id: string(city.id, `cities[${index}].id`),
      name: string(city.name, `cities[${index}].name`),
      country: typeof city.country === "string" ? city.country : "",
      bookable: city.is_flixbus_city === true,
    };
  });
}

export function parseFlixBusJourneys(payload: unknown, input: SearchInput, origin: City, destination: City): Journey[] {
  const root = record(payload, "response");
  if (!Array.isArray(root.trips)) throw new AppError("INCOMPATIBLE_RESPONSE", "FlixBus trips are missing", 502);
  const stations = root.stations === undefined ? {} : record(root.stations, "stations");
  const feeRequired = root.platform_fee_in_price_required === true;
  const journeys: Journey[] = [];
  for (const [tripIndex, rawTrip] of root.trips.entries()) {
    const trip = record(rawTrip, `trips[${tripIndex}]`);
    const results = record(trip.results, `trips[${tripIndex}].results`);
    for (const [resultId, rawResult] of Object.entries(results)) {
      const result = record(rawResult, `trips[${tripIndex}].results.${resultId}`);
      const departure = record(result.departure, "departure");
      const arrival = record(result.arrival, "arrival");
      const departureTime = string(departure.date, "departure.date");
      const arrivalTime = string(arrival.date, "arrival.date");
      const departureTimestamp = Date.parse(departureTime);
      const arrivalTimestamp = Date.parse(arrivalTime);
      if (!Number.isFinite(departureTimestamp) || !Number.isFinite(arrivalTimestamp) || arrivalTimestamp < departureTimestamp) {
        throw new AppError("INCOMPATIBLE_RESPONSE", "FlixBus journey timestamps are invalid", 502);
      }
      const duration = record(result.duration, "duration");
      const durationMinutes = Number(duration.hours) * 60 + Number(duration.minutes ?? 0);
      if (!Number.isFinite(durationMinutes) || durationMinutes < 0) throw new AppError("INCOMPATIBLE_RESPONSE", "FlixBus journey duration is invalid", 502);
      const price = record(result.price, "price");
      const basePrice = Number(price.total);
      const feePrice = Number(price.total_with_platform_fee);
      const amount = feeRequired ? feePrice : basePrice;
      const departureStationId = typeof departure.station_id === "string" ? departure.station_id : "";
      const arrivalStationId = typeof arrival.station_id === "string" ? arrival.station_id : "";
      const stationName = (id: string, fallback: string) => {
        const station = stations[id];
        return typeof station === "object" && station !== null && typeof (station as RecordValue).name === "string"
          ? (station as RecordValue).name as string : fallback;
      };
      journeys.push({
        provider: "flixbus",
        tripId: typeof result.uid === "string" ? result.uid : resultId,
        origin: { id: departureStationId || origin.id, name: stationName(departureStationId, origin.name) },
        destination: { id: arrivalStationId || destination.id, name: stationName(arrivalStationId, destination.name) },
        departure: departureTime,
        arrival: arrivalTime,
        durationMinutes,
        available: result.status === "available",
        price: Number.isFinite(amount) && amount > 0 ? { amount, currency: "EUR" } : null,
        bookingUrl: bookingUrl(origin.id, destination.id, input),
      });
    }
  }
  return journeys.sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure));
}

function bookingUrl(origin: string, destination: string, input: SearchInput): string {
  const date = input.date.split("-").reverse().join(".");
  const params = new URLSearchParams({ departureCity: origin, arrivalCity: destination, rideDate: date, adult: String(input.adults), currency: "EUR" });
  if (input.children > 0) params.set("children", String(input.children));
  return `https://shop.flixbus.com/search?${params}`;
}

export class FlixBusProvider implements Provider {
  readonly id = "flixbus";
  readonly status = "available";
  readonly statusReason = "Authorized anonymous live integration with timeout and in-memory cache";
  private readonly fetcher: Fetcher;
  private readonly citiesCache = new Map<string, { expiresAt: number; value: City[] }>();
  private readonly journeysCache = new Map<string, { expiresAt: number; value: Journey[] }>();

  constructor(fetcher: Fetcher = fetch) { this.fetcher = fetcher; }

  async searchLocations(query: string): Promise<Location[]> {
    const cities = (await this.cities(query)).filter((city) => city.bookable);
    return cities.map((city) => ({ provider: this.id, id: city.id, name: city.name, city: city.name, source: "live" }));
  }

  async searchJourneys(input: SearchInput): Promise<Journey[]> {
    const [origins, destinations] = await Promise.all([this.cities(input.origin), this.cities(input.destination)]);
    const origin = this.resolve(origins, input.origin, "origin");
    const destination = this.resolve(destinations, input.destination, "destination");
    const params = new URLSearchParams({ from_city_id: origin.id, to_city_id: destination.id, departure_date: input.date.split("-").reverse().join("."), products: JSON.stringify({ adult: input.adults, ...(input.children > 0 ? { children: input.children } : {}) }), currency: "EUR", locale: "it_IT", search_by: "cities", include_after_midnight_rides: "1" });
    const url = `${apiBaseUrl}/search/service/v4/search?${params}`;
    const cached = this.journeysCache.get(url);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const journeys = parseFlixBusJourneys(await this.getJson(url), input, origin, destination);
    this.journeysCache.set(url, { expiresAt: Date.now() + journeyCacheMs, value: journeys });
    return journeys;
  }

  private async cities(query: string): Promise<City[]> {
    const cacheKey = normalize(query);
    const cached = this.citiesCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const value = parseCities(await this.getJson(`${apiBaseUrl}/search/autocomplete/cities?q=${encodeURIComponent(query)}&lang=it`));
    this.citiesCache.set(cacheKey, { expiresAt: Date.now() + locationCacheMs, value });
    return value;
  }

  private resolve(cities: City[], value: string, kind: "origin" | "destination"): City {
    const expected = normalize(value);
    const matches = cities.filter((city) => city.bookable && (city.id === value || normalize(city.name) === expected));
    if (matches.length !== 1) throw new AppError("UNKNOWN_LOCATION", `Unknown or ambiguous FlixBus ${kind}: ${value}`, 404);
    return matches[0];
  }

  private async getJson(url: string): Promise<unknown> {
    try {
      const response = await this.fetcher(url, { headers: { accept: "application/json", "user-agent": "italian-travel-search/0.1" }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 429) throw new AppError("RATE_LIMITED", "FlixBus rate limit exceeded", 429);
      if (!response.ok) throw new AppError("PROVIDER_UNAVAILABLE", `FlixBus responded with HTTP ${response.status}`, 503);
      try { return await response.json(); } catch { throw new AppError("INCOMPATIBLE_RESPONSE", "FlixBus returned invalid JSON", 502); }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PROVIDER_UNAVAILABLE", "FlixBus request timed out or failed", 503);
    }
  }
}

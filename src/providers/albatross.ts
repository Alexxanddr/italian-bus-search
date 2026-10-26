import { AppError, type Journey, type Location, type SearchInput } from "../domain.ts";
import type { Provider } from "./provider.ts";

const timeoutMs = 5_000;
const locationCacheMs = 60 * 60_000;
const journeyCacheMs = 60_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;
type Locality = Location & { names: string[] };
type ProviderConfig = {
  id: "salemi" | "federico" | "marinobus";
  tenant: "salemi" | "autolineefederico" | "marinobus";
  baseUrl: string;
  bookingUrl: string;
};

function record(value: unknown, field: string, provider: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("INCOMPATIBLE_RESPONSE", `${provider} field ${field} is invalid`, 502);
  }
  return value as RecordValue;
}

function string(value: unknown, field: string, provider: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("INCOMPATIBLE_RESPONSE", `${provider} field ${field} is invalid`, 502);
  }
  return value;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("it").trim();
}

function parseLocalities(payload: unknown, provider: string): Locality[] {
  if (!Array.isArray(payload)) {
    throw new AppError("INCOMPATIBLE_RESPONSE", `${provider} localities are missing`, 502);
  }
  return payload.map((raw, index) => {
    const locality = record(raw, `localities[${index}]`, provider);
    const id = string(locality.id, `localities[${index}].id`, provider);
    const name = string(locality.description, `localities[${index}].description`, provider);
    const names = Array.isArray(locality.names)
      ? locality.names.flatMap((value) => {
        const translated = typeof value === "object" && value !== null ? (value as RecordValue).name : undefined;
        return typeof translated === "string" ? [translated] : [];
      })
      : [];
    return { provider, id, name, city: name, source: "live", names };
  });
}

function matches(locality: Locality, query: string, partial: boolean): boolean {
  const expected = normalize(query);
  return [locality.id, locality.name, ...locality.names].some((candidate) => {
    const actual = normalize(candidate);
    return partial ? actual.includes(expected) : actual === expected;
  });
}

function resolveLocality(localities: Locality[], value: string, kind: "origin" | "destination", provider: string): Locality {
  const locality = localities.find((candidate) => matches(candidate, value, false));
  if (locality === undefined) {
    throw new AppError("UNKNOWN_LOCATION", `Unknown ${provider} ${kind}: ${value}`, 404);
  }
  return locality;
}

function bookingSearchUrl(baseUrl: string, origin: Locality, destination: Locality, input: SearchInput): string {
  const compactDate = input.date.replaceAll("-", "").slice(2);
  if (!/^\d{6}$/.test(compactDate)) return baseUrl;
  return `${baseUrl}it/from/${encodeURIComponent(origin.name)}/${compactDate}/to/${encodeURIComponent(destination.name)}/?adulti=${input.adults}`;
}

export function parseAlbatrossJourneys(
  payload: unknown,
  provider: string,
  origin: Locality,
  destination: Locality,
  bookingUrl: string,
): Journey[] {
  if (!Array.isArray(payload)) {
    throw new AppError("INCOMPATIBLE_RESPONSE", `${provider} journeys are missing`, 502);
  }
  return payload.map((raw, index) => {
    const solution = record(raw, `journeys[${index}]`, provider);
    if (!Array.isArray(solution.trips) || solution.trips.length === 0) {
      throw new AppError("INCOMPATIBLE_RESPONSE", `${provider} journey trips are missing`, 502);
    }
    const trips = solution.trips.map((value, tripIndex) => record(value, `journeys[${index}].trips[${tripIndex}]`, provider));
    const first = trips[0];
    const last = trips.at(-1) ?? first;
    const departure = string(first.departureDateTime, "departureDateTime", provider);
    const arrival = string(last.arrivalDateTime, "arrivalDateTime", provider);
    const durationMinutes = (Date.parse(arrival) - Date.parse(departure)) / 60_000;
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0) {
      throw new AppError("INCOMPATIBLE_RESPONSE", `${provider} journey duration is invalid`, 502);
    }
    const tripIds = trips.map((trip, tripIndex) => {
      const tripData = record(trip.trip, `journeys[${index}].trips[${tripIndex}].trip`, provider);
      return string(tripData.tripId, "tripId", provider);
    });
    const amount = typeof solution.calculatedPrice === "number"
      ? solution.calculatedPrice
      : typeof solution.calculatedPrice === "string" && solution.calculatedPrice.trim() !== ""
      ? Number(solution.calculatedPrice)
      : Number.NaN;
    return {
      provider,
      tripId: tripIds.join("+"),
      origin: { id: string(first.departureStopId, "departureStopId", provider), name: origin.name },
      destination: { id: string(last.arrivalStopId, "arrivalStopId", provider), name: destination.name },
      departure,
      arrival,
      durationMinutes,
      available: trips.every((trip) => {
        const tripData = record(trip.trip, "trip", provider);
        return trip.excludedRoute !== true && trip.excludedTrip !== true && tripData.blocked !== true && tripData.canceled !== true;
      }),
      price: Number.isFinite(amount) ? { amount, currency: "EUR" } : null,
      bookingUrl,
    };
  });
}

export class AlbatrossProvider implements Provider {
  readonly id: string;
  readonly status = "available";
  readonly statusReason = "Authorized anonymous live integration with timeout and in-memory cache";
  private readonly config: ProviderConfig;
  private readonly fetcher: Fetcher;
  private localitiesCache?: { expiresAt: number; value: Locality[] };
  private fareCategoriesCache?: { expiresAt: number; value: unknown[] };
  private readonly destinationsCache = new Map<string, { expiresAt: number; value: Locality[] }>();
  private readonly journeysCache = new Map<string, { expiresAt: number; value: Journey[] }>();

  constructor(config: ProviderConfig, fetcher: Fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
    this.id = config.id;
  }

  async searchLocations(query: string): Promise<Location[]> {
    return (await this.localities()).filter((locality) => matches(locality, query, true));
  }

  async searchJourneys(input: SearchInput): Promise<Journey[]> {
    const origin = resolveLocality(await this.localities(), input.origin, "origin", this.id);
    const destination = resolveLocality(await this.destinations(origin.id), input.destination, "destination", this.id);
    const passengers = await this.passengers(input.adults, input.children);
    const parameters = new URLSearchParams({
      channel: "1",
      reservationId: "",
      inStaging: "false",
      isReturn: "false",
      excludeExternals: "false",
      partial: "false",
      caller: "",
      changeDate: "false",
      locale: "it",
      coupon: "",
      useReservedSeats: "false",
      saleGroupId: "",
    });
    const url = `${this.config.baseUrl}search/s/${origin.id}/${destination.id}/${input.date}/${input.date}?${parameters}`;
    const key = `${url}:${JSON.stringify(passengers)}`;
    const cached = this.journeysCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const journeys = parseAlbatrossJourneys(
      await this.getJson(url, { method: "POST", body: JSON.stringify(passengers) }),
      this.id,
      origin,
      destination,
      bookingSearchUrl(this.config.bookingUrl, origin, destination, input),
    );
    this.journeysCache.set(key, { expiresAt: Date.now() + journeyCacheMs, value: journeys });
    return journeys;
  }

  private async localities(): Promise<Locality[]> {
    if (this.localitiesCache !== undefined && this.localitiesCache.expiresAt > Date.now()) return this.localitiesCache.value;
    const value = parseLocalities(
      await this.getJson(`${this.config.baseUrl}locations/from?arrival=&saleGroupId=`),
      this.id,
    );
    this.localitiesCache = { expiresAt: Date.now() + locationCacheMs, value };
    return value;
  }

  private async destinations(originId: string): Promise<Locality[]> {
    const cached = this.destinationsCache.get(originId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const value = parseLocalities(
      await this.getJson(`${this.config.baseUrl}locations/to?departure=${encodeURIComponent(originId)}&saleGroupId=`),
      this.id,
    );
    this.destinationsCache.set(originId, { expiresAt: Date.now() + locationCacheMs, value });
    return value;
  }

  private async passengers(adults: number, children: number): Promise<Array<{ fId: string | null; extra: {}; subGroupId: number }>> {
    let childFareId: string | undefined;
    if (children > 0) {
      const categories = await this.fareCategories();
      const childFare = categories.find((value) => {
        if (typeof value !== "object" || value === null) return false;
        const category = value as RecordValue;
        return category.enabled === true && category.type === 0 && typeof category.description === "string"
          && /bambin|ridotto\s*0-/i.test(category.description);
      }) as RecordValue | undefined;
      childFareId = typeof childFare?.id === "string" ? childFare.id : undefined;
      if (childFareId === undefined) {
        throw new AppError("INCOMPATIBLE_RESPONSE", `${this.id} child fare category is missing`, 502);
      }
    }
    return [
      ...Array.from({ length: adults }, (_, subGroupId) => ({ fId: null, extra: {}, subGroupId })),
      ...Array.from({ length: children }, (_, index) => ({ fId: childFareId ?? null, extra: {}, subGroupId: adults + index })),
    ];
  }

  private async fareCategories(): Promise<unknown[]> {
    if (this.fareCategoriesCache !== undefined && this.fareCategoriesCache.expiresAt > Date.now()) {
      return this.fareCategoriesCache.value;
    }
    const value = await this.getJson(`${this.config.baseUrl}fareCategories`);
    if (!Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", `${this.id} fare categories are missing`, 502);
    this.fareCategoriesCache = { expiresAt: Date.now() + locationCacheMs, value };
    return value;
  }

  private async getJson(url: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        ...init,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "albatross-tenant": this.config.tenant,
          "user-agent": "italian-travel-search/0.1",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429) throw new AppError("RATE_LIMITED", `${this.id} rate limit exceeded`, 429);
      if (!response.ok) throw new AppError("PROVIDER_UNAVAILABLE", `${this.id} responded with HTTP ${response.status}`, 503);
      try {
        return await response.json();
      } catch {
        throw new AppError("INCOMPATIBLE_RESPONSE", `${this.id} returned invalid JSON`, 502);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PROVIDER_UNAVAILABLE", `${this.id} request timed out or failed`, 503);
    }
  }
}

export class SalemiProvider extends AlbatrossProvider {
  constructor(fetcher: Fetcher = fetch) {
    super({
      id: "salemi",
      tenant: "salemi",
      baseUrl: "https://api.autoservizisalemi.it/",
      bookingUrl: "https://booking.autoservizisalemi.it/",
    }, fetcher);
  }
}

export class FedericoProvider extends AlbatrossProvider {
  constructor(fetcher: Fetcher = fetch) {
    super({
      id: "federico",
      tenant: "autolineefederico",
      baseUrl: "https://api.autolineefederico.it/",
      bookingUrl: "https://booking.autolineefederico.it/",
    }, fetcher);
  }
}

export class MarinoBusProvider extends AlbatrossProvider {
  constructor(fetcher: Fetcher = fetch) {
    super({
      id: "marinobus",
      tenant: "marinobus",
      baseUrl: "https://api.marinobus.it/",
      bookingUrl: "https://booking.marinobus.it/",
    }, fetcher);
  }
}

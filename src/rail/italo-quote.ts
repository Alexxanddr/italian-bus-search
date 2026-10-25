import { randomBytes } from "node:crypto";
import { AppError, type RailSearchInput } from "../domain.ts";
import { offsetRomeDateTime } from "./netex.ts";
import type { RailQuote, RailQuoteProvider } from "./provider.ts";

const api = "https://api-biglietti.italotreno.com/api/v1/";

export class ItaloQuoteProvider implements RailQuoteProvider {
  readonly id = "italo" as const;
  readonly #fetch: typeof fetch;
  readonly #cache = new Map<string, { expires: number; value: RailQuote[] }>();
  constructor(fetcher: typeof fetch = fetch) { this.#fetch = fetcher; }

  async searchQuotes(input: RailSearchInput): Promise<RailQuote[]> {
    const key = JSON.stringify(input), cached = this.#cache.get(key);
    if (cached !== undefined && cached.expires > Date.now()) return cached.value;
    const workingId = randomBytes(12).toString("base64url").slice(0, 15);
    const token = await this.login(workingId);
    const headers = { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}`, "X-BIG-working-session-id": workingId };
    let bookingId: string | undefined;
    try {
      const stations = object(await this.request(`${api}stations/list`, { method: "POST", headers, body: JSON.stringify({ culture: "it-IT" }) }));
      const origin = stationId(input.origin, stations), destination = stationId(input.destination, stations);
      const operation = object(await this.request(`${api}booking`, { method: "POST", headers, body: JSON.stringify({ isRoundTrip: false, departureStation: origin, arrivalStation: destination, departureDate: input.date, culture: "it-IT", showPrivateOffers: false, showBestPrices: true, adultPassengers: input.adults, youngPassengers: 0, childPassengers: input.children, seniorPassengers: 0, hasPet: false, promoCode: "", promocodeAlias: "", employeeOffer: null, passengersAges: null, portalType: "B2C" }) }));
      const operationId = requiredString(operation.operationId), pollAfter = Math.min(optionalNumber(operation.pollAfter) ?? 500, 2_000);
      const deadline = Date.now() + Math.min(optionalNumber(operation.operationTimeout) ?? 20_000, 20_000);
      let result: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt += 1) {
        if (pollAfter > 0) await new Promise((resolve) => setTimeout(resolve, pollAfter));
        const response = await this.raw(`${api}booking/status/${encodeURIComponent(operationId)}`, { headers }, true);
        if (response.status === 202 || response.status >= 500) continue;
        result = object(await responseJson(response, "Italo quote"));
        break;
      }
      if (result === undefined) throw new AppError("QUOTE_UNAVAILABLE", "Italo quote operation timed out", 503);
      bookingId = optionalString(result.bookingId);
      const quotes = parseQuotes(result);
      this.#cache.set(key, { expires: Date.now() + 60_000, value: quotes });
      return quotes;
    } finally {
      await Promise.allSettled([
        ...(bookingId === undefined ? [] : [this.raw(`${api}booking/${encodeURIComponent(bookingId)}`, { method: "DELETE", headers, body: "{}" })]),
        this.raw(`${api}working-sessions`, { method: "DELETE", headers }),
      ]);
    }
  }

  private async login(workingId: string): Promise<string> {
    const response = await this.raw("https://biglietti.italotreno.com/api/login", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "X-Anonymous-User": "true" }, body: JSON.stringify({ isAnonymous: true, workingId }) });
    await responseJson(response, "Italo anonymous login");
    const token = /(?:^|,)\s*BIGSessionToken=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    if (token === undefined) throw new AppError("QUOTE_UNAVAILABLE", "Italo anonymous session token was not returned", 503);
    return token;
  }

  private async request(url: string, init: RequestInit): Promise<unknown> { return responseJson(await this.raw(url, init), "Italo quote"); }
  private async raw(url: string, init: RequestInit, allowServerError = false): Promise<Response> {
    let response: Response;
    try { response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(8_000) }); }
    catch { throw new AppError("QUOTE_UNAVAILABLE", "Italo quote request failed", 503); }
    if (response.status === 429) throw new AppError("RATE_LIMITED", "Italo quote rate limit reached", 429);
    if (!response.ok && response.status !== 202 && !(allowServerError && response.status >= 500)) throw new AppError("QUOTE_UNAVAILABLE", `Italo quote returned HTTP ${response.status}`, 503);
    return response;
  }
}

function stationId(value: string, stations: Record<string, unknown>) { const embedded = /(?:^|:)StopPlace:([^:]+)$/.exec(value)?.[1]; if (embedded !== undefined) return embedded; const name = value.replace(/\s+\([^)]*\)$/, ""); const matches = Object.entries(stations).filter(([, raw]) => { const station = object(raw); return station.isDisabled !== true && optionalString(station.name)?.localeCompare(name, undefined, { sensitivity: "accent" }) === 0; }); if (matches.length !== 1) throw new AppError(matches.length > 1 ? "AMBIGUOUS_LOCATION" : "UNKNOWN_LOCATION", `Italo location ${value} was not resolved exactly`, 400); return matches[0][0]; }
async function responseJson(response: Response, label: string): Promise<unknown> { const text = await response.text(); if (text.length > 5_000_000) throw new AppError("INCOMPATIBLE_RESPONSE", `${label} response is too large`, 502); try { return JSON.parse(text); } catch { throw new AppError("INCOMPATIBLE_RESPONSE", `Invalid ${label} response`, 502); } }
function parseQuotes(result: Record<string, unknown>): RailQuote[] { const trip = array(result.trips).map(object).find((value) => value.direction === "forward"); if (trip === undefined) return []; return array(trip.travelSolutions).flatMap((entry) => { const solution = object(entry), journeys = array(solution.journeys).map(object); if (journeys.length !== 1 || journeys[0]?.serviceProvider !== "ITALO") return []; const segments = array(journeys[0].segments).map(object); if (segments.length !== 1) return []; const segment = segments[0], fares = array(segment.fares).map(object); const priced = fares.flatMap((fare) => { const total = array(fare.paxFares).map(object).reduce((sum, pax) => sum + (optionalNumber(pax.fullPaxDiscountPrice) ?? Number.NaN), 0); return Number.isFinite(total) && (optionalNumber(fare.availableCount) ?? 0) > 0 ? [{ total, fare }] : []; }).sort((left, right) => left.total - right.total)[0]; return [{ trainNumbers: [requiredString(segment.trainNumber)], departure: offsetRomeDateTime(requiredString(segment.std)), arrival: offsetRomeDateTime(requiredString(segment.sta)), available: priced !== undefined, price: priced === undefined ? null : { amount: priced.total, currency: "EUR", fareName: optionalString(priced.fare.offerType), travelClass: optionalString(priced.fare.productClass), observedAt: new Date().toISOString(), source: "Italo booking quote" } }]; }); }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Italo quote response", 502); return value as Record<string, unknown>; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Italo quote response", 502); return value; }
function optionalString(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function requiredString(value: unknown) { const result = optionalString(value); if (result === undefined) throw new AppError("INCOMPATIBLE_RESPONSE", "Missing Italo quote field", 502); return result; }
function optionalNumber(value: unknown) { if (value === undefined || value === null || value === "") return undefined; const result = Number(value); if (!Number.isFinite(result)) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Italo quote number", 502); return result; }

import { AppError, type RailSearchInput } from "../domain.ts";
import type { RailQuote, RailQuoteProvider } from "./provider.ts";

const base = "https://www.lefrecce.it/Channels.Website.BFF.WEB/website";

export class TrenitaliaQuoteProvider implements RailQuoteProvider {
  readonly id = "trenitalia" as const;
  readonly #fetch: typeof fetch;
  readonly #cache = new Map<string, { expires: number; value: RailQuote[] }>();
  constructor(fetcher: typeof fetch = fetch) { this.#fetch = fetcher; }

  async searchQuotes(input: RailSearchInput): Promise<RailQuote[]> {
    const key = JSON.stringify(input), cached = this.#cache.get(key);
    if (cached !== undefined && cached.expires > Date.now()) return cached.value;
    const [origin, destination] = await Promise.all([this.location(input.origin), this.location(input.destination)]);
    const quotes: RailQuote[] = [], seen = new Set<string>(), observedAt = new Date().toISOString();
    for (let offset = 0; offset < 100; offset += 10) {
      const data = object(await this.request("/ticket/solutions", {
        departureLocationId: origin, arrivalLocationId: destination, departureTime: `${input.date}T00:00:00.000`, adults: input.adults, children: input.children,
        criteria: { frecceOnly: false, regionalOnly: false, intercityOnly: false, tourismOnly: false, noChanges: false, order: "DEPARTURE_DATE", offset, limit: 10 },
        advancedSearchRequest: { bestFare: false },
      }));
      const solutions = array(data.solutions);
      for (const entry of solutions) {
        const solution = object(object(entry).solution), id = optionalString(solution.id) ?? `${solution.departureTime}-${solution.arrivalTime}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const status = optionalString(solution.status), price = optionalObject(solution.price), amount = optionalNumber(price.amount), currency = normalizeCurrency(optionalString(price.currency));
        const nodes = array(solution.nodes).map(object);
        const trainNumbers = nodes.map((node) => trainNumber(object(node.train)));
        quotes.push({
          trainNumbers,
          departure: requiredString(solution.departureTime), arrival: requiredString(solution.arrivalTime), available: status === "SALEABLE",
          price: status === "SALEABLE" && amount !== undefined && currency !== undefined && price.hideAmount !== true
            ? { amount, currency, observedAt, source: "Trenitalia lefrecce quote" }
            : null,
          observedAt,
          source: "Trenitalia lefrecce booking search",
          legs: nodes.map((node, index) => ({
            trainNumber: trainNumber(object(node.train)),
            origin: { id: optionalString(node.bdoOrigin) ?? requiredString(node.origin), name: requiredString(node.origin) },
            destination: { id: optionalString(nodes[index + 1]?.bdoOrigin) ?? requiredString(node.destination), name: requiredString(node.destination) },
            departure: requiredString(node.departureTime),
            arrival: requiredString(node.arrivalTime),
          })),
        });
      }
      if (solutions.length < 10) break;
    }
    this.#cache.set(key, { expires: Date.now() + 60_000, value: quotes });
    return quotes;
  }

  private async location(name: string): Promise<number> {
    const data = array(await this.request(`/locations/search?${new URLSearchParams({ name: stripLocalizedName(name), limit: "10" })}`));
    const matches = data.map(object).filter((item) => optionalString(item.name)?.localeCompare(stripLocalizedName(name), undefined, { sensitivity: "accent" }) === 0);
    if (matches.length !== 1 || typeof matches[0]?.id !== "number") throw new AppError(matches.length > 1 ? "AMBIGUOUS_LOCATION" : "UNKNOWN_LOCATION", `Trenitalia location ${name} was not resolved exactly`, 400);
    return matches[0].id;
  }

  private async request(path: string, body?: object): Promise<unknown> {
    let response: Response;
    try { response = await this.#fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000) }); }
    catch { throw new AppError("QUOTE_UNAVAILABLE", "Trenitalia quote request failed", 503); }
    if (response.status === 429) throw new AppError("RATE_LIMITED", "Trenitalia quote rate limit reached", 429);
    if (!response.ok) throw new AppError("QUOTE_UNAVAILABLE", `Trenitalia quote returned HTTP ${response.status}`, 503);
    const text = await response.text();
    if (text.length > 2_000_000) throw new AppError("INCOMPATIBLE_RESPONSE", "Trenitalia quote response is too large", 502);
    try { return JSON.parse(text); } catch { throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Trenitalia quote response", 502); }
  }
}

function stripLocalizedName(value: string) { return value.replace(/\s+\([^)]*\)$/, ""); }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Trenitalia quote response", 502); return value as Record<string, unknown>; }
function optionalObject(value: unknown) { return value === undefined || value === null ? {} : object(value); }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Trenitalia quote response", 502); return value; }
function optionalString(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function requiredString(value: unknown) { const result = optionalString(value); if (result === undefined) throw new AppError("INCOMPATIBLE_RESPONSE", "Missing Trenitalia quote time", 502); return result; }
function optionalNumber(value: unknown) { if (value === undefined || value === null || value === "") return undefined; const result = Number(value); if (!Number.isFinite(result)) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Trenitalia quote price", 502); return result; }
function normalizeCurrency(value: string | undefined) { return value === "€" ? "EUR" : value; }
function trainNumber(train: Record<string, unknown>) { return optionalString(train.name) ?? optionalString(train.description) ?? optionalString(train.acronym) ?? "UNKNOWN"; }

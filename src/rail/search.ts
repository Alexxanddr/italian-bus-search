import { AppError, type Location, type ProviderError, type RailJourney, type RailSearchInput } from "../domain.ts";
import type { RailQuote, RailQuoteProvider, RailScheduleProvider } from "./provider.ts";

export class RailSearchService {
  readonly providers: readonly RailScheduleProvider[];
  readonly quoteProviders: readonly RailQuoteProvider[];
  constructor(providers: readonly RailScheduleProvider[], quoteProviders: readonly RailQuoteProvider[] = []) { this.providers = providers; this.quoteProviders = quoteProviders; }

  listProviders(liveProviderIds: readonly string[] = []) {
    return this.providers.map(({ id }) => ({
      id,
      capabilities: {
        schedule: true,
        price: this.quoteProviders.some((provider) => provider.id === id),
        liveStatus: liveProviderIds.includes(id),
        stationBoard: liveProviderIds.includes(id),
      },
    }));
  }

  async searchLocations(query: string, providerId?: string): Promise<{ locations: Location[]; errors: ProviderError[] }> {
    const providers = this.select(providerId);
    const settled = await Promise.all(providers.map(async (provider) => {
      try { return { locations: await provider.searchLocations(query), errors: [] as ProviderError[] }; }
      catch (error) { return { locations: [], errors: [providerError(provider.id, error)] }; }
    }));
    return { locations: settled.flatMap(({ locations }) => locations), errors: settled.flatMap(({ errors }) => errors) };
  }

  async searchJourneys(input: RailSearchInput, providerId?: string): Promise<{ journeys: RailJourney[]; errors: ProviderError[] }> {
    const providers = this.select(providerId);
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        let journeys = await provider.searchJourneys(input);
        const quoteProvider = this.quoteProviders.find(({ id }) => id === provider.id);
        const quoteErrors: ProviderError[] = [];
        if (quoteProvider !== undefined) {
          try {
            const quoteInput = journeys[0] === undefined ? input : { ...input, origin: journeys[0].origin.name, destination: journeys[0].destination.name };
            const quotes = await quoteProvider.searchQuotes(quoteInput);
            journeys = journeys.map((journey) => enrich(journey, quotes));
          }
          catch (error) { quoteErrors.push(providerError(provider.id, error, "QUOTE_UNAVAILABLE")); }
        }
        return journeys.length === 0
          ? { journeys, errors: [...quoteErrors, { provider: provider.id, code: "NO_JOURNEYS", message: "No train journeys found" } satisfies ProviderError] }
          : { journeys, errors: quoteErrors };
      } catch (error) { return { journeys: [], errors: [providerError(provider.id, error)] }; }
    }));
    return {
      journeys: settled.flatMap(({ journeys }) => journeys).sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure)),
      errors: settled.flatMap(({ errors }) => errors),
    };
  }

  private select(providerId?: string): readonly RailScheduleProvider[] {
    if (providerId === undefined) return this.providers;
    if (providerId !== "trenitalia" && providerId !== "italo") throw new AppError("INVALID_INPUT", `Unknown rail provider: ${providerId}`, 400);
    const provider = this.providers.find(({ id }) => id === providerId);
    if (provider === undefined) throw new AppError("COVERAGE_UNAVAILABLE", `${providerId} timetable dataset is not configured`, 503);
    return [provider];
  }
}

function providerError(provider: string, error: unknown, fallback: ProviderError["code"] = "PROVIDER_UNAVAILABLE"): ProviderError {
  return error instanceof AppError
    ? { provider, code: error.code, message: error.message }
    : { provider, code: fallback, message: fallback === "QUOTE_UNAVAILABLE" ? "Rail quote request failed" : "Rail provider request failed" };
}

function enrich(journey: RailJourney, quotes: RailQuote[]): RailJourney {
  const quote = quotes.find((candidate) => Date.parse(candidate.departure) === Date.parse(journey.departure) && Date.parse(candidate.arrival) === Date.parse(journey.arrival) && candidate.trainNumbers.length === journey.legs.length && candidate.trainNumbers.every((number, index) => number === journey.legs[index]?.trainNumber));
  return quote === undefined ? journey : { ...journey, available: quote.available, price: quote.price };
}

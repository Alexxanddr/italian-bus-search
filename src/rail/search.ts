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
            journeys = merge(journeys, quotes, provider.id, input.date);
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

function merge(journeys: RailJourney[], quotes: RailQuote[], provider: RailJourney["provider"], date: string): RailJourney[] {
  if (quotes.length === 0) return journeys;
  return quotes.flatMap((quote, index) => {
    const matched = journeys.find((journey) => exactMatch(journey, quote));
    if (matched !== undefined) return [{ ...matched, available: quote.available, price: quote.price }];
    if (quote.legs?.length === 0 || quote.legs === undefined) return [];
    const first = quote.legs[0]!, last = quote.legs.at(-1)!;
    return [{
      provider,
      journeyId: `${provider}:quote:${date}:${index}`,
      origin: first.origin,
      destination: last.destination,
      departure: quote.departure,
      arrival: quote.arrival,
      durationMinutes: Math.round((Date.parse(quote.arrival) - Date.parse(quote.departure)) / 60_000),
      changes: quote.legs.length - 1,
      legs: quote.legs,
      available: quote.available,
      price: quote.price,
      bookingUrl: provider === "trenitalia" ? "https://www.lefrecce.it/Channels.Website.WEB/" : "https://biglietti.italotreno.com/it/booking/ricerca",
      timetableSource: { source: quote.source, publishedAt: quote.observedAt, validFrom: date, validThrough: date },
    }];
  });
}

function exactMatch(journey: RailJourney, quote: RailQuote): boolean {
  return Date.parse(quote.departure) === Date.parse(journey.departure) && Date.parse(quote.arrival) === Date.parse(journey.arrival) && quote.trainNumbers.length === journey.legs.length && quote.trainNumbers.every((number, index) => number === journey.legs[index]?.trainNumber);
}

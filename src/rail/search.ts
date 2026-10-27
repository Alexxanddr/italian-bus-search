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
      catch (error) {
        const errors = [providerError(provider.id, error)];
        const live = this.quoteProviders.find(({ id }) => id === provider.id);
        if (live?.searchLocations !== undefined) {
          try { return { locations: await live.searchLocations(query), errors }; }
          catch (failure) { errors.push(providerError(provider.id, failure)); }
        }
        return { locations: [], errors };
      }
    }));
    return { locations: settled.flatMap(({ locations }) => locations), errors: settled.flatMap(({ errors }) => errors) };
  }

  async searchJourneys(input: RailSearchInput, providerId?: string): Promise<{ journeys: RailJourney[]; errors: ProviderError[] }> {
    const providers = this.select(providerId);
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const quoteProvider = this.quoteProviders.find(({ id }) => id === provider.id);
        const errors: ProviderError[] = [];
        let journeys: RailJourney[] = [];
        try { journeys = await provider.searchJourneys(input); }
        catch (error) {
          if (quoteProvider === undefined) throw error;
          errors.push(providerError(provider.id, error));
        }
        if (quoteProvider !== undefined) {
          try {
            const quoteInput = journeys[0] === undefined ? input : { ...input, origin: journeys[0].origin.name, destination: journeys[0].destination.name };
            const quotes = await quoteProvider.searchQuotes(quoteInput);
            journeys = merge(journeys, quotes, provider.id, input.date);
          }
          catch (error) { errors.push(providerError(provider.id, error, "QUOTE_UNAVAILABLE")); }
        }
        return journeys.length === 0
          ? { journeys, errors: [...errors, { provider: provider.id, code: "NO_JOURNEYS", message: "No train journeys found" } satisfies ProviderError] }
          : { journeys, errors };
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
  return quotes.flatMap((quote, index) => {
    if (!Number.isFinite(Date.parse(quote.departure)) || !Number.isFinite(Date.parse(quote.arrival)) || Date.parse(quote.arrival) < Date.parse(quote.departure)
      || (quote.price !== null && (!Number.isFinite(quote.price.amount) || quote.price.amount < 0))) {
      throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid rail quote timing or price", 502);
    }
    const matched = journeys.find((journey) => exactMatch(journey, quote));
    if (matched !== undefined) return [{ ...matched, available: quote.available, price: quote.price }];
    if (quote.legs?.length === 0 || quote.legs === undefined) throw new AppError("INCOMPATIBLE_RESPONSE", "Rail quote has no usable journey legs", 502);
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
  const sameStation = (left: string, right: string) => left.replace(/\s+\([^)]*\)$/, "").localeCompare(right.replace(/\s+\([^)]*\)$/, ""), undefined, { sensitivity: "base" }) === 0;
  return Date.parse(quote.departure) === Date.parse(journey.departure) && Date.parse(quote.arrival) === Date.parse(journey.arrival) && quote.trainNumbers.length === journey.legs.length && quote.trainNumbers.every((number, index) => {
    const leg = journey.legs[index], quoted = quote.legs?.[index];
    return number === leg?.trainNumber && (quote.legs === undefined || (quoted !== undefined && leg !== undefined
      && sameStation(leg.origin.name, quoted.origin.name) && sameStation(leg.destination.name, quoted.destination.name)
      && Date.parse(leg.departure) === Date.parse(quoted.departure) && Date.parse(leg.arrival) === Date.parse(quoted.arrival)));
  });
}

import { AppError, type RailJourney, type RailSearchInput } from "../domain.ts";
import type { RailProvider, RailQuoteProvider } from "./provider.ts";

export class LiveRailProvider implements RailProvider {
  readonly id: RailProvider["id"];
  readonly #source: RailQuoteProvider;
  constructor(source: RailQuoteProvider) { this.id = source.id; this.#source = source; }
  searchLocations(query: string) { return this.#source.searchLocations(query); }
  async searchJourneys(input: RailSearchInput): Promise<RailJourney[]> {
    const quotes = await this.#source.searchQuotes(input);
    return quotes.map((quote, index) => {
      if (!Number.isFinite(Date.parse(quote.departure)) || !Number.isFinite(Date.parse(quote.arrival)) || Date.parse(quote.arrival) < Date.parse(quote.departure)
        || (quote.price !== null && (!Number.isFinite(quote.price.amount) || quote.price.amount < 0))) {
        throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid rail quote timing or price", 502);
      }
      if (quote.legs === undefined || quote.legs.length === 0) throw new AppError("INCOMPATIBLE_RESPONSE", "Rail quote has no usable journey legs", 502);
      const warnings = quote.legs.filter((leg) => leg.includedInPrice === false).map((leg) => `Transfer not included in quoted price: ${leg.origin.name} → ${leg.destination.name}`);
      return {
        provider: this.id,
        journeyId: `${this.id}:quote:${input.date}:${index}`,
        origin: quote.legs[0]!.origin, destination: quote.legs.at(-1)!.destination,
        departure: quote.departure, arrival: quote.arrival,
        durationMinutes: Math.round((Date.parse(quote.arrival) - Date.parse(quote.departure)) / 60_000),
        changes: quote.legs.length - 1, legs: quote.legs,
        available: quote.available, price: quote.price,
        ...(warnings.length > 0 ? { warnings } : {}),
        bookingUrl: this.id === "trenitalia" ? "https://www.lefrecce.it/Channels.Website.WEB/" : "https://biglietti.italotreno.com/it/booking/ricerca",
        timetableSource: { source: quote.source, publishedAt: quote.observedAt, validFrom: input.date, validThrough: input.date },
      };
    });
  }
}

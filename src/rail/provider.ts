import type { Location, RailJourney, RailSearchInput, RailLiveStatus, RailPrice, RailLeg, StationBoard } from "../domain.ts";

export type RailOperator = "trenitalia" | "italo";

export interface RailScheduleProvider {
  readonly id: RailOperator;
  searchLocations(query: string): Promise<Location[]>;
  searchJourneys(input: RailSearchInput): Promise<RailJourney[]>;
}

export type RailQuote = {
  trainNumbers: string[];
  departure: string;
  arrival: string;
  available: boolean;
  price: RailPrice | null;
  observedAt: string;
  source: string;
  legs?: RailLeg[];
};

export interface RailQuoteProvider {
  readonly id: RailOperator;
  searchLocations?(query: string): Promise<Location[]>;
  searchQuotes(input: RailSearchInput): Promise<RailQuote[]>;
}

export interface RailLiveProvider {
  readonly id: RailOperator;
  getTrainStatus(input: { trainNumber: string; serviceDate: string; origin: string }): Promise<RailLiveStatus>;
  getStationBoard(input: { stationId: string; stationName: string; direction: "arrivals" | "departures" }): Promise<StationBoard>;
}

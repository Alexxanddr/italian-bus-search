export type ErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_LOCATION"
  | "NO_JOURNEYS"
  | "PROVIDER_UNAVAILABLE"
  | "INCOMPATIBLE_RESPONSE"
  | "RATE_LIMITED";

export type RailErrorCode = ErrorCode
  | "SEARCH_EXPIRED"
  | "SEARCH_TOO_LARGE"
  | "AMBIGUOUS_LOCATION"
  | "COVERAGE_UNAVAILABLE"
  | "QUOTE_UNAVAILABLE"
  | "LIVE_STATUS_UNAVAILABLE"
  | "TRAIN_NOT_FOUND";

export class AppError extends Error {
  readonly code: RailErrorCode;
  readonly status: number;

  constructor(
    code: RailErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type Location = {
  provider: string;
  id: string;
  name: string;
  city: string;
  address?: string;
  source: "live" | "historical_snapshot";
  observedAt?: string;
};

export type Journey = {
  provider: string;
  tripId: string;
  origin: { id: string; name: string; city?: string; address?: string };
  destination: { id: string; name: string; city?: string; address?: string };
  departure: string;
  arrival: string;
  durationMinutes: number;
  available: boolean;
  price: { amount: number; currency: string } | null;
  fare?: string;
  bookingUrl?: string;
};

export type SearchInput = {
  origin: string;
  destination: string;
  date: string;
  adults: number;
  children: number;
};

export type ProviderError = {
  provider: string;
  code: RailErrorCode;
  message: string;
};

export type DataSource = {
  source: string;
  publishedAt: string;
  validFrom: string;
  validThrough: string;
};

export type RailPrice = {
  amount: number;
  currency: string;
  fareName?: string;
  travelClass?: string;
  observedAt: string;
  source: string;
};

export type RailLeg = {
  trainNumber: string;
  transportMode?: "urban_transfer";
  includedInPrice?: boolean;
  description?: string;
  origin: { id: string; name: string };
  destination: { id: string; name: string };
  departure: string;
  arrival: string;
};

export type RailLiveStatus = {
  observedAt: string;
  source: string;
  freshness: "current" | "stale" | "date_unverified";
  delayMinutes?: number;
  cancelled?: boolean;
};

export type RailJourney = {
  provider: "trenitalia" | "italo";
  journeyId: string;
  origin: { id: string; name: string };
  destination: { id: string; name: string };
  departure: string;
  arrival: string;
  durationMinutes: number;
  changes: number;
  legs: RailLeg[];
  available: boolean | null;
  price: RailPrice | null;
  bookingUrl?: string;
  timetableSource: DataSource;
  liveStatus?: RailLiveStatus;
  warnings?: string[];
};

export type RailSearchInput = SearchInput;

export type StationBoard = {
  provider: "trenitalia" | "italo";
  station: { id: string; name: string };
  direction: "arrivals" | "departures";
  observedAt: string;
  source: string;
  services: Array<{ trainNumber: string; scheduledTime: string; delayMinutes?: number; cancelled?: boolean }>;
};

export type ErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_LOCATION"
  | "NO_JOURNEYS"
  | "PROVIDER_UNAVAILABLE"
  | "INCOMPATIBLE_RESPONSE"
  | "RATE_LIMITED";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(
    code: ErrorCode,
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
  origin: { id: string; name: string };
  destination: { id: string; name: string };
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
  code: ErrorCode;
  message: string;
};

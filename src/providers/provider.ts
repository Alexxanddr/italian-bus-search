import type { Journey, Location, SearchInput } from "../domain.ts";

export type ProviderStatus = "available" | "limited" | "unavailable" | "blocked";

export interface Provider {
  readonly id: string;
  readonly status: ProviderStatus;
  readonly statusReason?: string;
  searchLocations(query: string): Promise<Location[]>;
  searchJourneys(input: SearchInput): Promise<Journey[]>;
}

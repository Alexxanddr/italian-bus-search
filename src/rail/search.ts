import { AppError, type Location, type ProviderError, type RailJourney, type RailSearchInput } from "../domain.ts";
import type { RailProvider } from "./provider.ts";

export class RailSearchService {
  readonly providers: readonly RailProvider[];
  constructor(providers: readonly RailProvider[]) { this.providers = providers; }

  listProviders(liveProviderIds: readonly string[] = []) {
    return this.providers.map(({ id }) => ({ id, capabilities: {
      schedule: true, price: true,
      liveStatus: liveProviderIds.includes(id), stationBoard: liveProviderIds.includes(id),
    } }));
  }

  async searchLocations(query: string, providerId?: string): Promise<{ locations: Location[]; errors: ProviderError[] }> {
    const settled = await Promise.all(this.select(providerId).map(async (provider) => {
      try { return { locations: await provider.searchLocations(query), errors: [] as ProviderError[] }; }
      catch (error) { return { locations: [], errors: [providerError(provider.id, error)] }; }
    }));
    return { locations: settled.flatMap(({ locations }) => locations), errors: settled.flatMap(({ errors }) => errors) };
  }

  async searchJourneys(input: RailSearchInput, providerId?: string): Promise<{ journeys: RailJourney[]; errors: ProviderError[] }> {
    const settled = await Promise.all(this.select(providerId).map(async (provider) => {
      try {
        const journeys = await provider.searchJourneys(input);
        return { journeys, errors: journeys.length === 0 ? [{ provider: provider.id, code: "NO_JOURNEYS", message: "No train journeys found" } satisfies ProviderError] : [] };
      } catch (error) { return { journeys: [], errors: [providerError(provider.id, error)] }; }
    }));
    return {
      journeys: settled.flatMap(({ journeys }) => journeys).sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure)),
      errors: settled.flatMap(({ errors }) => errors),
    };
  }

  private select(providerId?: string): readonly RailProvider[] {
    if (providerId === undefined) return this.providers;
    if (providerId !== "trenitalia" && providerId !== "italo") throw new AppError("INVALID_INPUT", `Unknown rail provider: ${providerId}`, 400);
    const provider = this.providers.find(({ id }) => id === providerId);
    if (provider === undefined) throw new AppError("PROVIDER_UNAVAILABLE", `${providerId} live search is not configured`, 503);
    return [provider];
  }
}

function providerError(provider: string, error: unknown): ProviderError {
  return error instanceof AppError
    ? { provider, code: error.code, message: error.message }
    : { provider, code: "PROVIDER_UNAVAILABLE", message: "Rail provider request failed" };
}

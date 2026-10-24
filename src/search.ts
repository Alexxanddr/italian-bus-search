import { AppError, type Journey, type Location, type ProviderError, type SearchInput } from "./domain.ts";
import type { Provider } from "./providers/provider.ts";

export class SearchService {
  readonly providers: readonly Provider[];

  constructor(providers: readonly Provider[]) {
    this.providers = providers;
  }

  listProviders() {
    return this.providers.map(({ id, status, statusReason }) => ({ id, status, statusReason }));
  }

  async searchLocations(query: string, providerId?: string): Promise<{ locations: Location[]; errors: ProviderError[] }> {
    const providers = this.select(providerId);
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        return { locations: await provider.searchLocations(query), errors: [] as ProviderError[] };
      } catch (error) {
        return { locations: [], errors: [providerError(provider.id, error)] };
      }
    }));
    return {
      locations: settled.flatMap((result) => result.locations),
      errors: settled.flatMap((result) => result.errors),
    };
  }

  async searchJourneys(input: SearchInput, providerId?: string): Promise<{ journeys: Journey[]; errors: ProviderError[] }> {
    const providers = this.select(providerId);
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const journeys = await provider.searchJourneys(input);
        return journeys.length === 0
          ? { journeys, errors: [{ provider: provider.id, code: "NO_JOURNEYS", message: "No journeys found" } satisfies ProviderError] }
          : { journeys, errors: [] as ProviderError[] };
      } catch (error) {
        return { journeys: [], errors: [providerError(provider.id, error)] };
      }
    }));
    return {
      journeys: settled.flatMap((result) => result.journeys),
      errors: settled.flatMap((result) => result.errors),
    };
  }

  private select(providerId?: string): readonly Provider[] {
    if (providerId === undefined) return this.providers;
    const provider = this.providers.find(({ id }) => id === providerId);
    if (provider === undefined) throw new AppError("INVALID_INPUT", `Unknown provider: ${providerId}`, 400);
    return [provider];
  }
}

function providerError(provider: string, error: unknown): ProviderError {
  if (error instanceof AppError) return { provider, code: error.code, message: error.message };
  return { provider, code: "PROVIDER_UNAVAILABLE", message: "Provider request failed" };
}

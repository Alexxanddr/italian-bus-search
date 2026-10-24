import { FedericoProvider, MarinoBusProvider, SalemiProvider } from "./albatross.ts";
import { ItabusProvider } from "./itabus.ts";
import type { Provider } from "./provider.ts";

export function createDefaultProviders(): readonly Provider[] {
  return [
    new ItabusProvider(),
    new SalemiProvider(),
    new FedericoProvider(),
    new MarinoBusProvider(),
  ];
}

import type { RailProvider } from "./provider.ts";
import { LiveRailProvider } from "./booking.ts";
import { TrenitaliaQuoteProvider } from "./trenitalia-quote.ts";
import { ItaloQuoteProvider } from "./italo-quote.ts";

export function createDefaultRailProviders(): readonly RailProvider[] {
  return [new LiveRailProvider(new TrenitaliaQuoteProvider()), new LiveRailProvider(new ItaloQuoteProvider())];
}

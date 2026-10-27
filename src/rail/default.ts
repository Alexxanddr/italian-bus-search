import type { RailQuoteProvider, RailScheduleProvider, RailOperator } from "./provider.ts";
import { NetexScheduleProvider } from "./netex.ts";
import { TrenitaliaQuoteProvider } from "./trenitalia-quote.ts";
import { ItaloQuoteProvider } from "./italo-quote.ts";
import { resolve } from "node:path";

class FileScheduleProvider implements RailScheduleProvider {
  readonly id: RailOperator;
  readonly #path: string;
  #provider?: Promise<NetexScheduleProvider>;
  constructor(id: RailOperator, path: string) { this.id = id; this.#path = path; }
  async searchLocations(query: string) { return (await this.provider()).searchLocations(query); }
  async searchJourneys(input: Parameters<RailScheduleProvider["searchJourneys"]>[0]) { return (await this.provider()).searchJourneys(input); }
  private provider() { return this.#provider ??= NetexScheduleProvider.fromFile(this.#path, this.id).catch((error: unknown) => { this.#provider = undefined; throw error; }); }
}

export function createDefaultRailQuoteProviders(): readonly RailQuoteProvider[] { return [new TrenitaliaQuoteProvider(), new ItaloQuoteProvider()]; }

export function createDefaultRailProviders(environment: NodeJS.ProcessEnv = process.env): readonly RailScheduleProvider[] {
  return [
    new FileScheduleProvider("trenitalia", environment.TRENITALIA_NETEX_PATH ?? resolve("data/trenitalia-timetable.json.gz")),
    new FileScheduleProvider("italo", environment.ITALO_NETEX_PATH ?? resolve("data/italo-timetable.json.gz")),
  ];
}

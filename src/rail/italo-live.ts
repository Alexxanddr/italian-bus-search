import { AppError, type RailLiveStatus, type StationBoard } from "../domain.ts";
import type { RailLiveProvider } from "./provider.ts";

const base = "https://italoinviaggio.italotreno.com/api/";

export class ItaloLiveProvider implements RailLiveProvider {
  readonly id = "italo" as const;
  readonly #fetch: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.#fetch = fetcher; }

  async getTrainStatus({ trainNumber }: { trainNumber: string; serviceDate: string; origin: string }): Promise<RailLiveStatus> {
    const data = object(await this.request(`RicercaTrenoService?TrainNumber=${encodeURIComponent(trainNumber)}`));
    if (data.IsEmpty === true) throw new AppError("TRAIN_NOT_FOUND", `Italo train ${trainNumber} was not found`, 404);
    const schedule = object(data.TrainSchedule), disruption = data.TrainSchedule === null ? {} : optionalObject(schedule.Distruption);
    return { observedAt: new Date().toISOString(), source: "Italo In Viaggio", freshness: "date_unverified", delayMinutes: optionalNumber(disruption.DelayAmount) };
  }

  async getStationBoard({ stationId, stationName, direction }: { stationId: string; stationName: string; direction: "arrivals" | "departures" }): Promise<StationBoard> {
    const resolved = /(?:^|:)StopPlace:([^:]+)$/.exec(stationId)?.[1] ?? stationId;
    const query = new URLSearchParams({ CodiceStazione: resolved, NomeStazione: stationName });
    const data = object(await this.request(`RicercaStazioneService?${query}`));
    if (data.IsEmpty === true) throw new AppError("UNKNOWN_LOCATION", `Italo station ${stationName} was not found`, 404);
    const items = array(data[direction === "arrivals" ? "ListaTreniArrivo" : "ListaTreniPartenza"]);
    return { provider: "italo", station: { id: resolved, name: string(data.DescrizioneLocalita, "DescrizioneLocalita") }, direction, observedAt: new Date().toISOString(), source: "Italo In Viaggio (date unverified)", services: items.map((item) => { const row = object(item); return { trainNumber: string(row.Numero, "Numero"), scheduledTime: string(row.OraPassaggio, "OraPassaggio"), delayMinutes: optionalNumber(row.Ritardo) }; }) };
  }

  private async request(path: string): Promise<unknown> {
    let response: Response;
    try { response = await this.#fetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) }); }
    catch { throw new AppError("LIVE_STATUS_UNAVAILABLE", "Italo live request failed", 503); }
    if (response.status === 429) throw new AppError("RATE_LIMITED", "Italo live rate limit reached", 429);
    if (!response.ok) throw new AppError("LIVE_STATUS_UNAVAILABLE", `Italo live returned HTTP ${response.status}`, 503);
    const text = await response.text();
    if (text.length > 1_000_000) throw new AppError("INCOMPATIBLE_RESPONSE", "Italo live response is too large", 502);
    try { return JSON.parse(text); } catch { throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Italo live response", 502); }
  }
}

function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Italo live response", 502); return value as Record<string, unknown>; }
function optionalObject(value: unknown) { return value === undefined || value === null ? {} : object(value); }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Italo board response", 502); return value; }
function string(value: unknown, field: string) { if (typeof value !== "string" && typeof value !== "number") throw new AppError("INCOMPATIBLE_RESPONSE", `Missing Italo ${field}`, 502); return String(value); }
function optionalNumber(value: unknown) { if (value === undefined || value === null || value === "") return undefined; const number = Number(value); if (!Number.isFinite(number)) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Italo delay", 502); return Math.round(number); }

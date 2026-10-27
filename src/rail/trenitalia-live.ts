import { AppError, type RailLiveStatus, type StationBoard } from "../domain.ts";
import type { RailLiveProvider } from "./provider.ts";
import { responseText } from "../upstream.ts";

const base = "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/";

export class TrenitaliaLiveProvider implements RailLiveProvider {
  readonly id = "trenitalia" as const;
  readonly #fetch: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.#fetch = fetcher; }

  async getTrainStatus({ trainNumber, serviceDate, origin }: { trainNumber: string; serviceDate: string; origin: string }): Promise<RailLiveStatus> {
    const candidates = parseTrainCandidates(await this.text(`cercaNumeroTrenoTrenoAutocomplete/${encodeURIComponent(trainNumber)}`));
    const dated = candidates.filter((value) => localDate(value.epoch) === serviceDate);
    const candidate = dated.find((value) => origin.localeCompare(value.originCode, undefined, { sensitivity: "accent" }) === 0 || origin.localeCompare(value.originName, undefined, { sensitivity: "accent" }) === 0) ?? (dated.length === 1 ? dated[0] : undefined);
    if (candidate === undefined) throw new AppError("TRAIN_NOT_FOUND", `Trenitalia train ${trainNumber} was not found for ${serviceDate} and origin ${origin}`, 404);
    const data = object(await this.json(`andamentoTreno/${encodeURIComponent(candidate.originCode)}/${encodeURIComponent(trainNumber)}/${candidate.epoch}`));
    return { observedAt: new Date().toISOString(), source: "Trenitalia ViaggiaTreno", freshness: "current", delayMinutes: optionalNumber(data.ritardo), cancelled: data.cancellato === true ? true : undefined };
  }

  async getStationBoard({ stationId, stationName, direction }: { stationId: string; stationName: string; direction: "arrivals" | "departures" }): Promise<StationBoard> {
    const resolved = stationId.startsWith("S") ? stationId : parseStation(await this.text(`autocompletaStazione/${encodeURIComponent(stationName)}`), stationName);
    const path = direction === "arrivals" ? "arrivi" : "partenze";
    const data = array(await this.json(`${path}/${encodeURIComponent(resolved)}/${encodeURIComponent(viaggiaTrenoDate(new Date()))}`));
    return { provider: "trenitalia", station: { id: resolved, name: stationName }, direction, observedAt: new Date().toISOString(), source: "Trenitalia ViaggiaTreno", services: data.map((entry) => {
      const row = object(entry), time = optionalNumber(direction === "arrivals" ? row.orarioArrivo : row.orarioPartenza);
      if (time === undefined) throw new AppError("INCOMPATIBLE_RESPONSE", "Missing ViaggiaTreno board time", 502);
      return { trainNumber: requiredString(row.numeroTreno), scheduledTime: new Date(time).toISOString(), delayMinutes: optionalNumber(row.ritardo), cancelled: row.cancellato === true ? true : undefined };
    }) };
  }

  private async text(path: string): Promise<string> { return this.request(path); }
  private async json(path: string): Promise<unknown> { const text = await this.request(path); try { return JSON.parse(text); } catch { throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid ViaggiaTreno response", 502); } }
  private async request(path: string): Promise<string> {
    let response: Response;
    try { response = await this.#fetch(`${base}${path}`, { headers: { accept: "application/json, text/javascript, */*; q=0.01", referer: "http://www.viaggiatreno.it/infomobilita/index.jsp", "x-requested-with": "XMLHttpRequest" }, signal: AbortSignal.timeout(5_000) }); }
    catch { throw new AppError("LIVE_STATUS_UNAVAILABLE", "ViaggiaTreno request failed", 503); }
    if (response.status === 204) throw new AppError("TRAIN_NOT_FOUND", "ViaggiaTreno record was not found", 404);
    if (response.status === 429) throw new AppError("RATE_LIMITED", "ViaggiaTreno rate limit reached", 429);
    if (!response.ok) throw new AppError("LIVE_STATUS_UNAVAILABLE", `ViaggiaTreno returned HTTP ${response.status}`, 503);
    return responseText(response, "ViaggiaTreno", 2_000_000);
  }
}

function parseTrainCandidates(text: string) { return text.split(/\r?\n/).filter(Boolean).map((line) => { const [label, value] = line.split("|"); const parts = value?.split("-") ?? []; const epoch = Number(parts.at(-1)), originCode = parts.at(-2); const originName = label?.replace(/^\S+\s+-\s+/, "").replace(/\s+-\s+\d{2}\/\d{2}\/\d{2}$/, ""); if (originCode === undefined || originName === undefined || !Number.isFinite(epoch)) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid ViaggiaTreno train identity", 502); return { originCode, originName, epoch }; }); }
function parseStation(text: string, name: string) { const matches = text.split(/\r?\n/).filter(Boolean).map((line) => line.split("|")).filter(([label]) => label?.localeCompare(name, undefined, { sensitivity: "accent" }) === 0); if (matches.length !== 1 || matches[0]?.[1] === undefined) throw new AppError(matches.length > 1 ? "AMBIGUOUS_LOCATION" : "UNKNOWN_LOCATION", `ViaggiaTreno station ${name} was not resolved exactly`, 400); return matches[0][1]; }
function localDate(epoch: number) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch)); }
function viaggiaTrenoDate(date: Date) { const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", weekday: "short", month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(date); const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""; return `${get("weekday")} ${get("month")} ${get("day")} ${get("year")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName").replace(/([+-]\d\d):(\d\d)/, "$1$2")}`; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible ViaggiaTreno response", 502); return value as Record<string, unknown>; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible ViaggiaTreno board response", 502); return value; }
function optionalNumber(value: unknown) { if (value === undefined || value === null || value === "") return undefined; const result = Number(value); if (!Number.isFinite(result)) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid ViaggiaTreno number", 502); return Math.round(result); }
function requiredString(value: unknown) { if (typeof value !== "string" && typeof value !== "number") throw new AppError("INCOMPATIBLE_RESPONSE", "Missing ViaggiaTreno train number", 502); return String(value); }

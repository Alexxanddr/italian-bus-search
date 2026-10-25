import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync, createGunzip } from "node:zlib";
import { AppError, type RailJourney, type RailSearchInput } from "../domain.ts";
import type { RailOperator, RailScheduleProvider } from "./provider.ts";
import { parseNetexStream, type TimetableCache } from "./netex-stream.ts";

const maxDownloadBytes = 64 * 1024 * 1024;

export class NetexScheduleProvider implements RailScheduleProvider {
  readonly id: RailOperator;
  readonly #dataset: TimetableCache;
  private constructor(dataset: TimetableCache) { this.id = dataset.operator; this.#dataset = dataset; }
  static async fromFile(path: string, operator: RailOperator) {
    let value: unknown;
    try { value = JSON.parse(gunzipSync(await readFile(path)).toString("utf8")); }
    catch { throw new AppError("PROVIDER_UNAVAILABLE", `${operator} timetable cache is missing or invalid`, 503); }
    return new NetexScheduleProvider(validateCache(value, operator));
  }
  async searchLocations(query: string) {
    const needle = normalize(query);
    return this.#dataset.stops.filter(({ id, name }) => normalize(id).includes(needle) || normalize(name).includes(needle)).map(({ id, name }) => ({ provider: this.id, id, name, city: name, source: "historical_snapshot" as const, observedAt: this.#dataset.source.publishedAt }));
  }
  async searchJourneys(input: RailSearchInput): Promise<RailJourney[]> {
    if (input.date < this.#dataset.source.validFrom || input.date > this.#dataset.source.validThrough) throw new AppError("COVERAGE_UNAVAILABLE", `${this.id} timetable does not cover ${input.date}`, 503);
    const origin = resolveStop(this.#dataset, input.origin), destination = resolveStop(this.#dataset, input.destination);
    return this.#dataset.services.flatMap((service) => {
      if (!service.dates.includes(input.date)) return [];
      const from = service.stops.findIndex(({ ref, boarding }) => ref === origin.id && boarding);
      const to = service.stops.findIndex(({ ref, alighting }, index) => index > from && ref === destination.id && alighting);
      const departure = service.stops[from]?.departure, arrival = service.stops[to]?.arrival;
      if (from < 0 || to < 0 || departure === undefined || arrival === undefined) return [];
      const departureIso = localDateTime(input.date, departure), arrivalIso = localDateTime(input.date, arrival);
      return [{ provider: this.id, journeyId: `${this.id}:${service.id}:${input.date}:${origin.id}:${destination.id}`, origin, destination, departure: departureIso, arrival: arrivalIso, durationMinutes: Math.round((Date.parse(arrivalIso) - Date.parse(departureIso)) / 60_000), changes: 0, legs: [{ trainNumber: service.trainNumber, origin, destination, departure: departureIso, arrival: arrivalIso }], available: null, price: null, bookingUrl: this.id === "trenitalia" ? "https://www.lefrecce.it/Channels.Website.WEB/" : "https://biglietti.italotreno.com/it/booking/ricerca", timetableSource: this.#dataset.source } satisfies RailJourney];
    }).sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure));
  }
}

export async function updateNetexDataset(url: URL, destination: string, operator: RailOperator, fetcher: typeof fetch = fetch): Promise<TimetableCache> {
  official(url);
  const response = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  if (response.url) official(new URL(response.url));
  if (!response.ok) throw new AppError("PROVIDER_UNAVAILABLE", `NeTEx download failed with HTTP ${response.status}`, 503);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxDownloadBytes) throw new AppError("INCOMPATIBLE_RESPONSE", "NeTEx download is too large", 502);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxDownloadBytes) throw new AppError("INCOMPATIBLE_RESPONSE", "NeTEx download is too large", 502);
  const source = Readable.from(body);
  const dataset = await parseNetexStream(body[0] === 0x1f && body[1] === 0x8b ? source.pipe(createGunzip()) : source, operator);
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, gzipSync(JSON.stringify(dataset), { level: 9 }), { mode: 0o600 });
  try { await rename(temporary, destination); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  return dataset;
}

function official(url: URL) { if (url.protocol !== "https:" || url.hostname !== "www.cciss.it" || url.port || url.username || url.password) throw new AppError("INVALID_INPUT", "NeTEx source must be official CCISS HTTPS", 400); }
function validateCache(value: unknown, operator: RailOperator): TimetableCache { if (typeof value !== "object" || value === null || (value as TimetableCache).operator !== operator || !Array.isArray((value as TimetableCache).stops) || !Array.isArray((value as TimetableCache).services)) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid timetable cache", 502); return value as TimetableCache; }
function resolveStop(dataset: TimetableCache, value: string) { const needle = normalize(value); const matches = dataset.stops.filter(({ id, name }) => normalize(id) === needle || normalize(name) === needle || canonical(name) === needle); if (matches.length === 0) throw new AppError("UNKNOWN_LOCATION", `Unknown rail station: ${value}`, 400); if (matches.length > 1) throw new AppError("AMBIGUOUS_LOCATION", `Ambiguous rail station: ${value}`, 400); return matches[0]!; }
function normalize(value: string) { return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase(); }
function canonical(value: string) { return normalize(value.replace(/\s+\([^)]*\)$/, "")); }
function localDateTime(date: string, seconds: number) { const day = Math.floor(seconds / 86400), clock = seconds % 86400, base = new Date(`${date}T00:00:00Z`); base.setUTCDate(base.getUTCDate() + day); return offsetRomeDateTime(`${base.toISOString().slice(0, 10)}T${String(Math.floor(clock / 3600)).padStart(2, "0")}:${String(Math.floor(clock % 3600 / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`); }
export function offsetRomeDateTime(local: string) { const offsets = [120, 60].filter((offset) => formatRome(Date.parse(`${local}Z`) - offset * 60_000) === local); if (offsets.length !== 1) throw new AppError("INCOMPATIBLE_RESPONSE", `Ambiguous or nonexistent Europe/Rome time: ${local}`, 502); return `${local}${offsets[0] === 120 ? "+02:00" : "+01:00"}`; }
const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function formatRome(epoch: number) { return formatter.format(new Date(epoch)).replace(" ", "T"); }

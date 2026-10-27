import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync, createGunzip } from "node:zlib";
import { AppError, type RailJourney, type RailSearchInput } from "../domain.ts";
import type { RailOperator, RailScheduleProvider } from "./provider.ts";
import { parseNetexStream, type TimetableCache } from "./netex-stream.ts";
import { responseBytes } from "../upstream.ts";

const maxDownloadBytes = 64 * 1024 * 1024;

export class NetexScheduleProvider implements RailScheduleProvider {
  readonly id: RailOperator;
  readonly #dataset: TimetableCache;
  private constructor(dataset: TimetableCache) { this.id = dataset.operator; this.#dataset = dataset; }
  static async fromFile(path: string, operator: RailOperator) {
    let value: unknown;
    try { value = JSON.parse(gunzipSync(await readFile(path), { maxOutputLength: 128 * 1024 * 1024 }).toString("utf8")); }
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
    const active = this.servicesOnDate(input.date);
    const direct = active.flatMap((service) => {
      const from = service.stops.findIndex(({ ref, boarding }) => ref === origin.id && boarding);
      const to = service.stops.findIndex(({ ref, alighting }, index) => index > from && ref === destination.id && alighting);
      const departure = service.stops[from]?.departure, arrival = service.stops[to]?.arrival;
      if (from < 0 || to < 0 || departure === undefined || arrival === undefined || departure < 0 || departure >= 86400) return [];
      const departureIso = localDateTime(input.date, departure), arrivalIso = localDateTime(input.date, arrival);
      return [{ provider: this.id, journeyId: `${this.id}:${service.id}:${input.date}:${origin.id}:${destination.id}`, origin, destination, departure: departureIso, arrival: arrivalIso, durationMinutes: Math.round((Date.parse(arrivalIso) - Date.parse(departureIso)) / 60_000), changes: 0, legs: [{ trainNumber: service.trainNumber, origin, destination, departure: departureIso, arrival: arrivalIso }], available: null, price: null, bookingUrl: this.id === "trenitalia" ? "https://www.lefrecce.it/Channels.Website.WEB/" : "https://biglietti.italotreno.com/it/booking/ricerca", timetableSource: this.#dataset.source } satisfies RailJourney];
    });
    return [...direct, ...this.oneChangeJourneys(input, origin, destination, active)].sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure));
  }

  private servicesOnDate(date: string): TimetableCache["services"] {
    return this.#dataset.services.flatMap((service) => {
      const maximumDay = Math.floor(Math.max(...service.stops.map((stop) => Math.max(stop.arrival ?? 0, stop.departure ?? 0))) / 86400);
      const active = [];
      for (let day = -maximumDay; day <= 1; day += 1) {
        const serviceDate = new Date(`${date}T00:00:00Z`);
        serviceDate.setUTCDate(serviceDate.getUTCDate() + day);
        if (service.dates.includes(serviceDate.toISOString().slice(0, 10))) active.push({ ...service, stops: service.stops.map((stop) => ({ ...stop, arrival: stop.arrival === undefined ? undefined : stop.arrival + day * 86400, departure: stop.departure === undefined ? undefined : stop.departure + day * 86400 })) });
      }
      return active;
    });
  }

  private oneChangeJourneys(input: RailSearchInput, origin: TimetableCache["stops"][number], destination: TimetableCache["stops"][number], active: TimetableCache["services"]): RailJourney[] {
    const stopById = new Map(this.#dataset.stops.map((stop) => [stop.id, stop]));
    const onward = new Map<string, Array<{ service: typeof active[number]; from: number; to: number; departure: number; arrival: number }>>();
    for (const service of active) {
      const to = service.stops.findIndex(({ ref, alighting }) => ref === destination.id && alighting);
      if (to < 0 || service.stops[to]?.arrival === undefined) continue;
      for (let from = 0; from < to; from += 1) {
        const stop = service.stops[from];
        if (stop?.boarding && stop.departure !== undefined) {
          const candidates = onward.get(stop.ref) ?? [];
          candidates.push({ service, from, to, departure: stop.departure, arrival: service.stops[to]!.arrival! });
          onward.set(stop.ref, candidates);
        }
      }
    }
    const journeys = new Map<string, { wait: number; journey: RailJourney }>();
    for (const service of active) {
      const from = service.stops.findIndex(({ ref, boarding }) => ref === origin.id && boarding);
      if (from < 0) continue;
      for (let to = from + 1; to < service.stops.length; to += 1) {
        const transferPoint = service.stops[to];
        if (!transferPoint?.alighting || transferPoint.arrival === undefined || transferPoint.ref === destination.id) continue;
        for (const second of onward.get(transferPoint.ref) ?? []) {
          const wait = second.departure - transferPoint.arrival;
          if (second.service.id === service.id || wait < 300 || wait > 21_600) continue;
          const departure = service.stops[from]?.departure;
          const transfer = stopById.get(transferPoint.ref);
          if (departure === undefined || departure < 0 || departure >= 86400 || transfer === undefined) continue;
          const departureIso = localDateTime(input.date, departure), transferArrival = localDateTime(input.date, transferPoint.arrival), transferDeparture = localDateTime(input.date, second.departure), arrivalIso = localDateTime(input.date, second.arrival);
          const key = `${service.id}:${second.service.id}`;
          const journey: RailJourney = { provider: this.id, journeyId: `${this.id}:${key}:${input.date}:${origin.id}:${destination.id}`, origin, destination, departure: departureIso, arrival: arrivalIso, durationMinutes: Math.round((Date.parse(arrivalIso) - Date.parse(departureIso)) / 60_000), changes: 1, legs: [{ trainNumber: service.trainNumber, origin, destination: transfer, departure: departureIso, arrival: transferArrival }, { trainNumber: second.service.trainNumber, origin: transfer, destination, departure: transferDeparture, arrival: arrivalIso }], available: null, price: null, bookingUrl: this.id === "trenitalia" ? "https://www.lefrecce.it/Channels.Website.WEB/" : "https://biglietti.italotreno.com/it/booking/ricerca", timetableSource: this.#dataset.source };
          if ((journeys.get(key)?.wait ?? Infinity) > wait) journeys.set(key, { wait, journey });
        }
      }
    }
    return [...journeys.values()].map(({ journey }) => journey);
  }
}

export async function updateNetexDataset(url: URL, destination: string, operator: RailOperator, fetcher: typeof fetch = fetch): Promise<TimetableCache> {
  official(url);
  let response: Response;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; ; redirects += 1) {
    official(url);
    response = await fetcher(url, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (redirects >= 5 || location === null) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid NeTEx redirect", 502);
    url = new URL(location, url);
  }
  if (!response.ok) throw new AppError("PROVIDER_UNAVAILABLE", `NeTEx download failed with HTTP ${response.status}`, 503);
  const body = await responseBytes(response, "NeTEx download", maxDownloadBytes);
  const source = Readable.from(body);
  const dataset = validateCache(await parseNetexStream(body[0] === 0x1f && body[1] === 0x8b ? source.pipe(createGunzip()) : source, operator), operator);
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, gzipSync(JSON.stringify(dataset), { level: 9 }), { mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  return dataset;
}

function official(url: URL) { if (url.protocol !== "https:" || url.hostname !== "www.cciss.it" || url.port || url.username || url.password) throw new AppError("INVALID_INPUT", "NeTEx source must be official CCISS HTTPS", 400); }
function validateCache(value: unknown, operator: RailOperator): TimetableCache {
  const cache = value as TimetableCache | null;
  const invalid = () => { throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid timetable cache", 502); };
  if (cache === null || typeof cache !== "object" || cache.operator !== operator || !Array.isArray(cache.stops) || !Array.isArray(cache.services)) invalid();
  const source = cache!.source;
  if (!source || typeof source.source !== "string" || !Number.isFinite(Date.parse(source.publishedAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(source.validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(source.validThrough) || source.validFrom > source.validThrough) invalid();
  const ids = new Set<string>();
  for (const stop of cache!.stops) {
    if (!stop || typeof stop.id !== "string" || typeof stop.name !== "string" || ids.has(stop.id)) invalid();
    ids.add(stop.id);
  }
  for (const service of cache!.services) {
    if (!service || typeof service.id !== "string" || typeof service.trainNumber !== "string" || !Array.isArray(service.dates) || !service.dates.every((date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) || !Array.isArray(service.stops)) invalid();
    let prior = 0;
    for (const stop of service.stops) {
      if (!stop || !ids.has(stop.ref) || typeof stop.boarding !== "boolean" || typeof stop.alighting !== "boolean") invalid();
      for (const time of [stop.arrival, stop.departure]) {
        if (time === undefined) continue;
        if (!Number.isInteger(time) || time < prior || time > 7 * 86400) invalid();
        prior = time;
      }
    }
  }
  return cache!;
}
function resolveStop(dataset: TimetableCache, value: string) { const needle = normalize(value); const matches = dataset.stops.filter(({ id, name }) => normalize(id) === needle || normalize(name) === needle || canonical(name) === needle); if (matches.length === 0) throw new AppError("UNKNOWN_LOCATION", `Unknown rail station: ${value}`, 400); if (matches.length > 1) throw new AppError("AMBIGUOUS_LOCATION", `Ambiguous rail station: ${value}`, 400); return matches[0]!; }
function normalize(value: string) { return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase(); }
function canonical(value: string) { return normalize(value.replace(/\s+\([^)]*\)$/, "")); }
function localDateTime(date: string, seconds: number) { const day = Math.floor(seconds / 86400), clock = seconds % 86400, base = new Date(`${date}T00:00:00Z`); base.setUTCDate(base.getUTCDate() + day); return offsetRomeDateTime(`${base.toISOString().slice(0, 10)}T${String(Math.floor(clock / 3600)).padStart(2, "0")}:${String(Math.floor(clock % 3600 / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`); }
export function offsetRomeDateTime(local: string) { const offsets = [120, 60].filter((offset) => formatRome(Date.parse(`${local}Z`) - offset * 60_000) === local); if (offsets.length !== 1) throw new AppError("INCOMPATIBLE_RESPONSE", `Ambiguous or nonexistent Europe/Rome time: ${local}`, 502); return `${local}${offsets[0] === 120 ? "+02:00" : "+01:00"}`; }
const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function formatRome(epoch: number) { return formatter.format(new Date(epoch)).replace(" ", "T"); }

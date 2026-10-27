import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { NetexScheduleProvider, updateNetexDataset } from "../src/rail/netex.ts";
import { parseNetexStream, type TimetableCache } from "../src/rail/netex-stream.ts";
import { RailSearchService } from "../src/rail/search.ts";
import type { RailQuoteProvider } from "../src/rail/provider.ts";
import { createDefaultRailProviders } from "../src/rail/default.ts";

const input = { origin: "Roma Termini", destination: "Milano Centrale", date: "2027-01-15", adults: 1, children: 0 };
const source = { source: "Italian NAP NeTEx", publishedAt: "2026-10-25T08:00:00Z", validFrom: "2026-10-01", validThrough: "2030-12-31" };

async function provider(operator: "trenitalia" | "italo", departure = 8 * 3600, arrival = 11 * 3600 + 10 * 60) {
  const cache: TimetableCache = { operator, source, stops: [{ id: `${operator}-ROM`, name: "Roma Termini" }, { id: `${operator}-MIL`, name: "Milano Centrale" }], services: [{ id: `${operator}-1`, trainNumber: operator === "italo" ? "9920" : "FR 1000", dates: ["2027-01-15", "2027-07-15"], stops: [{ ref: `${operator}-ROM`, departure, boarding: true, alighting: false }, { ref: `${operator}-MIL`, arrival, boarding: false, alighting: true }] }] };
  const path = `/tmp/${operator}-${process.pid}-${departure}.json.gz`;
  await writeFile(path, gzipSync(JSON.stringify(cache)));
  return NetexScheduleProvider.fromFile(path, operator);
}

test("searches both operators, overnight services, source metadata and nullable quote data", async () => {
  const result = await new RailSearchService([await provider("trenitalia", 84600, 96300), await provider("italo")]).searchJourneys(input);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.journeys.map(({ provider }) => provider), ["italo", "trenitalia"]);
  assert.equal(result.journeys[1]?.arrival, "2027-01-16T02:45:00+01:00");
  assert.equal(result.journeys[1]?.durationMinutes, 195);
  assert.equal(result.journeys[0]?.price, null);
  assert.equal(result.journeys[0]?.available, null);
});

test("fails closed outside coverage and on incompatible updates", async () => {
  const italo = await provider("italo");
  await assert.rejects(italo.searchJourneys({ ...input, date: "2031-01-01" }), (error: unknown) => error instanceof AppError && error.code === "COVERAGE_UNAVAILABLE");
  await assert.rejects(updateNetexDataset(new URL("https://www.cciss.it/netex.xml"), "/tmp/not-written.json.gz", "italo", async () => new Response("<bad>", { status: 200 })), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
});

test("returns provider-scoped partial results", async () => {
  const failing = { id: "trenitalia" as const, searchLocations: async () => { throw new AppError("PROVIDER_UNAVAILABLE", "missing", 503); }, searchJourneys: async () => { throw new AppError("PROVIDER_UNAVAILABLE", "missing", 503); } };
  const result = await new RailSearchService([await provider("italo"), failing]).searchJourneys(input);
  assert.equal(result.journeys.length, 1);
  assert.deepEqual(result.errors, [{ provider: "trenitalia", code: "PROVIDER_UNAVAILABLE", message: "missing" }]);
});

test("enriches exact timetable identities and preserves schedules when quote fails", async () => {
  const schedule = await provider("trenitalia");
  let quotedInput = input;
  const quote: RailQuoteProvider = { id: "trenitalia", searchQuotes: async (value) => { quotedInput = value; return [{ trainNumbers: ["FR 1000"], departure: "2027-01-15T08:00:00+01:00", arrival: "2027-01-15T11:10:00+01:00", available: true, price: { amount: 44.9, currency: "EUR", observedAt: "2026-10-25T10:00:00Z", source: "synthetic" }, observedAt: "2026-10-25T10:00:00Z", source: "synthetic" }]; } };
  const enriched = await new RailSearchService([schedule], [quote]).searchJourneys({ ...input, origin: "trenitalia-ROM", destination: "trenitalia-MIL" });
  assert.equal(enriched.journeys[0]?.price?.amount, 44.9);
  assert.equal(quotedInput.origin, "Roma Termini");
  assert.equal(quotedInput.destination, "Milano Centrale");
  const partial = await new RailSearchService([schedule], [{ id: "trenitalia", searchQuotes: async () => { throw new AppError("QUOTE_UNAVAILABLE", "down", 503); } }]).searchJourneys(input);
  assert.equal(partial.journeys.length, 1);
  assert.equal(partial.journeys[0]?.price, null);
  assert.equal(partial.errors[0]?.code, "QUOTE_UNAVAILABLE");
});

test("uses successful booking results as the authoritative priced journey set", async () => {
  const schedule = await provider("trenitalia");
  const observedAt = "2026-10-25T10:00:00Z";
  const quote: RailQuoteProvider = { id: "trenitalia", searchQuotes: async () => [{
    trainNumbers: ["FR 2000", "R 3000"], departure: "2027-01-15T09:00:00+01:00", arrival: "2027-01-15T13:00:00+01:00", available: true,
    price: { amount: 39.9, currency: "EUR", observedAt, source: "synthetic" }, observedAt, source: "synthetic booking search",
    legs: [
      { trainNumber: "FR 2000", origin: { id: "ROM", name: "Roma Termini" }, destination: { id: "BOL", name: "Bologna Centrale" }, departure: "2027-01-15T09:00:00+01:00", arrival: "2027-01-15T11:00:00+01:00" },
      { trainNumber: "R 3000", origin: { id: "BOL", name: "Bologna Centrale" }, destination: { id: "MIL", name: "Milano Centrale" }, departure: "2027-01-15T11:20:00+01:00", arrival: "2027-01-15T13:00:00+01:00" },
    ],
  }] };
  const result = await new RailSearchService([schedule], [quote]).searchJourneys(input);
  assert.equal(result.journeys.length, 1);
  assert.equal(result.journeys[0]?.price?.amount, 39.9);
  assert.equal(result.journeys[0]?.changes, 1);
  assert.deepEqual(result.journeys[0]?.legs.map(({ trainNumber }) => trainNumber), ["FR 2000", "R 3000"]);
  assert.equal(result.journeys[0]?.timetableSource.source, "synthetic booking search");
});

test("keeps live searches independent of a missing timetable and respects empty quotes", async () => {
  const schedule = await provider("trenitalia");
  const baseline = await schedule.searchJourneys(input);
  const journey = baseline[0]!;
  const quote: RailQuoteProvider = { id: "trenitalia", searchQuotes: async () => [{
    trainNumbers: journey.legs.map(({ trainNumber }) => trainNumber), departure: journey.departure, arrival: journey.arrival,
    available: true, price: null, observedAt: source.publishedAt, source: "synthetic", legs: journey.legs,
  }] };
  quote.searchLocations = async () => [{ provider: "trenitalia", id: "ROM", name: "Roma Termini", city: "Roma", source: "live" }];
  const missing = { ...schedule, id: "trenitalia" as const, searchLocations: async () => [], searchJourneys: async () => { throw new AppError("COVERAGE_UNAVAILABLE", "expired", 503); } };
  const live = await new RailSearchService([missing], [quote]).searchJourneys(input);
  assert.equal(live.journeys.length, 1);
  assert.equal(live.errors[0]?.code, "COVERAGE_UNAVAILABLE");
  const missingLocations = { ...missing, searchLocations: async () => { throw new AppError("PROVIDER_UNAVAILABLE", "missing", 503); } };
  const locations = await new RailSearchService([missingLocations], [quote]).searchLocations("Roma");
  assert.equal(locations.locations[0]?.source, "live");
  assert.equal(locations.errors[0]?.code, "PROVIDER_UNAVAILABLE");
  const empty = await new RailSearchService([schedule], [{ id: "trenitalia", searchQuotes: async () => [] }]).searchJourneys(input);
  assert.equal(empty.journeys.length, 0);
  assert.equal(empty.errors[0]?.code, "NO_JOURNEYS");
});

test("uses Europe/Rome daylight-saving offsets", async () => {
  const journey = (await (await provider("italo")).searchJourneys({ ...input, date: "2027-07-15" }))[0];
  assert.match(journey?.departure ?? "", /\+02:00$/);
});

test("accepts operator-localized station names through their shared name", async () => {
  const path = `/tmp/italo-localized-${process.pid}.json.gz`;
  const cache: TimetableCache = { operator: "italo", source, stops: [{ id: "italo-ROM", name: "Roma Termini (Rome)" }, { id: "italo-MIL", name: "Milano Centrale (Milan)" }], services: [{ id: "1", trainNumber: "9920", dates: [input.date], stops: [{ ref: "italo-ROM", departure: 28800, boarding: true, alighting: false }, { ref: "italo-MIL", arrival: 39600, boarding: false, alighting: true }] }] };
  await writeFile(path, gzipSync(JSON.stringify(cache)));
  assert.equal((await (await NetexScheduleProvider.fromFile(path, "italo")).searchJourneys(input)).length, 1);
});

test("builds one-change journeys when no direct train serves the destination", async () => {
  const path = `/tmp/trenitalia-change-${process.pid}.json.gz`;
  const cache: TimetableCache = { operator: "trenitalia", source, stops: [{ id: "ROM", name: "Roma Termini" }, { id: "PAO", name: "Paola" }, { id: "COS", name: "Cosenza" }], services: [{ id: "fast", trainNumber: "FR 1", dates: [input.date], stops: [{ ref: "ROM", departure: 28_800, boarding: true, alighting: false }, { ref: "PAO", arrival: 39_600, boarding: false, alighting: true }] }, { id: "regional", trainNumber: "R 2", dates: [input.date], stops: [{ ref: "PAO", departure: 40_200, boarding: true, alighting: false }, { ref: "COS", arrival: 42_000, boarding: false, alighting: true }] }] };
  await writeFile(path, gzipSync(JSON.stringify(cache)));
  const journeys = await (await NetexScheduleProvider.fromFile(path, "trenitalia")).searchJourneys({ ...input, origin: "Roma Termini", destination: "Cosenza" });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0]?.changes, 1);
  assert.deepEqual(journeys[0]?.legs.map(({ trainNumber }) => trainNumber), ["FR 1", "R 2"]);
  assert.equal(journeys[0]?.legs[0]?.destination.name, "Paola");
});

test("stream parser rejects non-NeTEx input", async () => {
  await assert.rejects(parseNetexStream(Readable.from("<bad/>"), "italo"), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
});

test("searches by boarding date and connects services across midnight", async () => {
  const path = `/tmp/night-services-${process.pid}.json.gz`;
  const cache: TimetableCache = { operator: "italo", source, stops: [{ id: "A", name: "Roma" }, { id: "B", name: "Bologna" }, { id: "C", name: "Milano" }], services: [
    { id: "night", trainNumber: "1", dates: ["2027-01-14"], stops: [{ ref: "A", departure: 82_800, boarding: true, alighting: false }, { ref: "B", arrival: 88_200, departure: 88_800, boarding: true, alighting: true }, { ref: "C", arrival: 93_600, boarding: false, alighting: true }] },
    { id: "late", trainNumber: "2", dates: [input.date], stops: [{ ref: "A", departure: 82_800, boarding: true, alighting: false }, { ref: "B", arrival: 88_200, boarding: false, alighting: true }] },
    { id: "early", trainNumber: "3", dates: ["2027-01-16"], stops: [{ ref: "B", departure: 88_800 - 86400, boarding: true, alighting: false }, { ref: "C", arrival: 93_600 - 86400, boarding: false, alighting: true }] },
  ] };
  await writeFile(path, gzipSync(JSON.stringify(cache)));
  const schedule = await NetexScheduleProvider.fromFile(path, "italo");
  const early = await schedule.searchJourneys({ ...input, origin: "Bologna", destination: "Milano" });
  assert.equal(early[0]?.departure, "2027-01-15T00:40:00+01:00");
  const connection = await schedule.searchJourneys({ ...input, origin: "Roma", destination: "Milano" });
  assert.equal(connection.length, 1);
  assert.equal(connection[0]?.arrival, "2027-01-16T02:00:00+01:00");
  assert.equal(connection[0]?.changes, 1);
});

test("rejects redirects before contacting a non-CCISS host", async () => {
  const urls: string[] = [];
  await assert.rejects(updateNetexDataset(new URL("https://www.cciss.it/start"), "/tmp/not-written.json.gz", "italo", async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 302, headers: { location: "https://other.example/feed" } });
  }), (error: unknown) => error instanceof AppError && error.code === "INVALID_INPUT");
  assert.equal(urls.length, 1);
});

test("recovers after the initially missing timetable file is installed", async () => {
  const path = `/tmp/recovered-cache-${process.pid}-${Date.now()}.json.gz`;
  const [schedule] = createDefaultRailProviders({ TRENITALIA_NETEX_PATH: path });
  await assert.rejects(schedule!.searchLocations("Roma"));
  await writeFile(path, gzipSync(JSON.stringify({ operator: "trenitalia", source, stops: [{ id: "ROM", name: "Roma" }], services: [] })));
  assert.equal((await schedule!.searchLocations("Roma")).length, 1);
});

test("stream parser resolves Italian-profile references, UIC calendars and exceptions", async () => {
  const xml = `<PublicationDelivery><PublicationTimestamp>2026-10-25T08:00:00Z</PublicationTimestamp><CompositeFrame><ValidBetween><FromDate>2027-01-01</FromDate><ToDate>2027-01-02</ToDate></ValidBetween></CompositeFrame>
  <StopPlace id="ROM"><Name>Roma Termini</Name></StopPlace><StopPlace id="MIL"><Name>Milano Centrale</Name></StopPlace>
  <PassengerStopAssignment><ScheduledStopPointRef ref="P1"/><StopPlaceRef ref="ROM"/></PassengerStopAssignment><PassengerStopAssignment><ScheduledStopPointRef ref="P2"/><StopPlaceRef ref="MIL"/></PassengerStopAssignment>
  <Line id="L1"><PublicCode>9920</PublicCode></Line><ServiceJourneyPattern id="JP"><RouteView><LineRef ref="L1"/></RouteView><StopPointInJourneyPattern id="J1" order="1"><ScheduledStopPointRef ref="P1"/></StopPointInJourneyPattern><StopPointInJourneyPattern id="J2" order="2"><ScheduledStopPointRef ref="P2"/></StopPointInJourneyPattern></ServiceJourneyPattern>
  <UicOperatingPeriod id="OP"><FromDate>2027-01-01</FromDate><ToDate>2027-01-02</ToDate><ValidDayBits>11</ValidDayBits></UicOperatingPeriod><DayTypeAssignment><DayTypeRef ref="D1"/><OperatingPeriodRef ref="OP"/></DayTypeAssignment><DayTypeAssignment><DayTypeRef ref="D1"/><Date>2027-01-02</Date><IsAvailable>false</IsAvailable></DayTypeAssignment>
  <ServiceJourney id="S1"><dayTypes><DayTypeRef ref="D1"/></dayTypes><ServiceJourneyPatternRef ref="JP"/><TimetabledPassingTime><StopPointInJourneyPatternRef ref="J1"/><DepartureTime>23:30:00</DepartureTime></TimetabledPassingTime><TimetabledPassingTime><StopPointInJourneyPatternRef ref="J2"/><ArrivalTime>02:45:00</ArrivalTime><ArrivalDayOffset>1</ArrivalDayOffset></TimetabledPassingTime></ServiceJourney></PublicationDelivery>`;
  const cache = await parseNetexStream(Readable.from(xml), "italo");
  assert.deepEqual(cache.services[0]?.dates, ["2027-01-01"]);
  assert.equal(cache.services[0]?.trainNumber, "9920");
  assert.equal(cache.services[0]?.stops[1]?.arrival, 96_300);
  const bytes = Buffer.from(xml.replace("Roma Termini", "Città"));
  const split = await parseNetexStream(Readable.from([...bytes].map((byte) => Buffer.from([byte]))), "italo");
  assert.equal(split.stops[0]?.name, "Città");
});

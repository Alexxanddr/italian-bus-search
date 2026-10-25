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
  const quote: RailQuoteProvider = { id: "trenitalia", searchQuotes: async () => [{ trainNumbers: ["FR 1000"], departure: "2027-01-15T08:00:00+01:00", arrival: "2027-01-15T11:10:00+01:00", available: true, price: { amount: 44.9, currency: "EUR", observedAt: "2026-10-25T10:00:00Z", source: "synthetic" } }] };
  const enriched = await new RailSearchService([schedule], [quote]).searchJourneys(input);
  assert.equal(enriched.journeys[0]?.price?.amount, 44.9);
  const partial = await new RailSearchService([schedule], [{ id: "trenitalia", searchQuotes: async () => { throw new AppError("QUOTE_UNAVAILABLE", "down", 503); } }]).searchJourneys(input);
  assert.equal(partial.journeys.length, 1);
  assert.equal(partial.journeys[0]?.price, null);
  assert.equal(partial.errors[0]?.code, "QUOTE_UNAVAILABLE");
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

test("stream parser rejects non-NeTEx input", async () => {
  await assert.rejects(parseNetexStream(Readable.from("<bad/>"), "italo"), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
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
});

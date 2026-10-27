import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { ItaloLiveProvider } from "../src/rail/italo-live.ts";

test("normalizes date-unverified train status and station boards", async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    urls.push(String(input));
    return String(input).includes("RicercaTreno")
      ? new Response(JSON.stringify({ IsEmpty: false, TrainSchedule: { Distruption: { DelayAmount: 12 } } }))
      : new Response(JSON.stringify({ IsEmpty: false, DescrizioneLocalita: "Roma Termini", ListaTreniArrivo: [], ListaTreniPartenza: [{ Numero: "9900", Ritardo: 12, OraPassaggio: "10:00" }] }));
  };
  const provider = new ItaloLiveProvider(fetcher);
  const status = await provider.getTrainStatus({ trainNumber: "9900", serviceDate: "2026-11-10", origin: "RMT" });
  assert.equal(status.freshness, "date_unverified");
  assert.equal(status.delayMinutes, 12);
  const board = await provider.getStationBoard({ stationId: "IT::StopPlace:RMT", stationName: "Roma Termini", direction: "departures" });
  assert.equal(board.station.id, "RMT");
  assert.equal(board.services[0]?.trainNumber, "9900");
  assert.match(urls[1] ?? "", /CodiceStazione=RMT(?:&|$)/);
  assert.doesNotMatch(urls[1] ?? "", /StopPlace/);
});

test("distinguishes train not found and incompatible responses", async () => {
  await assert.rejects(new ItaloLiveProvider(async () => new Response('{"IsEmpty":true}')).getTrainStatus({ trainNumber: "1", serviceDate: "2026-11-10", origin: "RMT" }), (error: unknown) => error instanceof AppError && error.code === "TRAIN_NOT_FOUND");
  await assert.rejects(new ItaloLiveProvider(async () => new Response("bad")).getStationBoard({ stationId: "RMT", stationName: "Roma", direction: "departures" }), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
});

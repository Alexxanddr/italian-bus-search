import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain.ts";
import { TrenitaliaLiveProvider } from "../src/rail/trenitalia-live.ts";

test("normalizes dated train status and station boards from synthetic ViaggiaTreno fixtures", async () => {
  const epoch = new Date("2026-11-10T00:00:00+01:00").getTime();
  const fetcher: typeof fetch = async (request) => {
    const url = String(request);
    if (url.includes("cercaNumero")) return new Response(`9516 - SALERNO - 10/11/26|9516-S09818-${epoch}`);
    if (url.includes("andamentoTreno")) return Response.json({ ritardo: 12, cancellato: false });
    if (url.includes("autocompletaStazione")) return new Response("ROMA TERMINI|S08409");
    return Response.json([{ numeroTreno: 9660, orarioPartenza: 1792948500000, ritardo: 7 }]);
  };
  const provider = new TrenitaliaLiveProvider(fetcher);
  const status = await provider.getTrainStatus({ trainNumber: "9516", serviceDate: "2026-11-10", origin: "SALERNO" });
  assert.equal(status.freshness, "current");
  assert.equal(status.delayMinutes, 12);
  const board = await provider.getStationBoard({ stationId: "IT::StopPlace:830008409", stationName: "ROMA TERMINI", direction: "departures" });
  assert.equal(board.station.id, "S08409");
  assert.equal(board.services[0]?.trainNumber, "9660");
  assert.equal(board.services[0]?.delayMinutes, 7);
});

test("distinguishes missing trains and incompatible live responses", async () => {
  await assert.rejects(new TrenitaliaLiveProvider(async () => new Response("")).getTrainStatus({ trainNumber: "1", serviceDate: "2026-11-10", origin: "ROMA" }), (error: unknown) => error instanceof AppError && error.code === "TRAIN_NOT_FOUND");
  await assert.rejects(new TrenitaliaLiveProvider(async () => new Response("bad")).getStationBoard({ stationId: "S08409", stationName: "ROMA TERMINI", direction: "departures" }), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
});

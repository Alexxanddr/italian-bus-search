# Train HTTP API

## Sources and price behavior

The train API combines two sources with explicit provenance:

- authorized Italian NAP NeTEx caches provide stations and the scheduled-service baseline;
- Trenitalia and Italo booking searches provide current saleable journeys, passenger-specific total prices, and availability.

When a booking search succeeds, including an empty response, that live result set is
authoritative. Matching NeTEx journeys are enriched and additional live
multi-change solutions are constructed from the booking response. Theoretical
NeTEx combinations not offered by the booking system are omitted.

If a booking search fails, scheduled journeys remain available with
`price: null` and a `QUOTE_UNAVAILABLE` or `RATE_LIMITED` provider error. A
successful non-saleable solution can also contain `price: null` and
`available: false`. A missing price is never converted to zero or inferred.

Quote searches still run when the local timetable is missing or expired; the
response retains the schedule error while returning any successful live data.
If a timetable cannot be loaded, station discovery falls back to the verified
live catalogs and labels those locations `source: live`; the cache error is
preserved. Trenitalia's live autocomplete fallback is capped at 50 matches;
use a more precise station name when needed.
Timetable departures use the calendar day at the boarding station, including
trains whose service began the previous day and transfers after midnight.

## `GET /train-providers`

Returns enabled capabilities without making upstream calls.

```sh
curl 'http://127.0.0.1:3000/train-providers'
```

```json
{
  "providers": [
    { "id": "trenitalia", "capabilities": { "schedule": true, "price": true, "liveStatus": true, "stationBoard": true } },
    { "id": "italo", "capabilities": { "schedule": true, "price": true, "liveStatus": true, "stationBoard": true } }
  ]
}
```

## Maintainer protocol inventory

These endpoints are implementation evidence for maintainers, not public
service routes. They require no customer account or API key in this deployment.

| Capability | Method and endpoint | Session behavior |
|---|---|---|
| Trenitalia stations | `GET https://www.lefrecce.it/Channels.Website.BFF.WEB/website/locations/search?name=…&limit=10` | Anonymous |
| Trenitalia journeys/prices | `POST …/website/ticket/solutions` | Anonymous; pages of 10, offsets `0..90`, deduplicated by solution ID |
| Trenitalia status | ViaggiaTreno `cercaNumeroTrenoTrenoAutocomplete/{number}` then `andamentoTreno/{originCode}/{number}/{epoch}` | Anonymous; candidate must match date and origin |
| Trenitalia board | ViaggiaTreno `autocompletaStazione/{name}` then `arrivi` or `partenze` | Anonymous |
| Italo anonymous login | `POST https://biglietti.italotreno.com/api/login` | Creates a short-lived anonymous bearer session |
| Italo stations | `POST https://api-biglietti.italotreno.com/api/v1/stations/list` | Anonymous bearer plus working-session ID |
| Italo journeys/prices | `POST …/api/v1/booking`, then `GET …/booking/status/{operationId}` | Polls for at most 20 seconds; booking and working session are deleted best-effort |
| Italo status/board | `GET https://italoinviaggio.italotreno.com/api/RicercaTrenoService` or `RicercaStazioneService` | Anonymous; status date remains unverified |
| Timetable refresh | CCISS/NAP `checkedResource` assets `1080596` (Trenitalia) and `1814124` (Italo) | Public download; compact caches remain local |

Trenitalia quote requests include location IDs, date/time, adult/child counts,
sorting and pagination criteria. Italo quote requests include station IDs,
date, passenger counts and the temporary working-session ID. Neither adapter
selects fares, reserves seats, starts payment, or retains upstream tokens.

Quote results are cached for 60 seconds. Trenitalia requests time out after
five seconds; Italo individual requests after eight seconds with a bounded
20-second polling operation. HTTP `429`, timeouts, malformed JSON, oversized
responses, ambiguous stations, and cleanup behavior are mapped to the error
codes documented in [HTTP API](api.md).

Trenitalia pagination excludes departures after the requested day. If the
100-result safety bound is reached, the quote fails explicitly with
`QUOTE_UNAVAILABLE`; it is never presented as a complete live response.
Italo structures other than the verified single-operator, single-segment
shape fail explicitly rather than silently dropping those solutions.

## `GET /train-locations`

| Parameter | Required | Meaning |
|---|---:|---|
| `query` | yes | Partial station name or operator station ID |
| `provider` | no | `trenitalia` or `italo`; omission searches both |

```sh
curl 'http://127.0.0.1:3000/train-locations?query=Roma'
```

```json
{
  "locations": [
    {
      "provider": "trenitalia",
      "id": "IT::StopPlace:otherTRENITALIA:830008409",
      "name": "ROMA TERMINI",
      "city": "ROMA TERMINI",
      "source": "historical_snapshot",
      "observedAt": "2026-10-22T14:15:47Z"
    },
    {
      "provider": "italo",
      "id": "IT::StopPlace:RMT",
      "name": "Roma Termini (Rome)",
      "city": "Roma Termini (Rome)",
      "source": "historical_snapshot",
      "observedAt": "2026-10-24T02:03:28+02:00"
    }
  ],
  "errors": []
}
```

Use station names for cross-operator searches. IDs are operator-specific.

## `GET /train-journeys`

| Parameter | Required | Default | Constraints |
|---|---:|---:|---|
| `origin` | yes | — | Exact station name or matching operator station ID |
| `destination` | yes | — | Exact station name or matching operator station ID |
| `date` | yes | — | Real future date in `YYYY-MM-DD` format |
| `adults` | no | `1` | Integer from 1 through 9 |
| `children` | no | `0` | Integer from 0 through 9 |
| `provider` | no | both | `trenitalia` or `italo` |

```sh
curl 'http://127.0.0.1:3000/train-journeys?origin=Roma%20Termini&destination=Milano%20Centrale&date=2026-11-15&adults=1&children=0'
```

```sh
curl 'http://127.0.0.1:3000/train-journeys?origin=ROMA%20TERMINI&destination=COSENZA&date=2026-10-30&adults=1&children=0&provider=trenitalia'
```

Abbreviated response (the real `legs` array contains every leg):

```json
{
  "journeys": [
    {
      "provider": "trenitalia",
      "journeyId": "trenitalia:quote:2026-10-30:0",
      "origin": { "id": "S08409", "name": "Roma Termini" },
      "destination": { "id": "Cosenza", "name": "Cosenza" },
      "departure": "2026-10-30T08:06:00.000+01:00",
      "arrival": "2026-10-30T17:07:00.000+01:00",
      "durationMinutes": 541,
      "changes": 2,
      "legs": [
        {
          "trainNumber": "12655",
          "origin": { "id": "S08409", "name": "Roma Termini" },
          "destination": { "id": "S08640", "name": "Formia-Gaeta" },
          "departure": "2026-10-30T08:06:00.000+01:00",
          "arrival": "2026-10-30T09:44:00.000+01:00"
        }
      ],
      "available": true,
      "price": {
        "amount": 35.05,
        "currency": "EUR",
        "observedAt": "2026-10-26T10:30:00.000Z",
        "source": "Trenitalia lefrecce quote"
      },
      "bookingUrl": "https://www.lefrecce.it/Channels.Website.WEB/",
      "timetableSource": {
        "source": "Trenitalia lefrecce booking search",
        "publishedAt": "2026-10-26T10:30:00.000Z",
        "validFrom": "2026-10-30",
        "validThrough": "2026-10-30"
      }
    }
  ],
  "errors": []
}
```

The price is the total for the requested passengers at `observedAt`, not a
per-person price. `bookingUrl` is only for manual continuation. The HTTP route
returns the complete result set; MCP adds `offset` and `limit` pagination.

## `GET /train-status`

| Parameter | Required | Meaning |
|---|---:|---|
| `provider` | yes | `trenitalia` or `italo` |
| `trainNumber` | yes | Operator train number |
| `serviceDate` | yes | Date in `YYYY-MM-DD` |
| `origin` | yes | Trenitalia service-origin name/`S...` code (or a journey-leg origin when the date has one matching record), or Italo station code |

```sh
curl 'http://127.0.0.1:3000/train-status?provider=trenitalia&trainNumber=9516&serviceDate=2026-11-15&origin=Roma%20Termini'
```

```json
{
  "observedAt": "2026-11-15T08:30:00.000Z",
  "source": "ViaggiaTreno",
  "freshness": "current",
  "delayMinutes": 7,
  "cancelled": false
}
```

Italo status can be `date_unverified`: its upstream response does not prove
that the returned instance belongs to the requested date.

## `GET /station-board`

| Parameter | Required | Meaning |
|---|---:|---|
| `provider` | yes | `trenitalia` or `italo` |
| `stationId` | yes | Station ID returned by `/train-locations`; raw operator codes are also accepted |
| `stationName` | yes | Exact station name used for safe resolution |
| `direction` | yes | `arrivals` or `departures` |

```sh
curl 'http://127.0.0.1:3000/station-board?provider=italo&stationId=IT%3A%3AStopPlace%3ARMT&stationName=Roma%20Termini%20%28Rome%29&direction=departures'
```

```json
{
  "provider": "italo",
  "station": { "id": "RMT", "name": "Roma Termini" },
  "direction": "departures",
  "observedAt": "2026-10-26T10:30:00.000Z",
  "source": "Italo In Viaggio (date unverified)",
  "services": [
    { "trainNumber": "9920", "scheduledTime": "10:00", "delayMinutes": 4 }
  ]
}
```

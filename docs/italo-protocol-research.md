# Italo quote and live protocol research

Verification date: 25 October 2026, approximately 10:46–10:51 Europe/Rome.

This note records an independent inspection of Italo's anonymous official public clients. The repository owner explicitly authorized the temporary planning-resource operations used for quote searches in this deployment. No customer account, fare selection, passenger details, cart checkout, payment, CAPTCHA or purchase action was performed. No raw tokens, cookies or carrier responses are committed.

## Decision

| Capability | Technical result | Enable now? |
|---|---|---|
| Station catalog for quotes | Verified anonymous contract | Yes |
| Priced quote | Verified anonymous technical login, asynchronous planning operation, fares and cleanup | Yes, for this deployment |
| Train status | Verified anonymous public endpoint, but it has no service-date input and returned no record for the tested train | **No dated-journey enrichment**; usable later only as `date_unverified` after parser fixtures |
| Station board | Verified anonymous public endpoint and response | Yes technically, after a synthetic fixture/parser test; never infer a service date |

The owner explicitly expanded the product boundary to include Italo's temporary anonymous planning resource. The adapter exposes only schedules, saleability, minimum price and the official search link; it never selects a fare or advances toward purchase.

## Booking and prices

### Official surfaces

- Search page: <https://biglietti.italotreno.com/it/booking/ricerca>
- API origin exposed by the current public JavaScript client: `https://api-biglietti.italotreno.com/`
- Public legal terms: <https://www.italotreno.com/copyright-note-legali>
- Robots policy: <https://biglietti.italotreno.com/robots.txt>

The page is a Next.js client protected by Akamai. An initial anonymous page load sets locale and Akamai bot-management cookies. The public JavaScript also implements an anonymous technical-login/working-session flow and can attach `X-BIG-working-session-id` to API calls. This is materially different from a stateless quote endpoint.

### Verified station request

```http
POST https://api-biglietti.italotreno.com/api/v1/stations/list
Accept: application/json
Content-Type: application/json

{"culture":"it-IT"}
```

One direct request without a prior session, cookie or authorization header returned HTTP 200, `application/json`, an `NTV-SessionId` response header, and a code-keyed station object. Representative fields are:

```json
{
  "TOP": { "name": "Torino Porta Nuova", "isDisabled": false },
  "RM0": { "name": "Roma (Tutte)", "isDisabled": false }
}
```

The response includes both Italo and non-Italo/disabled locations; an adapter must preserve the code and reject disabled entries for journey input rather than treating this as an Italo-only catalog.

### Quote contract status

The public bundle identifies these relevant paths:

- `POST api/v1/booking` for the standard booking/planning operation;
- `POST api/v1/working-sessions` and the `X-BIG-working-session-id` header;
- `GET api/v1/fare/{...}` for fare dictionaries/details;
- `GET/POST api/v1/stations...` for station retrieval;
- anonymous authorization/login helpers under `public/api/v1/users/...`.

An ordinary anonymous Roma Termini–Milano Centrale search was executed on 25 October 2026. The client called `POST api/v1/booking`, polled `/api/v1/booking/status/{id}`, loaded `/api/v1/booking/{id}`, and on a repeated search called `/api/v1/booking/{previous-id}/delete/status/{id}`. The results page displayed dated trains and minimum prices, proving technical availability but also proving that search allocates and cleans up mutable booking resources.

The verified runtime sequence is:

1. `POST https://biglietti.italotreno.com/api/login` with `X-Anonymous-User: true` and `{"isAnonymous":true,"workingId":"<random>"}`; the `BIGSessionToken` cookie value is used only as the bearer token in memory.
2. `POST https://api-biglietti.italotreno.com/api/v1/stations/list` to resolve exact station codes.
3. `POST .../api/v1/booking` with the bearer token and `X-BIG-working-session-id`. The one-way request contains station codes, date, adult/child counts, culture, no promo and `portalType: "B2C"`.
4. Poll `GET .../api/v1/booking/status/{operationId}` until HTTP 200, bounded to six attempts.
5. Read `trips[].travelSolutions[].journeys[].segments[]`: train number and datetimes identify the service; `fares[].availableCount` and the sum of `paxFares[].fullPaxDiscountPrice` determine the cheapest currently available fare.
6. Delete `/api/v1/booking/{bookingId}` and the working session best-effort. Cleanup failure never changes the returned price but remains an upstream operational risk.

The live Roma Termini–Milano Centrale verification for 10 November 2026 returned 33 planning solutions. Train 9904 at 05:40–09:20 exposed EUR 34.90. The booking result is now authoritative when successful: 29 solutions matched NeTEx exactly and four additional live solutions were normalized from their Italo segment data, yielding 33 priced results and no theoretical unquoted combinations.

The same browser flow was repeated with one adult and one child. Its request added `childPassengers: 1`, retained `passengersAges: null`, and included the otherwise empty `promocodeAlias`. The adapter now sends that exact passenger shape, retries transient polling 5xx responses within a bounded 20-second client window, and always awaits best-effort session cleanup. A live adapter retest returned 33 priced quotes; the first total was EUR 44.95 with fare `Italo Famiglia Bambini GRATIS`.

### Booking errors and limits

The client recognizes RFC 9110-style problem responses and named conditions including unavailable/too-many connections and missing working sessions. The adapter uses eight-second request timeouts, a five-megabyte response cap, a 60-second successful-result cache, bounded polling, explicit 429 handling and safe provider errors for 401/403/409/5xx. Low-volume probes observed no 429 or advertised quota headers; this is not a measured throughput allowance.

The booking robots file disallows parameterized result pages and later funnel steps such as train selection, passengers and payment. Robots rules are not authorization, but they reinforce the decision not to automate the purchase funnel. The public legal terms describe the site as a facility for searching schedules/prices and buying tickets, but do not publish a supported API or stability/redistribution grant. The user's deployment authorization is recorded separately; downstream users must make their own decision.

## Italo In Viaggio live information

### Official surfaces and transport

- Portal: <https://italoinviaggio.italotreno.com/it/>
- Public bundle observed: `/Scripts/ItaloInViaggio/js/common.modern.js`
- Live robots policy: <https://italoinviaggio.italotreno.com/robots.txt> returned `Disallow:` with no excluded path.

The live endpoints are same-origin HTTPS GET requests with JSON responses. The inspected public bundle sends ordinary `Accept: application/json` requests. It supports optional bearer and portal-origin headers generically, but neither verified endpoint required them. Direct probes succeeded without cookies, login, API key, bearer token or preliminary session.

### Train status

```http
GET https://italoinviaggio.italotreno.com/api/RicercaTrenoService?TrainNumber=8908
Accept: application/json
```

Verified response for a record not resolved at probe time:

```json
{"IsEmpty":true,"LastUpdate":null,"TrainSchedule":null}
```

HTTP status was 200 even for the empty result. The public client reads, when present, `TrainSchedule.Leg`, disruption/delay information, stopped and non-stopped station arrays, planned/actual arrival and departure times/platforms, and a last-update value.

Crucially, the request accepts only a train number: it has no service date or origin identity. The response shape observed in the client does not prove an operating date. It must therefore be modeled with `serviceDate: null` and `freshness: "date_unverified"`; it must not enrich a dated NeTEx journey automatically.

Synthetic fixture guidance:

```json
{
  "IsEmpty": false,
  "LastUpdate": "10:15",
  "TrainSchedule": {
    "TrainNumber": "9900",
    "Distruption": { "DelayAmount": 12, "Warning": false },
    "Leg": { "DepartureStation": "ROMA TERMINI", "ArrivalStation": "MILANO CENTRALE" },
    "StazioniFerme": []
  }
}
```

Use invented values and retain the upstream misspelling `Distruption` only inside the protocol fixture/type.

### Station board

```http
GET https://italoinviaggio.italotreno.com/api/RicercaStazioneService?CodiceStazione=RMT&NomeStazione=roma%20termini
Accept: application/json
```

The low-volume probe returned HTTP 200 JSON without session state. Top-level fields were:

- `IsEmpty`
- `DescrizioneLocalita`
- `LastUpdate`
- `ListaTreniArrivo`
- `ListaTreniPartenza`

Each board item exposed the fields `DescrizioneLocalita`, `Numero`, `Ritardo`, `OraPassaggio`, `Binario`, `NuovoOrario`, `Descrizione`, `InfoRoute` and `Informazioni`. Missing platform was the empty string. Delay `0` is an explicit upstream value for this board response; absent delay must remain unknown.

Minimal synthetic fixture:

```json
{
  "IsEmpty": false,
  "DescrizioneLocalita": "roma termini",
  "LastUpdate": "10:15",
  "ListaTreniArrivo": [],
  "ListaTreniPartenza": [
    {
      "DescrizioneLocalita": "MILANO CENTRALE",
      "Numero": "9900",
      "Ritardo": 12,
      "OraPassaggio": "10:00",
      "Binario": "4",
      "NuovoOrario": "10:12",
      "Descrizione": "Firenze (11.30)",
      "InfoRoute": "Firenze (11.30)",
      "Informazioni": ""
    }
  ]
}
```

`LastUpdate` contains only a clock time in the verified response, not an ISO timestamp or service date. An adapter may attach its own `observedAt` request time and preserve the source update string separately; it must label the source date unverified.

### Live errors and rate behavior

Empty train results use HTTP 200 plus `IsEmpty: true`, not 404. The client treats request failures separately and displays a generic unavailable state. One train and one station probe returned 200; no 429, `Retry-After` or documented rate header was observed. That proves only anonymous technical accessibility, not a throughput allowance. Use a five-second timeout, short successful-result cache, bounded response size and very low request concurrency.

## Phase 0 completion assessment

The station-board, standalone train-status, station catalog and priced planning contracts are covered by native TypeScript adapters and synthetic fixture/error tests. Train-number status still cannot be joined to a dated scheduled journey and remains date-unverified.

Skipped: no fare selection, customer login, CAPTCHA, seat, passenger-detail, checkout or payment action was executed. Risk: the quote and live endpoints are undocumented; quote searches create temporary server-side planning state and cleanup is best-effort.

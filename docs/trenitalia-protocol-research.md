# Trenitalia quote and live protocol research

Verification date: 25 October 2026, approximately 10:47–10:49 Europe/Rome.

This note records an independent, anonymous, read-only and low-volume verification against Trenitalia-owned public clients and endpoints. No third-party implementation supplied request code. No login, cart mutation, booking, purchase, payment, CAPTCHA bypass or personal data was used. Raw responses and cookies were kept only in temporary files and are not repository fixtures.

## Decision

| Capability | Technical result | Authorization/stability result | Enable? |
|---|---|---|---|
| Station lookup | Verified anonymously | Subject to the website terms below | No |
| Priced quote and saleability | Verified anonymously again on 25 October 2026 | Enabled for the owner's asserted authorized deployment; no carrier authorization is claimed | Yes |
| ViaggiaTreno station/train live data | Verified through the official client and direct low-volume requests | Enabled for the owner's asserted authorized deployment; undocumented HTTP contract | Yes |

The repository owner explicitly instructed enabling these read-only capabilities for this deployment. That instruction is recorded as the deployment decision, not represented as permission from Trenitalia and not inherited by downstream deployments.

## Priced quote source: lefrecce public BFF

Base URL:

```text
https://www.lefrecce.it/Channels.Website.BFF.WEB/website
```

### Station lookup

```text
GET /locations/search?name=<text>&limit=<integer>
```

A request for `Roma`, limit 3, returned HTTP 200 JSON without a pre-existing cookie, API key, CSRF header or browser `User-Agent`. Each item contained:

- numeric `id`;
- `name` and `displayName`;
- IANA `timezone` (`Europe/Rome` in the observation);
- boolean `multistation`;
- numeric `centroidId`.

The response set Akamai cookies, but they were not necessary for the successful request.

### Solution quotes

```text
POST /ticket/solutions
Content-Type: application/json
```

The request body independently reconstructed from the official public JavaScript client and then verified was:

```json
{
  "departureLocationId": 830008409,
  "arrivalLocationId": 830001700,
  "departureTime": "2026-11-10T08:00:00.000",
  "adults": 1,
  "children": 0,
  "criteria": {
    "frecceOnly": false,
    "regionalOnly": false,
    "intercityOnly": false,
    "tourismOnly": false,
    "noChanges": false,
    "order": "DEPARTURE_DATE",
    "offset": 0,
    "limit": 10
  },
  "advancedSearchRequest": {
    "bestFare": false
  }
}
```

The body returned HTTP 200 with 10 solutions. No cookie, API key, CSRF token, preliminary homepage request or session initialization was sent. The response created `WSESSIONID` and Akamai cookies and included top-level `searchId` and `cartId`; those identifiers are not required to obtain the first quote and must not be persisted or exposed.

Relevant response fields were nested under each `solutions[].solution`:

- `id` (volatile search solution identity);
- `origin`, `destination`;
- ISO timestamps with explicit Europe/Rome offset in `departureTime` and `arrivalTime`;
- display `duration`;
- `status`, observed as `SALEABLE`;
- `price.amount`, `price.currency`, `price.indicative` and `price.hideAmount`;
- `trains[]` with `description`, `trainCategory`, `acronym`, `denomination` and `name`;
- `nodes[]` with origin/destination, timestamps, `bdoOrigin`, `salable` and train metadata.

The first observed direct Roma Termini–Milano Centrale solution departed at 08:10, arrived at 11:50, identified Frecciarossa 9516, was `SALEABLE`, and exposed EUR 44.90. This is only evidence that the contract worked at the recorded instant, not a stable fare or fixture value.

`advancedSearchRequest.bestFare: true` causes the official client to append `?bestFare=true`. Pagination is expressed by `criteria.offset` and `criteria.limit`; the current official client sets limit 10.

### Quote errors and rate behavior

An empty JSON body returned HTTP 400 and a JSON error object with `type`, `silent`, `message`, `object`, `stackTrace` and `errorrest`. The message described the missing passenger. An implementation must replace this body with a safe internal error and never expose `stackTrace`, correlation IDs, cookies, `cartId`, `searchId` or upstream text.

Four low-volume BFF requests (three station/quote successes and one deliberate validation failure) produced no HTTP 429 and no documented rate-limit headers. This establishes neither an allowance nor safe sustained volume. Any future adapter still needs a finite timeout, bounded pagination, short successful-result cache and explicit 429 handling.

### Synthetic quote fixtures

An offline fixture should invent all IDs and values while preserving only:

- top-level `solutions`;
- one `SALEABLE` direct solution with `price.amount` and currency;
- one `NOT_SALEABLE` or missing-price solution;
- a multi-node connection for matching tests;
- timestamps with explicit winter/summer offsets;
- train category/number fields.

Do not retain `searchId`, `cartId`, encrypted price material, cookies, correlation IDs or raw messages. Price normalization must add a local `observedAt` and source identifier. It may enrich a NeTEx itinerary only after operator, stations, all legs and times match.

## Live source: ViaggiaTreno

The public web protocol exposed by the official ViaggiaTreno client is rooted at:

```text
http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/
```

The endpoint inventory to verify remains:

```text
GET /autocompletaStazione/<prefix>
GET /partenze/<stationCode>/<dateTime>
GET /arrivi/<stationCode>/<dateTime>
GET /andamentoTreno/<originStationCode>/<trainNumber>/<serviceDayEpochMs>
```

The official HTTP client was opened successfully on 25 October 2026. Its normal search for train 9516 called `cercaNumeroTrenoTrenoAutocomplete/9516`, which returned `train-origin-serviceDayEpoch` identity, followed by `andamentoTreno/S09818/9516/1792879200000`. The same request with the ordinary client `Referer` and `X-Requested-With` headers returned HTTP 200 JSON directly. Station autocomplete and a departures board were also verified.

No login, cookie, API key or bearer token was required. The adapter uses the exact service date plus true service origin from autocomplete, treats HTTP 204 as not found, bounds response size and timeout, and preserves missing operational fields as unknown. No advertised quota was observed; this is not a throughput allowance.

The verified identity response was plain text in the form `9516 - SALERNO - 25/10/26|9516-S09818-1792879200000`. Station autocomplete likewise returned `ROMA TERMINI|S08409`. Boards accept the official client's JavaScript-style date string and return JSON arrays; train status returns one JSON object. Offline tests use invented equivalents:

```json
{
  "trainIdentity": "9516 - SALERNO - 10/11/26|9516-S09818-1794265200000",
  "status": { "ritardo": 12, "cancellato": false },
  "stationIdentity": "ROMA TERMINI|S08409",
  "departures": [{ "numeroTreno": 9660, "orarioPartenza": 1792948500000, "ritardo": 7 }]
}
```

Failures are classified as follows: HTTP 204 or no exact dated train identity is `TRAIN_NOT_FOUND`; HTTP 429 is `RATE_LIMITED`; timeout/network/non-success responses are `LIVE_STATUS_UNAVAILABLE`; malformed or oversized bodies are `INCOMPATIBLE_RESPONSE`. The low-volume verification observed no 429 or rate-limit headers, so production throughput must remain externally limited.

A later verification must succeed using the ordinary official UI, capture one station autocomplete, one departures/arrivals board and one dated train status, prove how `serviceDayEpochMs` is derived, distinguish HTTP 204 from provider failure, and synthesize fixtures before implementation.

## Terms, robots and source classification

The official [Trenitalia website terms](https://www.trenitalia.com/it/informazioni/termini-e-condizioni-di-utilizzo-sito-trenitalia.html) state that access is for personal, non-commercial use and prohibit acquisition/download, distribution, copying, publication and derivative/reuse activity unless explicitly permitted. They also reserve the right to block access. The [official cookie notice](https://www.trenitalia.com/it/informativa-sui-cookie.html) documents lefrecce session, CSRF and Akamai cookies, consistent with the observed response cookies, but does not grant API access.

No authoritative API documentation, stability commitment or automated-use licence was found for the BFF or ViaggiaTreno REST paths. Public technical accessibility is therefore classified as an unofficial web protocol, not an authorized public API. This deployment records the owner's explicit enablement decision; downstream deployers must make their own terms/legal-basis and price-retention decisions.


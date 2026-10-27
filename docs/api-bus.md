# Bus HTTP API

## Supported providers

| ID | Operator | Data |
|---|---|---|
| `itabus` | Itabus | Live stops, journeys, availability, and prices |
| `salemi` | Autoservizi Salemi | Live stops, journeys, availability, and prices |
| `federico` | Autolinee Federico | Live stops, journeys, availability, and prices |
| `marinobus` | MarinoBus | Live stops, journeys, availability, and prices |
| `flixbus` | FlixBus | Live stops, journeys, availability, and prices |

The normal flow is: inspect providers, resolve origin and destination, then
search journeys. Provider-specific IDs must only be used with that provider;
for an aggregate search, use exact names shared by the returned locations.

## `GET /providers`

Lists configured adapters without contacting upstream systems.

```sh
curl 'http://127.0.0.1:3000/providers'
```

```json
{
  "providers": [
    {
      "id": "marinobus",
      "status": "available",
      "statusReason": "Authorized anonymous live integration with timeout and in-memory cache"
    }
  ]
}
```

Status describes local adapter configuration, not a remote health probe.

## `GET /locations`

| Parameter | Required | Meaning |
|---|---:|---|
| `query` | yes | Partial city, stop name, provider ID, or known synonym |
| `provider` | no | One provider ID; omission queries every bus provider |

```sh
curl 'http://127.0.0.1:3000/locations?query=Roma&provider=itabus'
```

```json
{
  "locations": [
    {
      "provider": "itabus",
      "id": "ROM1",
      "name": "Roma (Tiburtina Terminal Bus)",
      "city": "Roma",
      "source": "live"
    }
  ],
  "errors": []
}
```

An empty successful lookup returns `200` with empty arrays. If every selected
provider fails, the route returns `503` with provider-scoped errors.

## `GET /journeys`

| Parameter | Required | Default | Constraints |
|---|---:|---:|---|
| `origin` | yes | — | Exact shared name, or a provider-specific location ID |
| `destination` | yes | — | Exact shared name, or a matching provider location ID |
| `date` | yes | — | Real future date in `YYYY-MM-DD` format |
| `adults` | no | `1` | Integer from 1 through 9 |
| `children` | no | `0` | Integer from 0 through 9 |
| `provider` | no | all | One configured bus provider |

Provider-specific example:

```sh
curl 'http://127.0.0.1:3000/journeys?origin=Roma&destination=Milano&date=2026-11-15&adults=1&children=0&provider=marinobus'
```

Aggregate example:

```sh
curl 'http://127.0.0.1:3000/journeys?origin=Roma&destination=Milano&date=2026-11-15&adults=1&children=0'
```

```json
{
  "journeys": [
    {
      "provider": "marinobus",
      "tripId": "provider-trip-id",
      "origin": { "id": "provider-origin", "name": "Roma" },
      "destination": { "id": "provider-destination", "name": "Milano" },
      "departure": "2026-11-15T22:00:00+01:00",
      "arrival": "2026-11-16T05:25:00+01:00",
      "durationMinutes": 445,
      "available": true,
      "price": { "amount": 49, "currency": "EUR" },
      "bookingUrl": "https://booking.marinobus.it/"
    }
  ],
  "errors": []
}
```

`price` is `null` only when the bus provider supplies no numeric price.
`fare` and `bookingUrl` are optional. A multi-leg provider response is exposed
as one journey. Healthy-provider results remain when another provider fails.

### Dates, city coverage and physical stops

Journey departures are restricted to the requested calendar day in
`Europe/Rome`. An arrival after midnight remains valid; a departure on the
following day does not. FlixBus's “after midnight” suggestions are excluded.

For Itabus, an exact city name or parent-city ID (for example `COS_T`)
searches all its stops, including Rende/Cosenza Nord. A physical stop ID
such as `COS1` or `COS3` keeps the search restricted to that stop.
The returned `bookingUrl` uses resolved codes, `datestart` and passenger
counts, matching the official search form. FlixBus links use the Italian
booking site so the displayed currency matches EUR.

Albatross journeys can enrich `origin` and `destination` with the actual
stop name, optional `address` and `city` (the requested search locality).
For example, searching Cosenza can return:

```json
{"id":"provider-stop-id","name":"Rende Cosenza Nord","city":"Cosenza","address":"via Luise Braille"}
```

Do not replace that physical destination with the searched city when
presenting a journey. Stop labels come from the optional public catalog;
if it is unavailable or the ID is absent, the journey retains its search
locality name and stop ID without inventing an address. Prices and journeys
remain available independently of this metadata.

## Maintainer protocol inventory

These are outbound contracts implemented by the adapters, not additional
public routes. Client input cannot select a host or arbitrary URL.

| Adapter | Requests | Session/authentication |
|---|---|---|
| Itabus | `GET …/Api-Stations`, `GET …/Api-Travels` | Anonymous; no stored cookie or credential |
| Salemi/Federico/MarinoBus | `GET locations/from`, `GET locations/to`, optional `GET locations/stopsFrom` and `GET fareCategories`, `POST search/s/{origin}/{destination}/{from}/{to}` | Anonymous; public `Albatross-Tenant` header only |
| FlixBus | `GET /search/service/v4/search` plus city lookup on `global.api.flixbus.com` | Anonymous; no credential |

Every request has a finite timeout and bounded response parsing. HTTP `429`
becomes `RATE_LIMITED`; network/non-success failures become
`PROVIDER_UNAVAILABLE`; malformed or oversized responses become
`INCOMPATIBLE_RESPONSE`. Successful locations are cached for one hour and
journeys for 60 seconds; failures are not cached.

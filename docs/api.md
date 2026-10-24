# HTTP interface

This document is the authoritative external contract of the service.

## General behavior

- The server accepts `GET` requests only.
- Responses are JSON.
- Unknown routes return `404` with a top-level `error` object.
- Requests are limited to 60 per client identifier in each rolling process-local minute window.
- Provider aggregation is concurrent and failure-isolated.
- Datetimes are ISO 8601 strings copied from the provider response.
- Prices are decimal major currency units, currently normalized to the provider-reported currency or EUR.

## `GET /health`

Process liveness only. It does not probe providers.

Response `200`:

```json
{
  "status": "ok"
}
```

## `GET /providers`

Lists configured adapters without making remote requests.

Response `200`:

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

Provider status is adapter configuration, not a live health check.

## `GET /locations`

Query parameters:

| Parameter | Required | Meaning |
|---|---:|---|
| `query` | yes | Case-insensitive partial location name, city, ID, or provider synonym |
| `provider` | no | One provider ID; omission searches all providers |

Example:

```sh
curl 'http://127.0.0.1:3000/locations?query=Roma&provider=itabus'
```

Response:

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

An empty successful search returns `200` with empty `locations` and `errors`. If every selected provider fails, the endpoint returns `503` with provider errors.

## `GET /journeys`

Query parameters:

| Parameter | Required | Default | Constraints |
|---|---:|---:|---|
| `origin` | yes | — | Exact provider location name or ID |
| `destination` | yes | — | Exact provider location name or ID reachable from the origin |
| `date` | yes | — | Real future date in `YYYY-MM-DD` format |
| `adults` | no | `1` | Integer from 1 through 9 |
| `children` | no | `0` | Integer from 0 through 9 |
| `provider` | no | all | Configured provider ID |

Example:

```sh
curl 'http://127.0.0.1:3000/journeys?origin=Roma&destination=Milano&date=YYYY-MM-DD&adults=1&children=0&provider=marinobus'
```

Replace `YYYY-MM-DD` with a future date.

Response:

```json
{
  "journeys": [
    {
      "provider": "marinobus",
      "tripId": "provider-trip-id",
      "origin": {
        "id": "provider-stop-id",
        "name": "Roma"
      },
      "destination": {
        "id": "provider-stop-id",
        "name": "Milano"
      },
      "departure": "2027-01-15T22:00:00+00:00",
      "arrival": "2027-01-16T05:25:00+00:00",
      "durationMinutes": 445,
      "available": true,
      "price": {
        "amount": 49,
        "currency": "EUR"
      },
      "bookingUrl": "https://booking.marinobus.it/"
    }
  ],
  "errors": []
}
```

`price` is `null` when the provider supplies no numeric price. `fare` and `bookingUrl` are optional. A multi-leg upstream solution is returned as one journey; its `tripId` joins leg IDs with `+`.

When one provider succeeds, the endpoint returns `200` and preserves errors from other providers. When no provider returns a journey and at least one provider reports an error or `NO_JOURNEYS`, the endpoint returns `503`.

## Errors

Request-level errors use this shape:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "date must be a real future date in YYYY-MM-DD format"
  }
}
```

Provider errors inside aggregate responses use this shape:

```json
{
  "provider": "itabus",
  "code": "UNKNOWN_LOCATION",
  "message": "Unknown Itabus destination: Example"
}
```

| Code | Meaning | Typical HTTP status |
|---|---|---:|
| `INVALID_INPUT` | Invalid parameter, method, route, or provider ID | `400`, `404`, or `405` |
| `UNKNOWN_LOCATION` | Provider cannot resolve an exact origin or destination | aggregate response |
| `NO_JOURNEYS` | Provider answered successfully with no journeys | aggregate response |
| `PROVIDER_UNAVAILABLE` | Timeout, network failure, or non-success upstream status | aggregate response |
| `INCOMPATIBLE_RESPONSE` | Upstream JSON or required fields do not match the adapter | aggregate response |
| `RATE_LIMITED` | Local or upstream rate limit was reached | `429` locally; aggregate upstream |

Messages are safe summaries. Upstream bodies, cookies, tokens, and stack traces are not returned.

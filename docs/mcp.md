# MCP interface

This document is the authoritative contract for the local Model Context Protocol interface.

## Transport and lifecycle

The same tools are available over local stdio and stateless Streamable HTTP. A local host starts `dist/mcp/stdio.js`; a service host starts `dist/index.js` and mounts `/mcp`. Each HTTP exchange gets a fresh MCP protocol instance while provider adapters, caches, and the search budget remain shared for the handler's lifetime. MCPHub needs no sticky sessions. Request bodies are limited to 64 KiB. Diagnostics use stderr.

The server exposes search tools. Italo prices require anonymous technical session initialization and a temporary planning resource, cleaned up best-effort; no customer account, fare selection, seat reservation or payment is performed. Closing stdin ends the transport; `SIGINT` and `SIGTERM` close it gracefully.

## Typical flow

For a request such as “find buses from Rome to Milan on 15 November,” the host model should:

1. call `search_locations` for the origin and destination;
2. choose IDs or exact names from the returned provider locations;
3. call `search_journeys` with a real future date in `YYYY-MM-DD` format;
4. present the returned journeys and official `bookingUrl` values to the user.

Natural-language interpretation belongs to the host model, not this server. Train searches follow the same location-first flow using the train-specific tools.

## Tools

### `list_providers`

Takes no input. Returns configured provider IDs, status, and status reason without making upstream requests or consuming the search rate limit.

### `search_locations`

| Input | Required | Default | Constraints |
|---|---:|---:|---|
| `query` | yes | — | Non-empty partial city, stop, or location name |
| `provider` | no | all | Configured provider ID |
| `offset` | no | `0` | Non-negative integer; increase by `limit` while `truncated` is true |
| `limit` | no | `50` | Integer from 1 through 50 |

Returns `locations`, provider-scoped `errors`, `total` before limiting, and `truncated`.

### `search_journeys`

| Input | Required | Default | Constraints |
|---|---:|---:|---|
| `origin` | yes | — | Exact name or ID returned by `search_locations` |
| `destination` | yes | — | Exact name or ID returned by `search_locations` |
| `date` | yes | — | Real future date in `YYYY-MM-DD` format |
| `adults` | no | `1` | Integer from 1 through 9 |
| `children` | no | `0` | Integer from 0 through 9 |
| `provider` | no | all | Configured provider ID |
| `offset` | no | `0` | Non-negative integer; increase by `limit` while `truncated` is true |
| `limit` | no | `50` | Integer from 1 through 50 |

Returns `journeys`, provider-scoped `errors`, `total` before limiting, and `truncated`. Each journey includes normalized timing, availability, price, and an official `bookingUrl` when available.

Salemi, Federico, and MarinoBus links open a public search route with origin, destination, date, and adult count. Itabus links use resolved city/stop codes, datestart and adult/child counts. FlixBus links open the Italian booking site. Links only hand the user off for manual continuation.

Itabus city searches include all stops; explicit stop IDs restrict results.
Bus journey endpoints can expose actual stop names, city and address: preserve
them in reports, especially when the physical stop is in Rende/Cosenza Nord.
Departure dates use Europe/Rome and exclude next-day suggestions.
Rail legs can mark urban transfers with transportMode, description and
includedInPrice. Show every journey warning; a UB transfer must not be
presented as a train or as included in the quoted fare when excluded.
These optional fields are preserved in structured output, snapshot pages
and compact display text.

### Rail tools

- `list_train_providers` lists operators and configured schedule, price, live-status, and station-board capabilities without contacting upstream systems.
- `search_train_locations` resolves Trenitalia/Italo stations. Names are preferred across operators; IDs are provider-specific. It accepts `offset` and `limit` and returns `locations`, provider errors, `total`, and `truncated`.
- `search_train_journeys` accepts date/passenger fields plus `offset` and `limit`, and returns the provider's live booking solutions with all reported legs, availability, passenger-total prices, official search links, `total`, `truncated`, and provider errors. When every result is requested, advance `offset` by `limit` until `truncated` is false. If a booking source fails, that operator returns an explicit error and no invented journeys; successful results from other operators remain. Each result carries source/freshness metadata. Use only `bookingUrl` for manual purchase continuation.
- `get_train_status` requires `provider`, `trainNumber`, `serviceDate`, and `origin`. For Trenitalia, the service-origin name or ViaggiaTreno `S...` code disambiguates multiple same-date records; when the date has exactly one record, an origin returned on a journey leg is also accepted. Italo responses remain standalone with `freshness: date_unverified`.
- `get_station_board` requires `provider`, `stationId`, `stationName`, and `direction`. Both operators accept the IDs returned by `search_train_locations`; Trenitalia resolves a non-`S...` booking ID from the exact station name and Italo extracts its operator code from the returned namespaced station ID.

## Results and errors

### Immutable journey snapshots

For exhaustive bus or train searches, call `search_journeys` or
`search_train_journeys` with the usual query plus `snapshot: true`,
`offset: 0` and `limit: 50`. The response adds `searchId`, `createdAt`
and `expiresAt`. Continue using only `searchId`, `offset` and `limit`;
the original query/passenger/provider fields must be omitted. For example:

```json
{"searchId":"UUID-FROM-FIRST-RESPONSE","offset":50,"limit":50}
```

The query fields are required for new searches only. This mode freezes
order, totals, prices and provider errors and never calls upstream again
for later pages. Start a new snapshot to refresh prices or retry providers.
Expired/evicted/restarted IDs return a tool error saying the search expired;
never silently continue with a fresh query. Snapshots last at most five
minutes, are process-local, hold at most 32 searches and accept at most
1 MiB per full result. A bus ID cannot be used for trains or vice versa.

Calls without snapshot/searchId retain the existing offset behavior and
response shape. Only the opt-in snapshot flow guarantees consistent pages.

Every successful tool call contains both compact text for display and `structuredContent` matching the advertised output schema. A provider failure remains in the `errors` array when another provider succeeds.

Invalid input, an unknown provider, or a process-local search limit violation returns an MCP tool result with `isError: true`. Upstream bodies, stack traces, cookies, and credentials are never included.

## Limits

All bus and rail search/status tools share a process-local allowance of 60 calls per minute for each MCP handler (across HTTP exchanges) or stdio connection. `list_providers` and `list_train_providers` are exempt. Provider calls have finite per-request timeouts; Italo's asynchronous quote polling additionally has a bounded 20-second client window.

## Run locally

Development source:

```sh
npm run mcp
```

Compiled entrypoint:

```sh
npm run build
npm run mcp:built
```

Generic host configuration after building:

```json
{
  "mcpServers": {
    "italian-travel-search": {
      "command": "node",
      "args": ["/absolute/path/to/italian-travel-search/dist/mcp/stdio.js"]
    }
  }
}
```

MCPHub Streamable HTTP configuration:

```json
{
  "type": "streamable-http",
  "url": "http://italian-travel-search.extra-tools.svc:3000/mcp"
}
```

The public npm package is `italian-travel-search` and exposes the `italian-travel-search` and `italian-travel-search-mcp` executables.

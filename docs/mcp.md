# MCP interface

This document is the authoritative contract for the local Model Context Protocol interface.

## Transport and lifecycle

The same tools are available over local stdio and stateless Streamable HTTP. A local host starts `dist/mcp/stdio.js`; a service host starts `dist/index.js` and mounts `/mcp`. Each HTTP exchange gets a fresh MCP server instance, so MCPHub needs no sticky sessions and the bus tool contract remains unchanged. Diagnostics use stderr.

The server is read-only. It exposes search tools and never logs in, books, selects a seat, collects customer data, or pays a provider. Closing stdin ends the transport; `SIGINT` closes it gracefully.

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
| `limit` | no | `10` | Integer from 1 through 50 |

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
| `limit` | no | `10` | Integer from 1 through 50 |

Returns `journeys`, provider-scoped `errors`, `total` before limiting, and `truncated`. Each journey includes normalized timing, availability, price, and an official `bookingUrl` when available.

Salemi, Federico, and MarinoBus links open a public search route with origin, destination, date, and adult count. Itabus currently falls back to its official booking application because no stable public pre-filled URL has been verified. Links only hand the user off for manual continuation.

### Rail tools

- `list_train_providers` lists operators and configured schedule, price, live-status, and station-board capabilities without contacting upstream systems.
- `search_train_locations` resolves Trenitalia/Italo stations. Names are preferred across operators; IDs are provider-specific. It returns `locations`, provider errors, `total`, and `truncated`.
- `search_train_journeys` accepts date/passenger fields plus `offset` and `limit`, and returns direct and one-change journeys with departure/arrival times, availability, prices, official search links, `total`, `truncated`, and provider errors. When every result is requested, advance `offset` by `limit` until `truncated` is false. Each result carries `timetableSource`; exact Trenitalia and Italo matches can carry a short-lived price observation. Use only `bookingUrl` for manual purchase continuation.
- `get_train_status` requires `provider`, `trainNumber`, `serviceDate`, and `origin`. For Trenitalia, `origin` is the train's service origin name or ViaggiaTreno `S...` code. Italo responses remain standalone with `freshness: date_unverified`.
- `get_station_board` requires `provider`, `stationId`, `stationName`, and `direction`. Both operators are enabled; Trenitalia resolves a non-`S...` timetable ID from the exact station name.

## Results and errors

Every successful tool call contains both compact text for display and `structuredContent` matching the advertised output schema. A provider failure remains in the `errors` array when another provider succeeds.

Invalid input, an unknown provider, or a process-local search limit violation returns an MCP tool result with `isError: true`. Upstream bodies, stack traces, cookies, and credentials are never included.

## Limits

All bus and rail search/status tools share a process-local allowance of 60 calls per minute for each MCP server instance. `list_providers` and `list_train_providers` are exempt. Provider calls have finite per-request timeouts; Italo's asynchronous quote polling additionally has a bounded 20-second client window.

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
    "italian-bus-search": {
      "command": "node",
      "args": ["/absolute/path/to/italian-bus-search/dist/mcp/stdio.js"]
    }
  }
}
```

MCPHub Streamable HTTP configuration:

```json
{
  "type": "streamable-http",
  "url": "http://italian-bus-search.extra-tools.svc:3000/mcp"
}
```

The public npm package is `italian-bus-search` and exposes both `italian-bus-search` and `italian-bus-search-mcp` executables.

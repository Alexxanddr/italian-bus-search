# MCP interface

This document is the authoritative contract for the local Model Context Protocol interface.

## Transport and lifecycle

The server uses MCP over stdio. A host starts `dist/mcp/stdio.js`, sends protocol messages on stdin, and reads responses from stdout. Diagnostics use stderr so they cannot corrupt the protocol stream.

The server is read-only. It exposes search tools and never logs in, books, selects a seat, collects customer data, or pays a provider. Closing stdin ends the transport; `SIGINT` closes it gracefully.

## Typical flow

For a request such as “find buses from Rome to Milan on 15 November,” the host model should:

1. call `search_locations` for the origin and destination;
2. choose IDs or exact names from the returned provider locations;
3. call `search_journeys` with a real future date in `YYYY-MM-DD` format;
4. present the returned journeys and official `bookingUrl` values to the user.

Natural-language interpretation belongs to the host model, not this server.

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

## Results and errors

Every successful tool call contains both compact text for display and `structuredContent` matching the advertised output schema. A provider failure remains in the `errors` array when another provider succeeds.

Invalid input, an unknown provider, or a process-local search limit violation returns an MCP tool result with `isError: true`. Upstream bodies, stack traces, cookies, and credentials are never included.

## Limits

`search_locations` and `search_journeys` share a process-local allowance of 60 calls per minute for each MCP server instance. `list_providers` is exempt. The provider adapters retain their own successful-result caches and five-second upstream timeouts.

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

The npm package remains private and has not been published. Its future executable name is `italian-bus-search-mcp`.

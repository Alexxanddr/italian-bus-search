# Italian Travel Search

<!-- mcp-name: io.github.Alexxanddr/italian-travel-search -->

[![CI](https://github.com/Alexxanddr/italian-travel-search/actions/workflows/ci.yml/badge.svg)](https://github.com/Alexxanddr/italian-travel-search/actions/workflows/ci.yml)

An unofficial, read-only TypeScript service for live Italian coach and train searches through HTTP and Model Context Protocol interfaces.

The project hides provider-specific station catalogs, request formats, fare structures, and multi-leg responses behind one shared application core. Italo pricing initializes an anonymous technical session and temporary planning resource; customer login, fare selection, seat reservation, and payment are excluded.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by Itabus, Autoservizi Salemi, Autolinee Federico, MarinoBus, or FlixBus. Provider names and trademarks belong to their owners. Before enabling a live adapter, confirm that your use complies with the provider's terms, applicable law, and any required authorization. This repository does not grant data-extraction or redistribution rights.

## Features

- One response model for locations and journeys across different booking platforms.
- Live adapters for five bus operators and two train operators.
- Partial results when one provider fails and another succeeds.
- MCP over local stdio or stateless Streamable HTTP at `/mcp`, with backward-compatible bus tools and separate rail tools.
- Trenitalia and Italo station and journey searches directly from their live booking APIs.
- Official links for continuing a search manually on provider sites.
- Structured, provider-scoped errors instead of leaked upstream responses.
- Finite upstream request timeouts and bounded asynchronous quote polling.
- One-hour location caches and 60-second journey caches.
- Opt-in immutable journey pagination with five-minute in-memory snapshots, shared by HTTP and MCP.
- Per-client in-memory rate limiting at 60 requests per minute.
- Offline tests with synthetic fixtures; the test suite never contacts provider sites.
- A small runtime dependency surface: the official MCP SDK and Zod.

## Supported providers

| Provider ID | Operator | Integration | Locations | Journeys |
|---|---|---|---|---|
| `itabus` | Itabus | Demandware endpoints | Live | Live |
| `salemi` | Autoservizi Salemi | Albatross tenant | Live | Live |
| `federico` | Autolinee Federico | Albatross tenant | Live | Live |
| `marinobus` | MarinoBus | Albatross tenant | Live | Live |
| `flixbus` | FlixBus | Global FlixBus search API | Live | Live |

Public provider behavior and limitations are documented in the bus and train API guides below.

Train stations, journeys, prices and availability come directly from Trenitalia and Italo booking APIs. No timetable download, dataset, storage volume or initialization command is required. If one operator fails, its error is reported alongside the other operator's results. ViaggiaTreno and Italo live boards/standalone status remain independent; Italo quote sessions are cleaned up best-effort.

## Requirements

- Node.js 22.18 or newer
- npm

## Quick start

```sh
git clone https://github.com/Alexxanddr/italian-travel-search.git
cd italian-travel-search
npm install
cp .env.example .env
npm start
```

The server listens on `http://127.0.0.1:3000` by default.

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/providers
curl http://127.0.0.1:3000/train-providers
curl 'http://127.0.0.1:3000/locations?query=Roma&provider=marinobus'
```

For journey searches, use a real future date:

```sh
curl 'http://127.0.0.1:3000/journeys?origin=Roma&destination=Milano&date=YYYY-MM-DD&adults=1&children=0&provider=marinobus'
```

`YYYY-MM-DD` is a placeholder and must be replaced before running the command.

## HTTP interface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Process liveness |
| `GET` | `/providers` | Adapter status and operational reason |
| `GET` | `/train-providers` | Train operators and configured schedule/price/live capabilities |
| `GET` | `/locations` | Provider location search |
| `GET` | `/journeys` | Normalized one-way journey search |
| `GET` | `/train-locations` | Trenitalia/Italo station search |
| `GET` | `/train-journeys` | Live rail journeys, availability and nullable prices |
| `GET` | `/train-status` | Standalone live status where enabled |
| `GET` | `/station-board` | Live arrivals/departures where enabled |
| `POST` | `/mcp` | Stateless MCP Streamable HTTP endpoint |

`/locations` and `/journeys` accept an optional `provider` parameter. Without it, all providers are queried independently and successful data is preserved alongside provider-scoped errors.

The complete contract is split into the [Bus API](docs/api-bus.md) and [Train API](docs/api-trains.md), with shared behavior indexed in [HTTP API](docs/api.md).

## MCP server

The simplest MCP configuration runs the published package directly with `npx`:

```json
{
  "mcpServers": {
    "italian-travel-search": {
      "command": "npx",
      "args": ["-y", "italian-travel-search@latest"]
    }
  }
}
```

Alternatively, build and start the local stdio server:

```sh
npm run build
npm run mcp:built
```

The existing `list_providers`, `search_locations`, and `search_journeys` bus tools remain compatible. Location and journey searches accept optional `offset`/`limit`; increment `offset` by `limit` until `truncated` is false to retrieve every page. Rail adds `list_train_providers`, `search_train_locations`, `search_train_journeys`, `get_train_status`, and `get_station_board`. Trenitalia and Italo price and live adapters are enabled; Italo live tools retain date-unverified semantics.

For exhaustive journey searches, start with `snapshot: true` and continue
with only the returned `searchId`, `offset` and `limit`. This keeps
prices, errors, order and totals identical across pages. Expired IDs require
a new search. The same opt-in flow exists over HTTP; see
[stable pagination](docs/api.md#stable-journey-pagination-bus-and-train).

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

For a container or remote MCPHub deployment, start the HTTP process and point the client to `http://italian-travel-search:3000/mcp`. The container image is `ghcr.io/alexxanddr/italian-travel-search:latest`. No dataset initialization or persistent volume is needed.

See [MCP interface](docs/mcp.md) for the authoritative tool contract, limits, errors, and development command.

## Architecture

The application has four layers:

1. HTTP and MCP adapters validate their transport-specific requests;
2. shared validation and `SearchService` orchestrate searches and partial results;
3. each provider adapter translates a remote protocol into domain types;
4. the domain module owns normalized data and error contracts.

Provider adapters implement one shared interface, so callers do not know whether a result came from Itabus Demandware or an Albatross tenant. See [Architecture](docs/architecture.md) for modules, seams, data flow, caches, and test strategy.

## Development

```sh
npm run dev
npm run mcp
npm run check
```

`npm run check` runs the complete offline test suite, TypeScript type checking, and the configured lint check. To add an operator, follow [Adding a provider](docs/adding-provider.md); do not infer a new integration from HTML alone or copy credentials into fixtures.

## Deployment

The default server deliberately binds to loopback and keeps rate-limit and cache state in process memory. Read [Operations](docs/operations.md) before placing it behind a reverse proxy or running multiple replicas.

## Project documentation

- [HTTP API](docs/api.md) — shared behavior and error contract.
- [Bus API](docs/api-bus.md) — bus providers, locations, journeys, and examples.
- [Train API](docs/api-trains.md) — rail schedules, live prices/status, provenance, and examples.
- [MCP interface](docs/mcp.md) — authoritative tools, results, limits, and transport contract.
- [Architecture](docs/architecture.md) — modules, seams, flows, and design decisions.
- [Adding a provider](docs/adding-provider.md) — research, implementation, and verification checklist.
- [Operations](docs/operations.md) — configuration, deployment constraints, and failure handling.
- [Glossary](GLOSSARY.md) — stable project terminology.
- [Contributing](CONTRIBUTING.md) — local workflow and pull-request expectations.
- [Security policy](SECURITY.md) — private vulnerability reporting and supported versions.
- [Agent instructions](AGENTS.md) — compact routing instructions for coding agents.

## Scope and limitations

- Searches are one-way only.
- Availability is a provider-reported signal, not a seat or price guarantee.
- Prices and schedules can change between search and purchase; rail results expose live observation and source metadata. The legacy field name `timetableSource` is retained for compatibility.
- Caches and rate limits reset when the process restarts and are not shared across replicas.
- Upstream interfaces are unofficial and can change without notice.
- Both interfaces intentionally exclude accounts, bookings, payments, and CAPTCHA handling.

Always complete and confirm a purchase on the official provider site linked by `bookingUrl`.

## Contributing and security

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not through a public issue.

## License

Source code is available under the [MIT License](LICENSE). The license covers this repository's code, not third-party data, provider trademarks, or access rights to upstream systems.

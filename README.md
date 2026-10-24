# Italian Bus Search

[![CI](https://github.com/Alexxanddr/italian-bus-search/actions/workflows/ci.yml/badge.svg)](https://github.com/Alexxanddr/italian-bus-search/actions/workflows/ci.yml)

An unofficial, read-only TypeScript service that searches multiple Italian coach operators and returns one normalized journey format through an HTTP API.

The project hides provider-specific station catalogs, request formats, fare structures, and multi-leg responses behind four small HTTP endpoints. It uses only Node.js at runtime and never performs login, booking, seat selection, or payment operations.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by Itabus, Autoservizi Salemi, Autolinee Federico, or MarinoBus. Provider names and trademarks belong to their owners. Before enabling a live adapter, confirm that your use complies with the provider's terms, applicable law, and any required authorization. This repository does not grant data-extraction or redistribution rights.

## Features

- One response model for locations and journeys across different booking platforms.
- Live adapters for four operators.
- Partial results when one provider fails and another succeeds.
- Structured, provider-scoped errors instead of leaked upstream responses.
- Five-second upstream timeouts.
- One-hour location caches and 60-second journey caches.
- Per-client in-memory rate limiting at 60 requests per minute.
- Offline tests with synthetic fixtures; the test suite never contacts provider sites.
- No runtime dependencies.

## Supported providers

| Provider ID | Operator | Integration | Locations | Journeys |
|---|---|---|---|---|
| `itabus` | Itabus | Demandware endpoints | Live | Live |
| `salemi` | Autoservizi Salemi | Albatross tenant | Live | Live |
| `federico` | Autolinee Federico | Albatross tenant | Live | Live |
| `marinobus` | MarinoBus | Albatross tenant | Live | Live |

Provider behavior and the evidence behind each integration are recorded in [Provider research](docs/research.md).

## Requirements

- Node.js 22.18 or newer
- npm

## Quick start

```sh
git clone https://github.com/Alexxanddr/italian-bus-search.git
cd italian-bus-search
npm install
cp .env.example .env
npm start
```

The server listens on `http://127.0.0.1:3000` by default.

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/providers
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
| `GET` | `/locations` | Provider location search |
| `GET` | `/journeys` | Normalized one-way journey search |

`/locations` and `/journeys` accept an optional `provider` parameter. Without it, all providers are queried independently and successful data is preserved alongside provider-scoped errors.

The complete parameter, response, status, and error contract is in [HTTP interface](docs/api.md).

## Architecture

The application has four layers:

1. the Node HTTP adapter validates requests and returns JSON;
2. `SearchService` fans searches out across providers and combines partial results;
3. each provider adapter translates a remote protocol into domain types;
4. the domain module owns normalized data and error contracts.

Provider adapters implement one shared interface, so callers do not know whether a result came from Itabus Demandware or an Albatross tenant. See [Architecture](docs/architecture.md) for modules, seams, data flow, caches, and test strategy.

## Development

```sh
npm run dev
npm run check
```

`npm run check` runs the complete offline test suite, TypeScript type checking, and the configured lint check. To add an operator, follow [Adding a provider](docs/adding-provider.md); do not infer a new integration from HTML alone or copy credentials into fixtures.

## Deployment

The default server deliberately binds to loopback and keeps rate-limit and cache state in process memory. Read [Operations](docs/operations.md) before placing it behind a reverse proxy or running multiple replicas.

## Project documentation

- [HTTP interface](docs/api.md) — authoritative endpoint and error contract.
- [Architecture](docs/architecture.md) — modules, seams, flows, and design decisions.
- [Adding a provider](docs/adding-provider.md) — research, implementation, and verification checklist.
- [Operations](docs/operations.md) — configuration, deployment constraints, and failure handling.
- [Provider research](docs/research.md) — primary-source evidence and known limitations.
- [Glossary](GLOSSARY.md) — stable project terminology.
- [Contributing](CONTRIBUTING.md) — local workflow and pull-request expectations.
- [Security policy](SECURITY.md) — private vulnerability reporting and supported versions.
- [Agent instructions](AGENTS.md) — compact routing instructions for coding agents.

## Scope and limitations

- Searches are one-way only.
- Availability is a provider-reported signal, not a seat or price guarantee.
- Prices and schedules can change between search and purchase.
- Caches and rate limits reset when the process restarts and are not shared across replicas.
- Upstream interfaces are unofficial and can change without notice.
- The API intentionally excludes accounts, bookings, payments, and CAPTCHA handling.

Always complete and confirm a purchase on the official provider site linked by `bookingUrl`.

## Contributing and security

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not through a public issue.

## License

Source code is available under the [MIT License](LICENSE). The license covers this repository's code, not third-party data, provider trademarks, or access rights to upstream systems.

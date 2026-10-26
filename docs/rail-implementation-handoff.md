# Rail implementation handoff

## Objective

Extend `italian-travel-search` into a read-only multimodal Italian journey service while preserving its current TypeScript architecture, provider isolation, partial-result behavior, HTTP API, MCP server, offline test strategy, and manual purchase flow.

The first rail release must support:

- scheduled Trenitalia and Italo journeys;
- live Trenitalia and Italo train/station status where the source can identify the service date reliably;
- live prices and saleability when a validated quote source exists;
- official links for manual purchase;
- separate MCP tools for bus and rail searches, with a later optional multimodal aggregate tool.

Do not redesign the application around the examined Python repositories. Implement native TypeScript providers behind the existing application seams.

## Required reading

Read these files before changing code:

1. `AGENTS.md`
2. `docs/architecture.md`
3. `docs/adding-provider.md`
4. `docs/mcp.md`

This file is the single source of truth for rail feasibility, evidence, implementation order, and completion criteria.

## Non-negotiable boundaries

- Keep one repository and one MCP server.
- Keep bus providers and their public contracts backward compatible.
- Separate rail schedule, quote, and live-status capabilities internally.
- Keep purchase, cart, login, payment, ticket issuance, cancellation, and refund flows out of scope.
- Treat prices as volatile observations, never as timetable attributes.
- Expose source and freshness for schedule, price, and live data.
- Preserve partial results when one operator or capability fails.
- Use synthetic fixtures in automated tests; keep live probes manual or isolated from CI.
- Reimplement protocols independently. Do not copy AGPL code from `api-mcp-trenitalia` or GPL code from `pyviaggiatreno` into this MIT repository.

## Source and capability map

| Capability | Trenitalia | Italo | Confidence |
|---|---|---|---|
| Stations and planned schedules | CCISS/Italian NAP NeTEx | CCISS/Italian NAP NeTEx | High |
| Priced journey quotes | lefrecce public BFF, subject to authorization and stability review | Public booking funnel observed in browser; protocol still must be mapped and validated | Trenitalia medium; Italo incomplete |
| Live train status and station boards | ViaggiaTreno public protocol | Italo In Viaggio public portal | Trenitalia high technically; Italo medium until protocol capture |
| Booking continuation | Official Trenitalia search link | Official Italo booking funnel | Link format must be verified |

Before enabling any unofficial live adapter, record the exact endpoint, request/response fixture, authentication/session requirements, rate-limit behavior, terms decision, and date of verification in `docs/research.md` or a dedicated provider note.

## Research evidence and licences

| Source | Evidence used | Licence / authority |
|---|---|---|
| [`Fanfulla/MCP_Trenitalia`](https://github.com/Fanfulla/MCP_Trenitalia/tree/99d84e3ef67e074acee1c2fea0090223a64d3139) | NeTEx architecture for both operators, schedule/live separation, coverage and freshness rules | MIT code; upstream datasets retain their own terms |
| [`jesuscurreripa/api-mcp-trenitalia`](https://github.com/jesuscurreripa/api-mcp-trenitalia) | lefrecce station lookup and priced quote protocol | AGPL-3.0; unofficial BFF use |
| [`matteoredaelli/pyviaggiatreno`](https://github.com/matteoredaelli/pyviaggiatreno) | Trenitalia boards and live train status protocol | GPL-3.0; unofficial ViaggiaTreno use |
| [Italian NAP / CCISS dataset catalog](https://www.cciss.it/nap/mmtis/public/en/catalog/Dataset) | Trenitalia and Italo NeTEx schedules, stops, calendars and service data | Official/public timetable source; verify dataset terms |
| [Italo In Viaggio](https://italoinviaggio.italotreno.com/it/) | Public train monitoring and station boards | Official public web portal; HTTP contract undocumented |
| [Italo booking funnel](https://biglietti.italotreno.com/it/booking/ricerca) | Browser-observed station autocomplete and public quote flow | Official public web funnel; quote protocol not yet captured |

Read these projects for interoperability evidence only. Reimplement every enabled protocol independently in TypeScript. The licences do not grant rights to carrier datasets or responses.

### Trenitalia priced quote evidence

`api-mcp-trenitalia` documents this public lefrecce BFF:

```text
Base: https://www.lefrecce.it/Channels.Website.BFF.WEB/website
GET  /locations/search?name=<text>&limit=<n>
POST /ticket/solutions
```

The quote request contains departure/arrival location IDs, ISO-8601 departure time, passenger counts and criteria such as `frecceOnly`, `regionalOnly`, `noChanges`, ordering, limit and offset. The response mapper observes journey identity, endpoints, times, duration, train category/number, saleability, `price.amount`, and currency. The upstream page size is normally 10 and whole-day search requires bounded pagination and deduplication.

This is a volatile dated quote, not a tariff catalogue. Store no longer than necessary, attach `observedAt`, preserve upstream saleability, and never substitute it for a mismatched NeTEx itinerary. The reference reports no login or API key, but also warns that programmatic use may be restricted by lefrecce terms; independently verify both protocol and authorization.

### Trenitalia live evidence

`pyviaggiatreno` documents this public protocol:

```text
Base: http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/
GET /autocompletaStazione/<prefix>
GET /partenze/<stationCode>/<dateTime>
GET /arrivi/<stationCode>/<dateTime>
GET /andamentoTreno/<originStationCode>/<trainNumber>/<serviceDayEpochMs>
```

Expect `S` station codes, service-day epoch milliseconds, HTTP 204 for missing records, and mixed JSON/text responses. A train number alone is not a stable identity: require operator, service date, origin station, and train number. This source supplies operational status, stops, delays, and boards, never fares.

### Italo evidence and remaining discovery

The NAP/CCISS catalog verifies static Italo NeTEx L1/L2 datasets for stops, stations, lines, routes, calendars, services, and timetables. “Tickets” catalog metadata is not a purchasable live fare and must not be mapped to `price`.

The official Italo In Viaggio portal visibly offers train monitoring and arrival/departure boards. The examined reference reports that service date cannot always be proven, so unmatched observations must remain `freshness: "date_unverified"` rather than being attached to a dated journey.

A browser test verified that the official booking funnel anonymously autocompletes and selects `Roma Termini` and `Milano Centrale`, accepts date and passenger inputs, and starts a quote search. The user observed priced solution results in the normal browser flow. The JSON request/response, session/cookie requirements, fare schema, stable deep-link format, rate behavior, and terms decision remain Phase 0 work; do not guess them from the UI.

### Known limitations from the references

- `MCP_Trenitalia` searches direct services from local feeds; transfer routing requires separate, explicit work.
- Its purchase links are official homepages rather than proven filtered deep links.
- ViaggiaTreno and Italo In Viaggio are live operational sources, not fare engines.
- Public availability is evidence of technical accessibility, not authorization or a stability contract.

## Target domain model

Do not force rail-only semantics into the existing bus `Journey`. Introduce rail types while keeping the shared fields recognizable.

```ts
type TransportMode = "bus" | "train";

type RailJourney = {
  provider: "trenitalia" | "italo";
  journeyId: string;
  origin: { id: string; name: string };
  destination: { id: string; name: string };
  departure: string;
  arrival: string;
  durationMinutes: number;
  changes: number;
  legs: RailLeg[];
  available: boolean | null;
  price: RailPrice | null;
  bookingUrl?: string;
  timetableSource: DataSource;
  liveStatus?: RailLiveStatus;
};

type RailPrice = {
  amount: number;
  currency: string;
  fareName?: string;
  travelClass?: string;
  observedAt: string;
  source: string;
};
```

Define `RailLeg`, `DataSource`, and `RailLiveStatus` only with fields proven necessary by fixtures. A missing delay means unknown, not on time. A missing price remains `null`.

## Provider boundaries

Use small capability-specific adapters composed by the rail search service:

```text
trenitalia-schedule  -> NeTEx schedules and coverage
trenitalia-quote     -> dated price and saleability quote
trenitalia-live      -> train status and station boards

italo-schedule       -> NeTEx schedules and coverage
italo-quote          -> dated price and saleability quote
italo-live           -> train status and station boards
```

Schedule providers may use local persisted datasets. Quote and live providers need bounded timeouts, short successful-result caches, safe response-size limits, and provider-scoped errors. A quote may enrich a scheduled journey only when operator, stations, legs, and times match sufficiently to avoid attaching a fare to the wrong itinerary.

## MCP contract

Add rail tools without renaming or changing existing bus tools:

| Tool | Purpose |
|---|---|
| `search_train_locations` | Resolve operator-aware station names and IDs |
| `search_train_journeys` | Return scheduled rail journeys with optional prices and source metadata |
| `get_train_status` | Return live status for operator, train number, service date, and origin identity |
| `get_station_board` | Return live arrivals or departures with an observation timestamp |

Keep `search_journeys` as the existing bus search during the first rail milestone. Design a later multimodal aggregate tool only after rail semantics and result size are validated with Hermes.

Tool descriptions must tell agents:

- names are preferred for cross-provider searches;
- station IDs are provider-specific;
- price and live status can be unavailable independently of the schedule;
- every displayed purchase link must come from `bookingUrl`;
- `total`, `truncated`, and provider errors must be preserved.

## Delivery sequence

### Phase 0 — protocol evidence

1. Freeze representative synthetic fixtures for both NeTEx feeds.
2. Verify the Trenitalia quote protocol independently from the AGPL implementation.
3. Complete a browser-only Italo search and capture the public quote request/response contract without login or purchase.
4. Map Italo In Viaggio requests for one train and one station board.
5. Record authorization/terms decisions for each non-NeTEx source.

Complete when every enabled adapter has an endpoint inventory, fixture, failure cases, and explicit source classification. If Italo quote or live protocol remains unverified, keep that capability disabled rather than blocking schedule delivery.

### Phase 1 — rail domain and schedule providers

1. Add rail domain schemas and validation.
2. Add NeTEx dataset download/update, validation, atomic replacement, and coverage reporting.
3. Implement native Trenitalia and Italo schedule adapters.
4. Add offline parser, calendar, overnight, DST, ambiguity, and coverage tests.

Complete when both operators return deterministic scheduled journeys from fixtures and fail closed outside verified coverage.

### Phase 2 — Trenitalia quote and live enrichment

1. Add the independently implemented lefrecce quote adapter if approved.
2. Add ViaggiaTreno status and station-board adapters.
3. Join prices/live data without changing the underlying schedule identity.
4. Add schema-drift, timeout, partial-failure, stale-data, and no-price tests.

Complete when a Trenitalia journey may carry a correctly sourced price and live status while either enrichment can fail without removing the schedule result.

### Phase 3 — Italo quote and live enrichment

1. Implement only protocols verified in Phase 0.
2. Apply the same price identity, freshness, cache, timeout, and error rules as Trenitalia.
3. Preserve `serviceDate: null` and `freshness: "date_unverified"` when the live source cannot prove the operating date.

Complete when Italo results have parity with Trenitalia for every verified capability; unsupported capabilities remain explicitly nullable and documented.

### Phase 4 — HTTP, MCP, documentation, and release

1. Add rail HTTP endpoints only if they reuse the same service and schemas as MCP.
2. Register the four rail MCP tools and cover structured output validation.
3. Update README, architecture, API/MCP documentation, operations, provider research, changelog, and server metadata.
4. Run the full offline suite, type checking, build, package dry-run, audit, and one bounded manual live smoke test per enabled live source.
5. Publish only after package and `server.json` versions match.

Complete when a clean installation can answer scheduled train search, quote availability, train status, and station board requests without regressing existing bus searches.

## Error and freshness contract

Reuse existing application error codes where they fit and add rail-specific distinctions only when callers can act differently. At minimum distinguish:

- unknown or ambiguous station;
- timetable coverage missing or expired;
- quote unavailable versus no saleable journey;
- live status unavailable versus train not found;
- incompatible upstream response;
- provider timeout/rate limit.

Every remote observation includes `observedAt`. Every local schedule result includes dataset publication/validity metadata. Never silently replace missing live or fare data with zero, empty text, or an inferred “on time”.

## Test matrix

- unit parsing for each source fixture;
- exact and ambiguous station resolution;
- service calendars, exceptions, overnight journeys, and DST boundaries;
- direct and multi-leg journeys;
- unavailable and non-saleable quotes;
- price matching to the correct itinerary;
- train identity by operator + number + service date + origin;
- stale and date-unverified live data;
- provider partial failure;
- HTTP and MCP output-schema conformance;
- result limits, ordering, `total`, and `truncated`;
- booking links remain manual and provider-owned;
- all existing bus tests remain green.

## Explicit non-goals for the first implementation

- booking or payment;
- user accounts and loyalty cards;
- seat selection;
- refunds or ticket management;
- fare prediction;
- inferred prices;
- a generic journey-planning engine that invents cross-operator connections;
- BlaBlaCar integration.

## Start prompt for a new implementation chat

```text
PONYTAIL MODE ACTIVE — level: full

Agisci come un principal software engineer specializzato in TypeScript, MCP, integrazioni di trasporto, modellazione di dati temporali e adapter resilienti verso API esterne.

Lavora nel repository software/italian-travel-search e implementa il piano descritto in docs/rail-implementation-handoff.md. Prima di modificare codice leggi integralmente AGENTS.md e tutti i documenti indicati nella sezione “Required reading”. L'architettura TypeScript esistente, i provider isolati, i risultati parziali, i test offline e la compatibilità dei tool bus sono vincoli, non suggerimenti.

Inizia dalla Phase 0. Non copiare codice dai repository Python analizzati: usa le fonti solo come documentazione di interoperabilità e reimplementa nativamente. Non abilitare una capacità Italo o Trenitalia finché endpoint, fixture, requisiti di sessione, errori e decisione di autorizzazione non sono documentati. Mantieni prezzi e live status opzionali e con provenienza/freshness esplicite.

Procedi autonomamente fase per fase, esegui i test proporzionati al rischio e fermati soltanto se serve una scelta dell'utente che cambia materialmente il prodotto o un'autorizzazione esterna non già concessa. Alla fine consegna implementazione, documentazione, test, rischi residui e istruzioni di deployment/pubblicazione. Non pubblicare né distribuire finché il repository non è verificato e l'utente non lo richiede esplicitamente.
```

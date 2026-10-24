# FlixBus provider feasibility

## Decision

A native `flixbus` provider is **technically feasible** for the repository's existing anonymous location and journey-search contract. The observed FlixBus JSON endpoints provide stable city UUIDs, station names, dated trips, availability status, durations, prices and enough data to build an official booking deep link. They did not require login, cookies, CAPTCHA or an API key in the tested flow.

The recommendation is a **conditional go**: implement an independent adapter against the observed protocol only after the intended deployment has reviewed FlixBus terms and accepted the stability and redistribution risk. Do not copy code from `adambenhassen/flixbus-mcp`: its repository contained no licence file at the revision reviewed.

The research resulted in the native `src/providers/flixbus.ts` adapter, registered in the default provider set and covered by synthetic tests. It remains read-only and returns `price: null` when FlixBus omits a fee-inclusive total.

## Scope and primary sources

Research was performed on 2026-10-25 using only:

- the target repository's [`Provider`](../src/providers/provider.ts), [domain model](../src/domain.ts), [default registry](../src/providers/default.ts) and [provider workflow](adding-provider.md);
- [`adambenhassen/flixbus-mcp`](https://github.com/adambenhassen/flixbus-mcp/tree/ac6e2c7a1f1581c6522ab229130570969b36646f) at immutable commit `ac6e2c7a1f1581c6522ab229130570969b36646f` (`v0.1.0`): its [HTTP client](https://github.com/adambenhassen/flixbus-mcp/blob/ac6e2c7a1f1581c6522ab229130570969b36646f/internal/flixbus/client.go), [wire types](https://github.com/adambenhassen/flixbus-mcp/blob/ac6e2c7a1f1581c6522ab229130570969b36646f/internal/flixbus/types.go), [city resolution](https://github.com/adambenhassen/flixbus-mcp/blob/ac6e2c7a1f1581c6522ab229130570969b36646f/internal/tools/resolve.go), [normalization](https://github.com/adambenhassen/flixbus-mcp/blob/ac6e2c7a1f1581c6522ab229130570969b36646f/internal/tools/tools.go), [client tests](https://github.com/adambenhassen/flixbus-mcp/blob/ac6e2c7a1f1581c6522ab229130570969b36646f/internal/flixbus/client_test.go), [tool tests](https://github.com/adambenhassen/flixbus-mcp/blob/ac6e2c7a1f1581c6522ab229130570969b36646f/internal/tools/tools_test.go) and [fixture](https://github.com/adambenhassen/flixbus-mcp/blob/ac6e2c7a1f1581c6522ab229130570969b36646f/internal/flixbus/testdata/search_berlin_munich.json);
- two read-only autocomplete calls and two read-only search calls to `https://global.api.flixbus.com` (the second search repeated the first because the local output filter failed). No purchase, login or customer-data mutation was attempted.

The upstream README describes the endpoint as a public, unofficial API without a contract and warns that it may change. Technical accessibility is not evidence of permission for every deployment or for storage/redistribution of prices and availability.

## Observed anonymous protocol

### City lookup

```http
GET https://global.api.flixbus.com/search/autocomplete/cities?q={query}&lang={ISO-639-1}
Accept: application/json
User-Agent: {descriptive client identifier}
```

The response contains city objects with `id` (UUID), `name`, `country`, `is_flixbus_city`, `has_train_station` and coordinates. The adapter should retain only `is_flixbus_city: true` candidates. A lookup for `Roma` returned the exact Italian city UUID `40de90ff-8646-11e6-9066-549f350fcb0c` alongside non-exact candidates such as Roman and Rome airports. A lookup for `Milano` returned `40ddcc6e-8646-11e6-9066-549f350fcb0c` for Milano, Italy. Selecting the first fuzzy result would therefore be unsafe.

### Journey search

```http
GET https://global.api.flixbus.com/search/service/v4/search
  ?from_city_id={origin UUID}
  &to_city_id={destination UUID}
  &departure_date={DD.MM.YYYY}
  &products={URL-encoded JSON}
  &currency=EUR
  &locale=it_IT
  &search_by=cities
  &include_after_midnight_rides=1
Accept: application/json
User-Agent: {descriptive client identifier}
```

For the target model, `products` represents `adult`, `children` and zero `bike_slot`; zero-valued optional fields may be omitted as the upstream client does. Its configuration supports an optional `X-Api-Key`, but neither its default path nor the live requests required one. No session bootstrap, cookie, authorization header or browser state was required.

The response has top-level `trips[]`, plus `cities` and `stations` maps keyed by ID. Each trip has a `results` map. Each result exposes `uid`, `status`, `transfer_type`, departure/arrival date and city/station IDs, duration, price totals, and available seats/bike slots. The top-level `platform_fee_in_price_required` determines whether `price.total_with_platform_fee`, instead of `price.total`, is the customer-facing amount.

A Roma-to-Milano search for 2026-11-10 returned 33 results. The first was an available direct journey from Roma Tiburtina at `2026-11-10T00:15:00+01:00` to Milano Sesto S.G. at `09:00`, duration 8 h 45 min, with base price EUR 12.99 and fee-inclusive price EUR 13.98. The fee flag was `true`, so EUR 13.98 is the appropriate normalized price. A later result was a transfer journey, confirming that flattening must not assume direct services only.

### Booking continuation

The upstream implementation constructs the official continuation URL:

```text
https://shop.flixbus.com/search?departureCity={origin UUID}&arrivalCity={destination UUID}&rideDate={DD.MM.YYYY}&adult={n}&children={n}&bike_slot=0&currency=EUR
```

This is suitable for `Journey.bookingUrl`; values must be URL-encoded and passenger counts must match the search. The adapter must not automate any subsequent booking step.

## Mapping to the target domain

| Target field | FlixBus source | Rule |
| --- | --- | --- |
| `Location.provider` | adapter identity | Constant `flixbus`. |
| `Location.id` | city `id` | Preserve the UUID as opaque. |
| `Location.name`, `city` | city `name` | Use the provider display name. |
| `Location.address` | absent from city lookup | Omit. |
| `Location.source` | live lookup | `live`. |
| `Journey.tripId` | result `uid` | Preserve as opaque. |
| `origin` / `destination` | `station_id` + `stations[id].name` | Use station IDs/names so distinct terminals remain visible. |
| `departure`, `arrival` | result date strings | Require parseable RFC 3339 timestamps; preserve offsets. |
| `durationMinutes` | `duration.hours`, `duration.minutes` | `hours * 60 + minutes`, with finite non-negative integers. |
| `available` | result `status` | `true` only for `available`; seat count cannot be preserved separately. |
| `price.amount` | price totals + fee flag | Use `total_with_platform_fee` when required, otherwise `total`; never substitute zero for absent required data. |
| `price.currency` | request currency | `EUR` initially. |
| `fare` | no equivalent | Omit; `transfer_type` is not a fare class. |
| `bookingUrl` | official shop deep link | Build from city UUIDs, date and passengers. |

`searchLocations` can return all filtered live candidates. `searchJourneys` should accept a provider UUID directly or perform an exact case-insensitive city-name match. A missing match maps to `UNKNOWN_LOCATION`; multiple exact matches must fail explicitly rather than silently choosing one. Flatten all `trips[].results` entries and sort by departure time.

The upstream MCP exposes details the target domain does not: direct/transfer classification, remaining seats, bike slots, selectable locale/currency and a result limit. These are not blockers for the current contract, but exact feature parity would require a deliberate domain and public API extension. The smallest initial integration should keep fixed `it_IT`/`EUR`, send no bikes and avoid speculative schema changes.

## Error, timeout and cache behavior

An independent adapter can follow existing repository patterns with no new runtime dependency:

- inject the fetch function for offline tests;
- use the repository's finite request timeout (currently five seconds in native providers);
- cache only successful city and journey responses with bounded TTLs;
- map HTTP 429 to `RATE_LIMITED`, other upstream/network/timeout failures to `PROVIDER_UNAVAILABLE`, unresolved names to `UNKNOWN_LOCATION`, and invalid JSON or missing required fields to `INCOMPATIBLE_RESPONSE`;
- never expose an upstream body or internal exception details;
- when a trip requires a platform fee but lacks `total_with_platform_fee`, retain the journey with `price: null` rather than quoting the lower base fare or failing other valid results.

The reviewed upstream client caps response bodies at 8 MiB and uses a configurable 30-second timeout. A native adapter should retain a finite body-size defense where practical while following the target's shorter timeout policy.

## Risks and gates

| Risk | Impact | Mitigation / gate |
| --- | --- | --- |
| Uncontracted endpoint and schema drift | Paths or response fields can change without notice. | Isolate wire types in one adapter, validate at runtime, fail closed, use fixtures and an opt-in live smoke check. |
| Terms and redistribution not established here | Technical success does not establish permission to operate or republish price/availability data. | Review current FlixBus terms for the actual deployment before enabling; record retention/redistribution constraints. |
| No licence file in the reviewed upstream tree | Copying its Go source may lack permission. | Reimplement independently from the observed protocol; do not translate or copy code/fixtures verbatim. |
| Mandatory platform fees | Using `total` can understate the payable amount. | Branch on the top-level flag; when the checkout total is absent, expose `price: null` and preserve the journey. |
| Ambiguous city names | A first-result heuristic can search the wrong country/city. | Exact normalized match or UUID for journey resolution; expose candidates via location search. |
| Data exceeds current domain | Seat counts, transfers and bikes are lost. | Document the loss; make any public-domain expansion a separate design decision. |
| Large/malformed responses | Memory pressure or misleading output. | Bound size, validate maps and every emitted result. |
| Rate limiting or blocking | Provider outage. | Low volume, bounded success-only caches, descriptive user agent and structured errors; preserve aggregate partial success. |

## Test plan

Automated tests must use injected fetch and small synthetic fixtures, never FlixBus live traffic.

1. Assert autocomplete path, escaped query, `lang=it`, headers, filtering and UUID preservation.
2. Cover UUID resolution, unique exact case-insensitive name, unknown name and ambiguous exact name; prove that a fuzzy first candidate is not selected.
3. Assert search date conversion, passenger JSON, `EUR`, `it_IT`, city mode and after-midnight flag.
4. Cover multiple trip/result map entries, station lookup, offsets, chronological sorting, direct/transfer responses and booking URL.
5. Cover both platform-fee branches and missing required fee-inclusive price.
6. Cover invalid JSON/schema, missing station/date/duration, HTTP 429, other non-2xx, timeout, network failure and oversized response; assert no body leakage.
7. Prove successful calls are cached, failures are not, and cache keys contain all output-affecting inputs.
8. When implemented, update tests for `createDefaultProviders()`, HTTP `/providers`, MCP `list_providers`, aggregate partial failure and result limits without network calls.

After the authorization gate, run one opt-in live check on a public-site route and future date, including one adult-plus-child request if appropriate. Confirm location resolution, at least one normalized journey or legitimate empty result, fee-inclusive price, booking URL and absence of authentication. Do not commit raw responses.

## Recommended implementation boundary

If authorization is cleared, add a dedicated `src/providers/flixbus.ts` adapter rather than extending the Albatross or Itabus protocols. Register it in `createDefaultProviders()` and add synthetic adapter tests plus HTTP/MCP default-provider updates. Update the provider table and operational/research documentation in the same implementation change.

No new package is necessary. Use platform `fetch`, `AbortSignal.timeout`, target `AppError` codes and aggregate partial-success semantics. The first version should implement only anonymous locations, journeys, normalized availability/price and the official booking continuation. Login, booking, payment, seat selection, CAPTCHA handling, API-key discovery and signature work are out of scope.

**Final recommendation:** proceed with a small native adapter only after terms/redistribution review. The mapping is straightforward and was live-verified at low volume, but production readiness depends more on authorization and upstream stability than on implementation complexity.

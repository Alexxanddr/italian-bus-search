# Adding a provider

Use this workflow for a new operator or a material protocol change. The completion condition is a registered adapter with offline coverage, low-volume live evidence, current documentation, and no secrets in the repository.

## 1. Establish authorization and scope

Before implementation:

- confirm that live access is authorized for the intended deployment;
- review the provider's official terms, robots policy, and technical documentation;
- constrain the integration to anonymous location and journey search;
- identify whether prices or availability may be stored or redistributed.

Record primary-source evidence and unresolved questions in a gitignored `docs/private/*.hide.md` note. Authorization for one deployment does not automatically apply to downstream users.

## 2. Identify the protocol

Prefer official documentation. If the public booking client is the only technical source, inspect its public configuration and static client code, then verify the minimum anonymous request with a small number of read-only calls.

Classify the provider:

- **Existing protocol:** add configuration to the existing adapter when request and response shapes genuinely match.
- **New protocol:** add one adapter that implements `Provider`; keep all protocol-specific types, parsing, and errors inside it.

Do not implement login, booking, payment, seat selection, CAPTCHA handling, or a client-side signature unless it is both necessary for authorized anonymous search and explicitly approved.

## 3. Capture a safe fixture

Create the smallest synthetic fixture that preserves the response structure needed by the parser. It must contain:

- stable invented trip IDs;
- representative stops and datetimes;
- a representative price or explicit missing price;
- multi-leg data when the provider supports transfers;
- no cookies, tokens, credentials, request signatures, or personal data.

Store it under `test/fixtures/`.

## 4. Add the adapter

The adapter must:

- expose a stable lowercase `id`;
- implement `searchLocations` and `searchJourneys`;
- resolve journeys by exact location name or provider ID;
- use `AbortSignal.timeout` or an equivalent finite timeout;
- cache only successful data with bounded lifetimes;
- validate required upstream fields before returning domain objects;
- translate network failures, throttling, invalid JSON, and incompatible schemas into `AppError`;
- return an official booking page in `bookingUrl` when available.

If adding an Albatross tenant, extend `ProviderConfig`, add a thin configured subclass, and reuse the shared parser. Add a new parser only when a captured response proves the schema differs.

## 5. Register it

Add the adapter to `createDefaultProviders()` in `src/providers/default.ts`. Update the provider expectations in HTTP and MCP tests and the supported-provider table in the README.

## 6. Test through public seams

Add tests that prove:

- fixture normalization;
- location and journey requests through an injected fetcher;
- provider headers, parameters, and passenger body when applicable;
- caching avoids duplicate upstream calls;
- unknown locations and incompatible responses use structured errors;
- the default `/providers` response exposes the adapter as intended.
- `list_providers` exposes the adapter without contacting its upstream system.
- journey results carry a verified official `bookingUrl` or a documented official fallback.

Automated tests must not contact the network.

## 7. Verify live behavior

With authorization, perform one low-volume search on a route and future date shown by the provider's public site. Verify:

- location resolution;
- at least one normalized journey or a legitimate no-journey response;
- departure, arrival, duration, availability, and price;
- adult and child passenger mapping when supported;
- no login, purchase, or customer-data mutation occurred.

Add dated, non-sensitive findings to a gitignored `docs/private/*.hide.md` note. Do not commit raw captures.

## 8. Finish

```sh
npm run check
npm audit --audit-level=high
git diff --check
```

Review [api.md](api.md), [architecture.md](architecture.md), [operations.md](operations.md), the README, and the glossary for affected claims. The provider is complete only when code, tests, and documentation describe the same behavior.

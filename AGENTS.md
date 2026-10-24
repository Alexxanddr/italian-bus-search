# Agent guide

This repository is an unofficial, read-only aggregator for Italian coach journeys. Preserve the normalized HTTP interface and keep remote integrations low-impact.

## Start here

1. Read [docs/architecture.md](docs/architecture.md) before structural changes.
2. Read [docs/api.md](docs/api.md) when changing validation, response shapes, status codes, or errors.
3. Read [docs/adding-provider.md](docs/adding-provider.md) and [docs/research.md](docs/research.md) for provider work.
4. Read [docs/operations.md](docs/operations.md) when changing configuration, networking, caches, rate limiting, or deployment behavior.

## Invariants

- The application is read-only: search locations and journeys only.
- Login, booking, seat selection, payment, and CAPTCHA flows are outside scope.
- Every provider satisfies `src/providers/provider.ts`; callers depend only on that interface.
- Preserve successful provider data when another provider fails.
- Validate every upstream response before normalizing it.
- Remote calls keep a finite timeout and successful-result cache.
- Automated tests are offline. Inject `fetch` and use synthetic fixtures without secrets or personal data.
- Live verification is manual, authorized, low-volume, and documented in `docs/research.md`.
- Error responses never expose upstream bodies, credentials, cookies, or stack traces.

## Change map

- Domain or error shape: `src/domain.ts`, all adapters, tests, `docs/api.md`.
- HTTP behavior: `src/app.ts`, `test/api.test.ts`, `docs/api.md`, possibly `docs/operations.md`.
- Provider orchestration: `src/search.ts`, `test/search.test.ts`, `docs/architecture.md`.
- Itabus protocol: `src/providers/itabus.ts`, `test/itabus.test.ts`, its fixture, `docs/research.md`.
- Albatross protocol or tenants: `src/providers/albatross.ts`, `test/albatross.test.ts`, its fixture, `docs/research.md`.
- New provider: follow `docs/adding-provider.md` and register it in `src/app.ts`.

## Verification

Run:

```sh
npm run check
npm audit --audit-level=high
git diff --check
```

A provider change is complete when its parser and request path are covered through an injected fetcher, aggregate behavior still passes, public documentation is current, and no captured secret or personal datum exists in the tree.

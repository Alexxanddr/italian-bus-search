# Agent guide

This repository is an unofficial, read-only aggregator for Italian coach and live rail journeys. Preserve the normalized HTTP and MCP interfaces and keep remote integrations low-impact.

## Start here

1. Read [docs/architecture.md](docs/architecture.md) before structural changes.
2. Read [docs/api.md](docs/api.md) when changing validation, response shapes, status codes, or errors.
3. Read [docs/mcp.md](docs/mcp.md) when changing tools, schemas, structured results, stdio, or MCP limits.
4. Read [docs/adding-provider.md](docs/adding-provider.md) for provider work and any available local notes under `docs/private/*.hide.md`.
5. Read [docs/operations.md](docs/operations.md) when changing configuration, networking, caches, rate limiting, or deployment behavior.

## Invariants

- The application is read-only: search locations and journeys only.
- Customer login, seat selection, payment, and CAPTCHA flows are outside scope. Italo's authorized anonymous technical session and temporary quote-planning resource are permitted and require best-effort cleanup.
- Every provider satisfies `src/providers/provider.ts`; callers depend only on that interface.
- Preserve successful provider data when another provider fails.
- Validate every upstream response before normalizing it.
- Remote calls keep a finite timeout and successful-result cache.
- Automated tests are offline. Inject `fetch` and use synthetic fixtures without secrets or personal data.
- Live verification is manual, authorized, low-volume, and documented in a gitignored `docs/private/*.hide.md` note.
- Error responses never expose upstream bodies, credentials, cookies, or stack traces.
- MCP stdout carries protocol messages only; diagnostics use stderr.

## Change map

- Domain or error shape: `src/domain.ts`, all adapters, tests, `docs/api.md`.
- Shared input validation or rate limiting: `src/validation.ts`, `src/rate-limit.ts`, both adapters, tests, `docs/api.md`, `docs/mcp.md`.
- HTTP behavior: `src/app.ts`, `test/api.test.ts`, `docs/api.md`, possibly `docs/operations.md`.
- MCP behavior: `src/mcp/`, `test/mcp.test.ts`, `docs/mcp.md`, possibly `docs/operations.md`.
- Provider orchestration: `src/search.ts`, `test/search.test.ts`, `docs/architecture.md`.
- Itabus protocol: `src/providers/itabus.ts`, `test/itabus.test.ts`, its fixture, and local provider research notes.
- Albatross protocol or tenants: `src/providers/albatross.ts`, `test/albatross.test.ts`, its fixture, and local provider research notes.
- Default provider registration: `src/providers/default.ts`, default-provider tests, README.
- New provider: follow `docs/adding-provider.md` and register it in `src/providers/default.ts`.

## Verification

Run:

```sh
npm run check
npm run build
npm audit --audit-level=high
git diff --check
```

A provider change is complete when its parser and request path are covered through an injected fetcher, aggregate behavior still passes, public documentation is current, and no captured secret or personal datum exists in the tree.

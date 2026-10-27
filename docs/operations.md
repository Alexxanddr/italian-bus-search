# Operations

## Runtime configuration

The HTTP listener configuration values are `HOST` and `PORT`.

```sh
HOST=127.0.0.1 PORT=3000 npm start
```

`PORT` must be an integer from 1 through 65535. `HOST` defaults to `127.0.0.1`; the container sets it to `0.0.0.0` and must remain reachable only through the cluster-internal Service.

Rail discovery and journeys use live booking APIs. No dataset files, NAP downloads,
`*_NETEX_PATH` variables, update command or persistent volume are required.
Existing retained volumes can remain detached for rollback; do not delete their
data as part of migration.

A host starts the compiled stdio entrypoint:

```sh
npm run build
node dist/mcp/stdio.js
```

The host owns the process lifetime. stdin and stdout carry MCP; diagnostics use stderr. Closing stdin ends the connection, and `SIGINT` closes it gracefully.

## Outbound connectivity

The process needs HTTPS access to the provider hosts configured in source code:

- `app.itabus.it`
- `global.api.flixbus.com`
- `api.autoservizisalemi.it`
- `api.autolineefederico.it`
- `api.marinobus.it`
- `www.lefrecce.it`
- `www.viaggiatreno.it` (HTTP, as used by the official client)
- `italoinviaggio.italotreno.com`
- `biglietti.italotreno.com`
- `api-biglietti.italotreno.com`

Client input and environment variables cannot choose an outbound URL.

Provider URLs are not supplied by clients. DNS, TLS, timeout, non-success status, and JSON failures become structured provider errors.

## Health and readiness

`GET /health` is a liveness check for the local process. It does not call providers and must not be interpreted as upstream readiness.

Use `GET /providers` to inspect configured adapter status, but note that it also performs no remote probe. If deployment requires readiness based on providers, build it as a separate, rate-limited mechanism rather than changing liveness into a fan-out request.

## Caches

Successful bus journeys and rail quote observations are cached for 60 seconds. Locations, destination catalogs, Albatross stop labels and fare categories are cached for one hour. Caches:

- live only in process memory;
- are not shared between replicas;
- reset on restart;
- have no manual invalidation interface;
- do not cache failures.

Keyed provider caches have a maximum of 128 entries each and evict expired or oldest entries. HTTP and MCP share the same provider adapters in the deployed process; stateless MCP exchanges do not reset caches.

Multiple replicas can therefore produce more upstream traffic than one replica and may return data observed at slightly different times.

Legacy offset pagination does not pin a snapshot. Prefer the opt-in
`snapshot: true` flow for exhaustive journey searches: a shared HTTP/MCP
store retains serialized, immutable results for five minutes, at most 32
entries of 1 MiB each (at most 32 MiB serialized payload, plus runtime
overhead). Capacity eviction, expiry and restart return SEARCH_EXPIRED.
Errors and empty responses are frozen too; start a new search to retry.
Redis and other persistent/shared databases are not used.

## Rate limiting

Each `createApp` instance permits 60 requests per client identifier per minute. `/health` is exempt so provider traffic cannot fail liveness/readiness probes. The Node server uses `request.socket.remoteAddress` as that identifier.

Behind a reverse proxy, all requests may appear to originate from the proxy and share one limit. The application does not trust forwarded headers. A public deployment should enforce client-aware limits at the trusted edge or add an explicitly reviewed proxy-trust model.

The limiter is process-local and is not a distributed abuse-control system.

Each MCP handler permits 60 combined bus and rail search/status calls per minute across HTTP exchanges. Both provider-list tools are exempt because they perform no network requests. The MCP request-body limit is 64 KiB; text inputs are limited to 200 characters.

## Failure behavior

- A bus timeout or network error becomes `PROVIDER_UNAVAILABLE`; rail booking and live failures use `QUOTE_UNAVAILABLE` and `LIVE_STATUS_UNAVAILABLE`.
- Upstream HTTP 429 becomes `RATE_LIMITED` for that provider.
- Invalid JSON or a schema mismatch becomes `INCOMPATIBLE_RESPONSE`.
- A failure from one provider does not discard another provider's successful data.
- Rail booking failure returns no journeys for that operator and an explicit error; successful operators remain.
- A successful empty journey search returns HTTP 200 with `NO_JOURNEYS`; HTTP 503 is reserved for empty results containing another provider failure.
- A successful empty booking response stays empty; no timetable combinations are generated.
- Optional Albatross stop-catalog failure preserves priced journeys with their search-locality labels and IDs; no address is fabricated.
- Trenitalia searches stop at the requested local day; reaching the 100-solution safety bound returns an explicit `QUOTE_UNAVAILABLE` instead of silently reporting a complete live set.

Use the `errors` array for provider-level diagnosis. The application intentionally omits upstream bodies and stack traces.

## Logging and observability

The HTTP process logs its listening address and non-health request completion events to stderr (`method`, route path, status, duration in milliseconds). Query strings, headers, bodies, credentials and upstream exception text are omitted. MCP protocol failures emit a fixed safe diagnostic. There are no metrics, tracing, remote health probes or persistent audit storage.

For an internet-facing deployment, add observability at a trusted reverse proxy first. Avoid logging full query strings if future parameters could contain customer data.

## Shutdown and scaling

On `SIGINT`/`SIGTERM`, the HTTP process stops accepting connections and drains requests for at most 20 seconds. The stdio process allows five seconds for transport cleanup. The existing single-replica `Recreate` deployment still has an interruption during rollout; it no longer waits for timetable initialization.

Keep one replica while snapshots are process-local. A different replica
cannot resume another process's searchId and returns SEARCH_EXPIRED.
Shared storage is required before enabling snapshot pagination across
multiple replicas. Cache and limiter state are also process-local.

The stdio server is intended for one local host connection. `/mcp` is stateless and intended for a private service network; authentication and public ingress are deliberately absent.

## Deployment checklist

- Confirm provider authorization and redistribution terms for the deployment.
- Run `npm run build`; no rail initialization is necessary.
- Keep the application private or place it behind a trusted TLS reverse proxy.
- Apply edge rate limiting and request-size limits.
- Restrict outbound traffic to required provider hosts.
- Run `npm run check` and `npm audit --audit-level=high` from a clean checkout.
- For MCP, build first and configure the host to execute the absolute `dist/mcp/stdio.js` path.
- For container MCP, start the image directly and use `/mcp` over the cluster-internal Service. No dataset mount or init container is needed.
- Monitor provider error codes and response latency.
- Do not inject provider credentials; current adapters require none.
- Revalidate live schemas after any `INCOMPATIBLE_RESPONSE` increase.
- After a tool-schema change, reconnect only `italian-travel-search` in MCPHub
  (dashboard or authenticated `POST /api/servers/italian-travel-search/reload`).
  Then inspect MCPHub's `tools/list` and perform a paginated call. A successful
  upstream rollout alone does not refresh the gateway's cached input schemas.

The container workflow rebuilds on runtime/build-file changes. Documentation
and test-only commits do not replace `latest` or trigger an unnecessary rollout.


## Manual live smoke test

After `npm ci` and `npm run build`, start the local server on port 3099 and run:

```sh
HOST=127.0.0.1 PORT=3099 node dist/index.js
# In another terminal, set SMOKE_DATE to a real future date:
HTTP_BASE_URL=http://127.0.0.1:3099 SMOKE_DATE=YYYY-MM-DD node scripts/live-smoke.mjs
```

For MCPHub, set `MCP_URL` to its configured endpoint and supply the key through
`MCPHUB_API_KEY` from a secret manager, or `--token-stdin` with terminal echo
disabled. Never put the token in command arguments or source files. The script
tests all eight tools, rail pagination, both operators' boards/status and real
prices; legitimate provider failures remain visible in its JSON output.

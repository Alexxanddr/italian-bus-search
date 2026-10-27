# Operations

## Runtime configuration

The HTTP listener configuration values are `HOST` and `PORT`.

```sh
HOST=127.0.0.1 PORT=3000 npm start
```

`PORT` must be an integer from 1 through 65535. `HOST` defaults to `127.0.0.1`; the container sets it to `0.0.0.0` and must remain reachable only through the cluster-internal Service.

Rail schedules are opt-in local files:

| Variable | Meaning |
|---|---|
| `TRENITALIA_NETEX_PATH` | Optional cache override; defaults to `data/trenitalia-timetable.json.gz` |
| `ITALO_NETEX_PATH` | Optional cache override; defaults to `data/italo-timetable.json.gz` |

The update command downloads the two reviewed public `checkedResource` distributions directly from allowlisted `https://www.cciss.it` URLs. It parses gzip/XML as a stream, writes a compact validated JSON gzip cache, and atomically replaces the previous cache. Schedule searches fail closed outside dataset validity. Generated caches remain local and are ignored by Git.

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

`npm run rail:update` additionally needs access to `www.cciss.it`. Client input and environment variables cannot choose an outbound URL.

Provider URLs are not supplied by clients. DNS, TLS, timeout, non-success status, and JSON failures become structured provider errors.

## Health and readiness

`GET /health` is a liveness check for the local process. It does not call providers and must not be interpreted as upstream readiness.

Use `GET /providers` to inspect configured adapter status, but note that it also performs no remote probe. If deployment requires readiness based on providers, build it as a separate, rate-limited mechanism rather than changing liveness into a fan-out request.

## Caches

Successful bus journeys and rail quote observations are cached for 60 seconds. Locations, destination catalogs, and Albatross fare categories are cached for one hour. Caches:

- live only in process memory;
- are not shared between replicas;
- reset on restart;
- have no manual invalidation interface;
- do not cache failures.

Keyed provider caches have a maximum of 128 entries each and evict expired or oldest entries. HTTP and MCP share the same provider adapters in the deployed process; stateless MCP exchanges do not reset caches or reload timetables. A failed initial timetable load is retried on the next request.

Multiple replicas can therefore produce more upstream traffic than one replica and may return data observed at slightly different times.

## Rate limiting

Each `createApp` instance permits 60 requests per client identifier per minute. `/health` is exempt so provider traffic cannot fail liveness/readiness probes. The Node server uses `request.socket.remoteAddress` as that identifier.

Behind a reverse proxy, all requests may appear to originate from the proxy and share one limit. The application does not trust forwarded headers. A public deployment should enforce client-aware limits at the trusted edge or add an explicitly reviewed proxy-trust model.

The limiter is process-local and is not a distributed abuse-control system.

Each MCP handler permits 60 combined bus and rail search/status calls per minute across HTTP exchanges. Both provider-list tools are exempt because they perform no network requests. The MCP request-body limit is 64 KiB; text inputs are limited to 200 characters.

## Failure behavior

- A schedule provider timeout or network error becomes `PROVIDER_UNAVAILABLE`; quote and live failures use `QUOTE_UNAVAILABLE` and `LIVE_STATUS_UNAVAILABLE`.
- Upstream HTTP 429 becomes `RATE_LIMITED` for that provider.
- Invalid JSON or a schema mismatch becomes `INCOMPATIBLE_RESPONSE`.
- A failure from one provider does not discard another provider's successful data.
- Quote failure does not remove a scheduled rail journey; it remains with `price: null` and a provider-scoped error.
- A successful empty journey search returns HTTP 200 with `NO_JOURNEYS`; HTTP 503 is reserved for empty results containing another provider failure.
- Live rail quotes are attempted even if the NeTEx cache is missing or expired; timetable errors remain explicit alongside successful quotes.
- A failed timetable load falls back to live station discovery, with `source: live` and the schedule error preserved.
- A successful empty quote response returns no theoretical timetable combinations.
- Trenitalia searches stop at the requested local day; reaching the 100-solution safety bound returns an explicit `QUOTE_UNAVAILABLE` instead of silently reporting a complete live set.

Use the `errors` array for provider-level diagnosis. The application intentionally omits upstream bodies and stack traces.

## Logging and observability

The HTTP process logs its listening address and non-health request completion events to stderr (`method`, route path, status, duration in milliseconds). Query strings, headers, bodies, credentials and upstream exception text are omitted. MCP protocol failures emit a fixed safe diagnostic. There are no metrics, tracing, remote health probes or persistent audit storage.

For an internet-facing deployment, add observability at a trusted reverse proxy first. Avoid logging full query strings if future parameters could contain customer data.

## Shutdown and scaling

On `SIGINT`/`SIGTERM`, the HTTP process stops accepting connections and drains requests for at most 20 seconds. The stdio process allows five seconds for transport cleanup. The existing single-replica `Recreate` deployment still has an interruption during rollout and timetable initialization.

Horizontal scaling is stateless from a correctness perspective, but cache and limiter state are independent per replica. Account for the resulting upstream request multiplication.

The stdio server is intended for one local host connection. `/mcp` is stateless and intended for a private service network; authentication and public ingress are deliberately absent.

## Deployment checklist

- Confirm provider authorization and redistribution terms for the deployment.
- Run `npm run build && npm run rail:update`; optionally set the two `*_NETEX_PATH` overrides before both update and runtime.
- Keep the application private or place it behind a trusted TLS reverse proxy.
- Apply edge rate limiting and request-size limits.
- Restrict outbound traffic to required provider hosts.
- Run `npm run check` and `npm audit --audit-level=high` from a clean checkout.
- For MCP, build first and configure the host to execute the absolute `dist/mcp/stdio.js` path.
- For container MCP, initialize the two caches with `node dist/rail/update.js`, mount them at the configured paths, and use `/mcp` over the cluster-internal Service.
- Monitor provider error codes and response latency.
- Do not inject provider credentials; current adapters require none.
- Revalidate live schemas after any `INCOMPATIBLE_RESPONSE` increase.

NeTEx updates validate every redirect before contacting the destination. Compressed downloads are limited to 64 MiB, decoded XML to 512 MiB, and XML depth to 128; document-type declarations are rejected. Runtime gzip cache decoding is limited to 128 MiB and validates cache fields and chronological stop times before use.

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

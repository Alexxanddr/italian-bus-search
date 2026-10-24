# Operations

## Runtime configuration

The only configuration value is `PORT`.

```sh
PORT=3000 npm start
```

`PORT` must be an integer from 1 through 65535. The server binds to `127.0.0.1`; exposing it outside the host requires an explicitly configured reverse proxy or a source change reviewed as a security-sensitive operation.

## Outbound connectivity

The process needs HTTPS access to the provider hosts configured in source code:

- `app.itabus.it`
- `api.autoservizisalemi.it`
- `api.autolineefederico.it`
- `api.marinobus.it`

Provider URLs are not supplied by clients. DNS, TLS, timeout, non-success status, and JSON failures become structured provider errors.

## Health and readiness

`GET /health` is a liveness check for the local process. It does not call providers and must not be interpreted as upstream readiness.

Use `GET /providers` to inspect configured adapter status, but note that it also performs no remote probe. If deployment requires readiness based on providers, build it as a separate, rate-limited mechanism rather than changing liveness into a fan-out request.

## Caches

Successful journeys are cached for 60 seconds. Locations, destination catalogs, and Albatross fare categories are cached for one hour. Caches:

- live only in process memory;
- are not shared between replicas;
- reset on restart;
- have no manual invalidation interface;
- do not cache failures.

Multiple replicas can therefore produce more upstream traffic than one replica and may return data observed at slightly different times.

## Rate limiting

Each `createApp` instance permits 60 requests per client identifier per minute. The Node server uses `request.socket.remoteAddress` as that identifier.

Behind a reverse proxy, all requests may appear to originate from the proxy and share one limit. The application does not trust forwarded headers. A public deployment should enforce client-aware limits at the trusted edge or add an explicitly reviewed proxy-trust model.

The limiter is process-local and is not a distributed abuse-control system.

## Failure behavior

- A provider timeout or network error becomes `PROVIDER_UNAVAILABLE`.
- Upstream HTTP 429 becomes `RATE_LIMITED` for that provider.
- Invalid JSON or a schema mismatch becomes `INCOMPATIBLE_RESPONSE`.
- A failure from one provider does not discard another provider's successful data.
- If no journey exists and provider errors are present, `/journeys` returns HTTP 503.

Use the `errors` array for provider-level diagnosis. The application intentionally omits upstream bodies and stack traces.

## Logging and observability

The current process logs only its listening address. It has no structured request logs, metrics, tracing, remote health probes, or persistent audit trail.

For an internet-facing deployment, add observability at a trusted reverse proxy first. Avoid logging full query strings if future parameters could contain customer data.

## Shutdown and scaling

There is no custom graceful-shutdown handler. Process termination relies on Node.js and the supervisor. Before zero-downtime production use, add bounded connection draining and verify it with the target orchestrator.

Horizontal scaling is stateless from a correctness perspective, but cache and limiter state are independent per replica. Account for the resulting upstream request multiplication.

## Deployment checklist

- Confirm provider authorization and redistribution terms for the deployment.
- Keep the application private or place it behind a trusted TLS reverse proxy.
- Apply edge rate limiting and request-size limits.
- Restrict outbound traffic to required provider hosts.
- Run `npm run check` and `npm audit --audit-level=high` from a clean checkout.
- Monitor provider error codes and response latency.
- Do not inject provider credentials; current adapters require none.
- Revalidate live schemas after any `INCOMPATIBLE_RESPONSE` increase.

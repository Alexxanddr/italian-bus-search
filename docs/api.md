# HTTP API

The read-only HTTP API is split by transport mode:

- [Bus API](api-bus.md) — providers, stop resolution, journeys, prices, and booking links.
- [Train API](api-trains.md) — Trenitalia/Italo stations, journeys, live prices, status, and station boards.

Both APIs return JSON and use ISO 8601 timestamps. Unknown routes return
`404`; unsupported methods return `405`. Requests are limited to 60 per client
identifier in each process-local minute. `GET /health` returns
`{"status":"ok"}` without contacting any provider.

`/health` is exempt from the request limit. Input text is trimmed and limited
to 200 characters. Search dates must be after today's date in `Europe/Rome`,
independently of the host timezone. An empty successful search returns `200`
with `NO_JOURNEYS`; upstream failure with no journeys returns `503`.

Provider failures are isolated. Aggregate responses preserve successful data
and add safe entries to `errors`; upstream bodies, cookies, tokens, and stack
traces are never returned.

```json
{
  "provider": "trenitalia",
  "code": "QUOTE_UNAVAILABLE",
  "message": "Trenitalia quote request failed"
}
```

Common error codes are `INVALID_INPUT`, `UNKNOWN_LOCATION`, `NO_JOURNEYS`,
`PROVIDER_UNAVAILABLE`, `INCOMPATIBLE_RESPONSE`, and `RATE_LIMITED`. Rail also
uses `AMBIGUOUS_LOCATION`, `COVERAGE_UNAVAILABLE`, `QUOTE_UNAVAILABLE`,
`LIVE_STATUS_UNAVAILABLE`, and `TRAIN_NOT_FOUND`.

MCP exposes the same services through `/mcp`; see [MCP interface](mcp.md) for
tool names, pagination, and structured output.

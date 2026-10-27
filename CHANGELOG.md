# Changelog

All notable changes will be documented here. Releases follow Semantic Versioning.

## 0.3.4 - 2026-10-27

- Share provider caches and the search budget across stateless MCP exchanges and HTTP adapters.
- Add compatible offset pagination to bus journeys and location searches.
- Bound keyed caches, upstream body reads, MCP payloads and NeTEx decoding/redirects.
- Keep live rail quotes and station discovery available when timetables fail and respect successful empty quotes.
- Convert XML journey and pattern records during parsing to reduce NeTEx import memory.
- Correct boarding dates and connections across midnight, Italian date validation, missing prices and station-ID reuse.
- Drain connections on shutdown, exempt liveness from throttling and emit safe request diagnostics.
- Derive the MCP runtime version from package metadata and verify private-file exclusions before publishing.
- Test supported Node 22/24 and current Node 26 in CI.
- Avoid container rebuilds for documentation/test-only commits and document MCPHub schema reloads.

## 0.3.3 - 2026-10-27

- Accept Italo NeTEx station IDs directly in live station-board requests.
- Resolve a unique dated Trenitalia status record when callers only know a journey-leg origin.
- Keep public provider documentation aligned with private research-note conventions.
- Exclude local private research notes from npm package contents.

## 0.3.2 - 2026-10-26

- Renamed the npm package, MCP Registry identity, executable, server, deployment, and documentation to `italian-travel-search`.

## 0.3.1 - 2026-10-26

- Updated repository, issue tracker, documentation, and container image references after the GitHub repository rename to `italian-travel-search`.

## 0.3.0 - 2026-10-26

- Added stateless MCP Streamable HTTP at `/mcp` while preserving stdio.
- Added a non-root OCI image and automated GHCR publishing.
- Documented container initialization of the authorized NAP timetable caches.
- Made successful Trenitalia and Italo booking searches authoritative, preserving live multi-change solutions and removing theoretical unquoted combinations.
- Split the HTTP contract into detailed bus and train guides with examples and upstream protocol inventories.

## 0.2.0 - 2026-10-25

- Added opt-in local NeTEx schedule search for Trenitalia and Italo with source coverage metadata.
- Added five rail MCP tools while preserving all existing bus contracts.
- Enabled verified Italo live boards and standalone date-unverified status.
- Added exact-match Trenitalia lefrecce quote enrichment and ViaggiaTreno train/board adapters with partial-failure behavior.
- Added Italo anonymous planning-session quote enrichment, exact timetable matching, official search links, and best-effort temporary-resource cleanup.

## 0.1.9 - 2026-10-25

- Sort aggregate journeys globally before applying the result limit.
- Use the maximum result limit by default (`50`) for HTTP and MCP searches.

## 0.1.8 - 2026-10-25

- Added a native FlixBus provider with normalized locations, journeys, prices, and booking links.

## 0.1.7 - 2026-10-24

- Clarified aggregate MCP searches must use shared location names because location IDs are provider-specific.

## 0.1.6 - 2026-10-24

- Fixed MCPHub output validation by removing provider-internal location fields from structured MCP results.

## 0.1.5 - 2026-10-24

- Fixed GitHub Actions trusted publishing by using npm 11.5.1 or newer.
- Updated the release actions and official MCP Registry publisher.

## 0.1.2 - 2026-10-24

- Bumped version to `0.1.2` after `0.1.1`.
- Aligned `server.json` version and description length (<= 100 characters) for official MCP Registry validation.

## 0.1.0 - 2026-10-24

- Initial public release of the API and MCP server.
- Read-only normalized journey and location search for Itabus, Autoservizi Salemi, Autolinee Federico, and MarinoBus.
- Local stdio MCP server support (`list_providers`, `search_locations`, `search_journeys`).
- MIT License, public repository metadata, and automated npm/MCP Registry publishing.

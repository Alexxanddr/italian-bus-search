# Changelog

All notable changes will be documented here. Releases follow Semantic Versioning.

## Unreleased

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

- Initial public release of `italian-bus-search` API and MCP server.
- Read-only normalized journey and location search for Itabus, Autoservizi Salemi, Autolinee Federico, and MarinoBus.
- Local stdio MCP server support (`list_providers`, `search_locations`, `search_journeys`).
- MIT License, public repository metadata, and automated npm/MCP Registry publishing.

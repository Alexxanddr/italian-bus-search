# Rail source acquisition in the reference repositories

Research date: 25 October 2026.

This note answers one narrow question: how the repositories cited by the rail handoff actually obtain their data. It describes their behavior; it does not import their code or establish authorization for another deployment.

## `Fanfulla/MCP_Trenitalia`

Verified at commit [`99d84e3ef67e074acee1c2fea0090223a64d3139`](https://github.com/Fanfulla/MCP_Trenitalia/tree/99d84e3ef67e074acee1c2fea0090223a64d3139).

The repository does not require users to discover or configure NeTEx URLs. It checks in [`data/sources.json`](https://github.com/Fanfulla/MCP_Trenitalia/blob/99d84e3ef67e074acee1c2fea0090223a64d3139/data/sources.json) with these official CCISS download endpoints:

| Operator | Download | Catalog |
|---|---|---|
| Trenitalia | `https://www.cciss.it/nap/mmtis/public/api/v1/download/blob/Asset/1080596/checkedResource` | [Asset 1080596](https://www.cciss.it/nap/mmtis/public/catalog/Asset/1080596), dataset 1077621 |
| Italo | `https://www.cciss.it/nap/mmtis/public/api/v1/download/blob/Asset/1814124/checkedResource` | [Dataset 1813935](https://www.cciss.it/nap/mmtis/public/catalog/Dataset/1813935) |

The user runs `python update_data.py`. [`update_data.py`](https://github.com/Fanfulla/MCP_Trenitalia/blob/99d84e3ef67e074acee1c2fea0090223a64d3139/update_data.py):

- accepts only HTTPS URLs on `www.cciss.it`, including redirects;
- downloads both sources anonymously, with no account, API key, cookie or session initialization;
- limits the compressed download to 64 MiB and the operation to 120 seconds;
- detects gzip by magic bytes;
- passes the stream to the native NeTEx converter;
- validates the converted cache and atomically replaces the old cache only on success.

[`build_timetable.py`](https://github.com/Fanfulla/MCP_Trenitalia/blob/99d84e3ef67e074acee1c2fea0090223a64d3139/build_timetable.py) parses the official Italian-profile XML with a streaming parser. It resolves `StopPlace`, `PassengerStopAssignment`, `ServiceJourneyPattern`, lines, passing times, UIC calendar bits, day-type assignments, explicit exceptions, boarding/alighting restrictions and overnight offsets. It writes validated compressed JSON caches (`data/timetable.json.gz` and `data/timetable_italo.json.gz`).

The generated caches are deliberately not committed. The [README](https://github.com/Fanfulla/MCP_Trenitalia/blob/99d84e3ef67e074acee1c2fea0090223a64d3139/README.md) instructs users to run `python update_data.py`, reports missing/expired coverage without crashing live tools, and recommends scheduled refreshes. Runtime schedule searches use the local caches, not the CCISS endpoint directly.

The source metadata records an important distinction: the Trenitalia catalog reports `No licence - No contract`, while the Italo redistribution licence remains unverified. The reference therefore treats public downloading as technically anonymous but does not claim that its MIT licence covers or grants redistribution rights for the data.

## `jesuscurreripa/api-mcp-trenitalia`

Verified at commit [`501ac231ee11b152c7b2bccd1696e5c7a7b752c7`](https://github.com/jesuscurreripa/api-mcp-trenitalia/tree/501ac231ee11b152c7b2bccd1696e5c7a7b752c7).

This project does not use NeTEx. [`app/trenitalia.py`](https://github.com/jesuscurreripa/api-mcp-trenitalia/blob/501ac231ee11b152c7b2bccd1696e5c7a7b752c7/app/trenitalia.py) calls the lefrecce BFF directly:

- base `https://www.lefrecce.it/Channels.Website.BFF.WEB/website`;
- `GET /locations/search` for stations;
- `POST /ticket/solutions` for dated, priced and saleability-aware solutions;
- no API key or login in the implementation;
- no local timetable dataset; every search calls the BFF.

Its own README warns that programmatic BFF use may violate the provider's terms. Its AGPL code and live response behavior are not substitutes for an authorization decision in this MIT repository.

## `matteoredaelli/pyviaggiatreno`

Verified at commit [`cb74d09322074cc91b1c1ea4e8fb885a203dede6`](https://github.com/matteoredaelli/pyviaggiatreno/tree/cb74d09322074cc91b1c1ea4e8fb885a203dede6).

This project also does not use NeTEx. [`ViaggiaTrenoClient`](https://github.com/matteoredaelli/pyviaggiatreno/blob/cb74d09322074cc91b1c1ea4e8fb885a203dede6/packages/viaggiatreno/src/viaggiatreno/api/client.py) calls the undocumented public ViaggiaTreno REST service at `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno`. Its client covers station autocomplete, station lists/details, arrivals, departures and current train status. It is a live operational source, not a planned timetable or fare source.

## Consequence for this repository

The two user-supplied `*_NETEX_URL` values introduced in the first implementation are unnecessary configuration. The closest verified reference behavior is to keep the two reviewed CCISS URLs in source-controlled provenance metadata, expose one update command, download anonymously from the allowlisted official host, validate, and atomically retain local runtime caches. Only the cache paths need runtime defaults or overrides.

This does not authorize quote or live adapters. It only resolves how the official static timetable feeds are located and refreshed. The license/redistribution caveat must remain explicit, and generated source data should remain outside the npm package and Git repository.

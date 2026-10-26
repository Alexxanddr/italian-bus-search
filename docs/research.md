# Provider research

Research date: 24 October 2026.

## Rail evidence — 26 October 2026

- The official Italian NAP catalog lists Trenitalia NeTEx Level 1 and Italo NeTEx Level 1/2 datasets containing stops, calendars, routes, services, and timetables.
- The verified public `checkedResource` downloads are Asset 1080596 for Trenitalia and Asset 1814124 for Italo. The updater fixes these URLs in source and accepts redirects only within the official CCISS host. The data remain local because public download does not establish redistribution rights.
- Trenitalia lefrecce quotes and ViaggiaTreno live requests were independently reverified on 25 October 2026 and enabled for the owner's authorized deployment context. After the owner explicitly expanded scope, the Italo anonymous planning operation was independently captured and enabled for prices; it creates a temporary `/api/v1/booking/{id}` resource that the adapter deletes best-effort. Browser and adapter tests cover one adult and one-adult/one-child searches. Fare selection and purchase remain excluded. Italo In Viaggio status and boards remain enabled.
- Synthetic fixtures model only the NeTEx fields consumed by the native TypeScript parser. They contain invented IDs and no captured carrier response, credential, cookie, or personal data.
- Official homepages are used only as manual booking fallbacks; no unverified pre-filled deep link is emitted.

Rail capability classification: schedules are local official-dataset observations with publication/validity metadata; a successful Trenitalia or Italo booking response is authoritative for current journey availability and passenger-total prices. Exact train/time matches enrich NeTEx results, while additional booking solutions are normalized from their reported legs; if quoting fails, the NeTEx result survives with `price: null` and an explicit error. Italo live observations are standalone and date-unverified. Public website availability and the repository owner's instruction are not represented as carrier authorization or redistribution rights.

Live regression verification on 26 October 2026 returned 24 Trenitalia booking
solutions for Roma Termini–Cosenza on 30 October 2026, all 24 with prices and
up to four changes. Italo returned 33 Roma Termini–Milano Centrale solutions
for 10 November 2026, all 33 with prices. These observations are examples, not
availability guarantees.

This document separates observed evidence from inference. No login, purchase, payment, CAPTCHA bypass, credential, or high-volume request was used.

## Decision

All four integrations were enabled after the user explicitly confirmed authorized live access on 24 October 2026. This authorization is specific to the current deployment context; downstream users must obtain their own permission. Remote calls use finite five- or eight-second request timeouts, with a bounded 20-second Italo asynchronous polling window, and in-memory caches. They perform no customer login, purchase, payment, or CAPTCHA action.

Trainline was reviewed only as a possible future authorized quote source. Its official Global API is a partner product requiring commercial onboarding and integration support, while its published business terms forbid scraping or direct API access without prior written consent. No Trainline adapter, site scraping, or undocumented endpoint was added.

## Observed evidence

### Itabus

- The current public web client and verified adapter use `GET /Api-Stations`, `GET /Api-Station`, and `GET /Api-Travels`.
- The current travel parameters found in the static client are `origin`, `destination`, `datestart`, `dateend`, `adults`, `children`, `code`, and `cursor`.
- The [official robots.txt](https://www.itabus.it/robots.txt) contains `Disallow: /on/demandware.store/Sites-*`.
- The [official General Conditions](https://www.itabus.it/it/condizioni-generali-di-vendita-e-di-trasporto.html), article 2.4.2, restrict portal use and automated extraction, expressly including commercial screen scraping.
- The historical [giaco8020/itabus-api request code](https://github.com/giaco8020/itabus-api/blob/84531980cd1499e0369bc0607f4d039a487661b7/data/api/itabusApi.js#L30-L65) calls the old Demandware endpoint without session headers. Its [station snapshot](https://github.com/giaco8020/itabus-api/blob/84531980cd1499e0369bc0607f4d039a487661b7/data/utils/stations.json#L1-L15) dates from September 2023 and contains 401 locations.
- A live `Api-Stations` response contained 1,456 entries. Current records use parent city IDs such as `ROM_T` and physical stop IDs such as `ROM1`.
- A successful live travel request used `origin`, `destination`, `datestart`, `adults`, `children`, `membership=false`, and an empty `code`.
- Current fares are nested below structures such as `rates.ITABUS.ECONOMY.COMFORT`; the adapter selects the cheapest numeric product price and returns its `product_family_id` as the fare.
- Live verification for 10 November 2026 returned:
  - Roma–Milano: 5 journeys; first 07:00–14:45, EUR 14.99.
  - Milano–Bologna: 6 journeys; first 09:10–12:35, EUR 3.99.
  - Napoli–Roma: 18 journeys; first 03:20–06:00, EUR 24.99.
  - Roma–Cosenza: 1 journey, 19:30–02:25, EUR 14.99.
- Paola was absent from the live station catalog. An initial partial match incorrectly selected Pietrapaola; a regression test now requires exact station, city, synonym, or ID matching for journey searches.

### Autoservizi Salemi and Autolinee Federico

- The booking applications expose tenant-specific configuration pointing to `https://api.autoservizisalemi.it/` and `https://api.autolineefederico.it/`.
- The shared Albatross client refers to autocomplete, origin/destination locality and stop, journey search, fare category, and trip information endpoints.
- The browser client can send cookies, frontend metadata, client identifiers, and a calculated signature. Low-volume probes established that anonymous location and journey search requires only the public tenant header; no signature, cookie, credential, browser metadata, or session initialization is required.
- The adapter uses `GET locations/from`, `GET locations/to`, `GET fareCategories` only when children are requested, and `POST search/s/...`. It does not implement the client signature because the anonymous search endpoints do not require it.
- Anonymous UI observation on 24 October 2026 found these examples for 25 October 2026:
  - Salemi, Roma to Milano: 05:15–12:10 to San Donato, EUR 25.00, 6h55, available; and 05:15–12:50 to Lampugnano, EUR 25.00, 7h35, available.
  - Federico, Roma to Reggio Calabria: 14:40–23:50, EUR 50.00, 9h10, last four seats; and 22:30–07:35, EUR 37.50, 9h05, available.
- Live API verification through the finished service returned 156 Salemi combinations for Palermo–Marsala on 10 November 2026 and 4 Federico combinations for Roma–Reggio Calabria on 25 October 2026. One-adult/one-child searches succeeded for both tenants.
- Albatross city searches return locality IDs; journey solutions return one or more physical trip legs. The adapter preserves the first physical departure stop, last physical arrival stop, and joins leg IDs for a stable normalized trip ID.
- On 24 October 2026, anonymous GET requests to both official booking hosts accepted the shared public route format `/it/from/{origin}/{YYMMDD}/to/{destination}/?adulti={count}` with HTTP 200. The adapter uses this format for manual continuation. No stable child-passenger URL parameter was verified, so the link carries the adult count and the user confirms all passengers on the provider site.

### MarinoBus

- The [official site](https://marinobus.it/) sends online bookings to [booking.marinobus.it](https://booking.marinobus.it/). Public result URLs follow `https://booking.marinobus.it/it/from/{origin}/{YYMMDD}/to/{destination}/?adulti=1`.
- The booking application's public [configuration](https://booking.marinobus.it/apiUrl.js) identifies tenant `marinobus`, API base `https://api.marinobus.it/`, and Albatross version `8.5.390` as observed on 24 October 2026.
- The application loads the same `booking-ZdalaGoa.js` client entry used by the other Albatross operators. Its public [API client module](https://booking.marinobus.it/FA-24MtW.js) defines `GET search/autocomplete`, `GET locations/from`, `GET locations/to`, `POST search/s/...`, and `POST search/tripInfo/` with the same request and response shape.
- The minimal anonymous flow verified on 24 October 2026 is:
  1. `GET locations/from?saleGroupId=` with `Albatross-Tenant: marinobus` returned 333 localities.
  2. `GET locations/to?departure={originId}&saleGroupId=` returned 254 destinations for Roma, including Bologna, Matera, Milano, and Napoli.
  3. `POST search/s/{originId}/{destinationId}/{date}/{date}` with the existing Albatross query parameters and body `[{"fId":null,"extra":{},"subGroupId":0}]` returned journeys for one adult.
- The live Roma-Milano search for 10 November 2026 returned three solutions. The first was 22:00-05:25 with `calculatedPrice: 49.0` and one unblocked and uncancelled leg; public MarinoBus result pages display fares in euros.
- The finished service returned six Cosenza-Milano solutions for 26 October 2026. A one-adult/one-child search also succeeded with six solutions; the first normalized total was EUR 117.
- These probes needed only `Accept: application/json`, `Content-Type: application/json` for the POST, and `Albatross-Tenant: marinobus`. No login, CAPTCHA, cookie, client signature, browser metadata, or preliminary session request was needed.
- `https://booking.marinobus.it/robots.txt` returned 404. The [main-site robots.txt](https://marinobus.it/robots.txt) excludes WordPress internals and search pages, but does not name the booking or API hosts.
- The current [official Conditions of Carriage](https://marinobus.it/wp-content/uploads/2026/02/MarinoBus_Condizioni-di-Trasporto_02-2026.pdf) say third-party portal information may be stale and that the official, binding data is on `marinobus.it`. Searches within that document found no API, automated extraction, or scraping clause; this is not evidence of a redistribution licence.
- On 24 October 2026, the official booking host accepted `/it/from/Roma/261110/to/Milano/?adulti=1` with HTTP 200, consistent with the indexed public result URLs above. The adapter uses the shared Albatross route format for manual continuation.

## Inferences

- The 2023 reference repository is useful for schema research but is not a current operational dependency.
- Salemi and Federico share the same booking schema while their tenants retain independent routes, fare categories, and prices, so one configured adapter covers both without duplicating parsing logic.
- MarinoBus exposes the same Albatross contract, so the existing configured adapter supports it without a new parser. The shared synthetic fixture and parser tests cover that response schema, while a live end-to-end smoke test verifies the MarinoBus tenant configuration.
- The client signature remains deliberately unimplemented because it is unnecessary for anonymous search and would add brittle code without functionality.
- No stable pre-filled Itabus browser URL was verified. Itabus journeys therefore link to `https://app.itabus.it/` rather than an invented route.

## Not verified

- A redistribution licence for any provider's live prices or availability.
- Long-term stability of the unofficial Albatross response schema.
- Long-term stability of the unofficial Itabus response schema.

## Required next evidence

Downstream deployments must confirm their own authorization and redistribution terms. Revalidate the synthetic fixtures if either provider changes its booking schema.

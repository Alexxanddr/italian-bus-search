# Glossary

Use these terms consistently in code, tests, issues, and documentation.

### Adapter

A provider-specific implementation of the `Provider` interface. It resolves remote locations, performs read-only searches, validates upstream data, and returns normalized domain objects.

### Albatross

The booking platform shared by Autoservizi Salemi, Autolinee Federico, and MarinoBus. Each operator is an independent tenant with its own endpoint, locations, fares, and journeys.

### Availability

Whether the upstream provider currently marks a journey as bookable. It is not a seat, fare, or purchase guarantee.

### Fare

Provider-defined price conditions attached to a journey. A normalized journey may omit the fare name when the upstream response does not expose one.

### Journey

A normalized, scheduled connection between an origin and destination. A journey can contain multiple upstream legs, while exposing one departure, arrival, duration, and total price.

### Location

A provider-owned place that can be used in search. Depending on the provider, it can represent a city, locality, terminal, or physical stop.

### Partial result

A successful aggregate response containing data from at least one provider and structured errors for other providers that could not answer.

### Timetable source

The legacy `timetableSource` field describes the live booking observation that supplied a rail journey: source, observation timestamp and requested travel date. It does not imply a locally installed dataset and is separate from standalone operational status.

### Provider

A passenger transport operator reachable through one adapter. Its stable machine identifier is used by the `provider` query parameter.

### Provider error

A structured failure associated with one provider inside a location or journey response. It does not invalidate successful results from other providers.

### Source fixture

A synthetic or safely redacted JSON document representing an upstream response. Fixtures contain no cookies, tokens, credentials, or personal data.

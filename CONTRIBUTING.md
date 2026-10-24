# Contributing

Thank you for helping improve Italian Bus Search.

## Before opening a change

- Keep the project read-only and within the scope described in the [README](README.md).
- For provider integrations, confirm authorization and applicable terms before sending live requests.
- Report security vulnerabilities privately using [SECURITY.md](SECURITY.md).
- Open an issue first when proposing a breaking HTTP change or a materially broader product scope.

## Local setup

```sh
npm install
cp .env.example .env
npm run check
```

Use Node.js 22.18 or newer. No external services are required by the test suite.

## Development workflow

1. Keep the change focused on one behavior.
2. Add or update a test at the public seam affected by the change.
3. Use injected HTTP clients and synthetic fixtures for provider behavior.
4. Update the authoritative document for any changed contract or operational assumption.
5. Run the complete verification commands before opening a pull request.

```sh
npm run check
npm run build
npm audit --audit-level=high
git diff --check
```

## Provider changes

Follow [Adding a provider](docs/adding-provider.md). Live probes must be authorized, anonymous where possible, and limited to the minimum needed to establish a request and response shape. Never commit credentials, session cookies, CAPTCHA material, customer data, or raw captures containing them.

## Code expectations

- Use strict TypeScript and existing Node.js platform features.
- Keep provider-specific knowledge inside its adapter.
- Return `AppError` with the closest existing error code at trust boundaries.
- Preserve partial-result behavior in `SearchService`.
- Add a dependency only when the platform and existing code cannot reasonably provide the behavior.
- Comments should explain non-obvious reasons, not restate code.

## Documentation expectations

- HTTP contract changes update [docs/api.md](docs/api.md).
- MCP tool or stdio changes update [docs/mcp.md](docs/mcp.md).
- Module or data-flow changes update [docs/architecture.md](docs/architecture.md).
- Deployment changes update [docs/operations.md](docs/operations.md).
- Provider evidence and live verification update [docs/research.md](docs/research.md).
- New terms update [GLOSSARY.md](GLOSSARY.md) only when they are part of the project's stable vocabulary.

## Pull requests

Describe:

- the user-visible outcome;
- the test that proves it;
- any live verification performed;
- compatibility or legal assumptions;
- known limitations left in place.

Do not include generated build output, local `.env` files, logs, or provider response dumps outside the synthetic fixtures.

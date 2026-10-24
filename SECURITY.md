# Security policy

## Supported versions

This project is pre-release. Security fixes are applied to the latest revision of the default branch only.

## Reporting a vulnerability

Use the repository's **Security** tab to submit a private vulnerability report when that feature is enabled. If it is unavailable, open an issue containing no exploit details and ask the maintainers for a private contact channel. Do not disclose a suspected vulnerability in a public issue.

Include:

- the affected endpoint or module;
- a minimal reproduction;
- expected and actual behavior;
- security impact;
- suggested mitigation, if known.

Do not include real credentials, session cookies, personal data, or destructive proof-of-concept traffic. Use synthetic values and the minimum request volume needed to demonstrate the issue.

## Security boundaries

The application:

- accepts unauthenticated GET requests;
- exposes a local read-only MCP stdio process started by its host;
- makes outbound HTTPS requests only to provider endpoints fixed in source code;
- keeps caches and rate-limit counters in memory;
- returns normalized data and structured errors;
- intentionally excludes login, booking, payment, and CAPTCHA flows.

Relevant reports include response-validation bypasses, sensitive-data exposure, unsafe changes to provider endpoint selection, denial-of-service paths, rate-limit defects, dependency vulnerabilities, and committed secrets.

Provider terms, data licences, schedule accuracy, and fare disputes are important project concerns but are not software security vulnerabilities. Raise non-sensitive concerns through normal project discussion.

# Publishing and releases

## Current status

The package is published as `italian-bus-search`; npm user `alexxanddr0` owns it. Version `0.1.0` was the initial public release.

The repository metadata points to `Alexxanddr/italian-travel-search`. Every new publication requires a unique version; npm versions cannot be overwritten.

## Recommended distribution

Use npm plus GitHub Releases for the current local stdio server:

- npm supplies the executable to Node-based MCP hosts.
- Git tags and GitHub Releases provide source history and release notes.
- The official MCP Registry hosts metadata pointing to the npm package.

## Versioning

Use Semantic Versioning and tags of the form `vX.Y.Z`. Until `1.0.0`, document any breaking MCP contract or API change prominently.

## Pre-release checklist

1. Verify npm account, package ownership, and public repository URL.
2. Verify package metadata and installation examples.
3. Update `CHANGELOG.md` and the package version.
4. Run `npm run check` and `npm pack --dry-run`.
5. Create the signed/annotated Git tag and release notes.
6. Publish a GitHub Release whose tag exactly matches `v<package version>`. The `publish.yml` workflow validates, tests, publishes through npm Trusted Publishing, then publishes `server.json` to the official MCP Registry.

## Trusted Publishing setup

The repository includes `.github/workflows/publish.yml` using npm Trusted Publishing via GitHub Actions OIDC. Configure the package on npm under **Settings → Trusted Publisher → GitHub Actions**:

- Organization or user: `Alexxanddr`
- Repository: `italian-travel-search`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Trusted Publishing requires Node.js 22.14 or newer and npm 11.5.1 or newer. The release workflow uses Node.js 24 and upgrades npm before publishing; the npm version bundled with older Node.js actions is insufficient.

## MCP Registry

`server.json`, `package.json`, and the runtime MCP identity must use the same server name and version. The release workflow authenticates to the official MCP Registry with GitHub OIDC.

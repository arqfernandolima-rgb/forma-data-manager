# Development and releases

## Prerequisites

- [Bun](https://bun.sh) 1.4.x (engine)
- Node.js 22 (desktop app and its tests)
- Windows to build the installer locally (or use CI; NSIS packaging needs Windows or Wine)

## Engine

```bash
cd engine
bun install
bun test                                  # 36 tests: normalization, SQL guard, full build on a synthetic extract, view layout checks, change summary
bun src/cli.js build --zip path/to/autodesk_data_extract.zip --data-dir ./data
bun src/cli.js serve --data-dir ./data    # MCP over stdio
bun scripts/smoke.js ./data               # starts the server as an MCP client would and calls every tool
bun run compile:win                       # dist/forma-data.exe (cross-compiles from any OS)
```

`test/fixtures/schema-columns-2026-06.json` holds the Data Connector table/column layout (names only, no data). A test checks that every view compiles against it. When Autodesk changes the layout, add a new fixture next to it.

## Desktop app

```bash
cd desktop
npm install
npm test                                  # 43 tests: PKCE sign-in via loopback, retries, sync pipeline incl. timeline/resume/limits/rejection, scheduler incl. same-day retries, Autodesk daily schedule upkeep, sleep/lost-connection handling, Claude config merge, tray state, skill ZIP
npm start                                 # dev mode: uses ../engine/dist/forma-data(.exe) if present, else `bun ../engine/src/cli.js`
npm run dist                              # Windows installer in dist/ (needs ../engine/dist/forma-data.exe)
```

## The Claude plugin

`.claude-plugin/marketplace.json` (repo root) lists one plugin, `claude-plugin/`, whose only content is the `forma-data-dashboards` skill. The engine embeds the same `SKILL.md` at compile time (`forma_dashboard_guide` tool and `forma_dashboard` prompt), so there is one source of truth. Bump `claude-plugin/.claude-plugin/plugin.json` `version` with each release so plugin users get the update. Validate with `claude plugin validate .`.

## CI and releases

- **CI** (`.github/workflows/ci.yml`, every push): engine tests, desktop tests, then on `windows-latest`: compile the engine, build a synthetic extract, run the compiled `.exe` as an MCP server through the smoke test (this also verifies the query worker inside the compiled binary), build the installer, and upload it with SHA-256 checksums as a workflow artifact.
- **Release** (`.github/workflows/release.yml`): push a tag `vX.Y.Z` whose version matches `engine/package.json` and `desktop/package.json`. The workflow tests, builds and publishes a GitHub release marked **latest**, with the installer, `SHA256SUMS.txt`, and release notes made of install steps plus that version's section of `CHANGELOG.md`. A tag with a suffix (`vX.Y.Z-beta.1`, with the same version in both package files) is published as a pre-release instead.

```bash
# bump versions in engine/package.json, engine/src/version.js (ENGINE_VERSION) and desktop/package.json, update CHANGELOG.md
git tag -a v4.1.4 -m "Forma Data Manager 4.1.4" && git push origin v4.1.4
```

Bump `SCHEMA_VERSION` in `engine/src/version.js` whenever the database layout changes in a way the server relies on. Servers refuse databases with a different layout version and tell the user to sync.

## Code signing

Releases are unsigned, so SmartScreen warns. To sign, add a certificate to CI (for example Azure Trusted Signing) and configure `win.signtoolOptions` / `azureSignOptions` in `desktop/electron-builder.yml`.

## Guidelines

- Never commit extracts, databases, query results, tokens or customer names. `.gitignore` blocks the common file types; keep examples synthetic.
- Accuracy rules belong in the views (`engine/src/build/views.js`), not just in prompts: if Claude keeps needing a rule, encode it in the data.
- New views need a row in `VIEW_MODULE`, a description, and a test in `engine/test/build.test.js`.

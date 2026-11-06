# Architecture

```
┌──────────────────────────── Forma Data Manager (Electron, per-user install) ────────────────────────────┐
│ main process                                                                                             │
│   auth.js        OAuth 2.0 + PKCE via system browser → http://localhost:<port>/callback; tokens → DPAPI  │
│   aps.js         APS client over Electron net.fetch (system proxy aware), retries, readable errors       │
│   dataconnector  create ONE_TIME request · poll job · data-listing · signed-URL download (size-checked)  │
│   sync.js        persisted state machine: requesting → waiting → downloading → building → done           │
│   scheduler.js   daily at HH:MM, catch-up after sleep/off, skip if synced < 12 h, sign-in keep-alive     │
│   engine.js      runs forma-data.exe build/info/rollback, parses JSON-lines progress                     │
│   claude-config  merge into claude_desktop_config.json (both install types), backup first               │
│   skill.js       optional: skill ZIP for upload, copy for Claude Code                                    │
│ renderer         setup wizard + status/history/settings (sandboxed, contextIsolation, strict CSP)        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
            │ spawns                                                     ▲ reads current.json (status)
            ▼                                                            │
┌──────────────── forma-data.exe (Bun, compiled, single file) ───────────────┐
│ build   ZIP/CSV dir → forma-<stamp>.db.partial → checks → rename → pointer │
│ serve   MCP stdio server · follows current.json · query worker + timeout   │──── Claude Desktop / Claude Code
└────────────────────────────────────────────────────────────────────────────┘
                     data folder: current.json, forma-*.db, downloads/
```

## Key decisions

| Decision | Why |
|---|---|
| **Data Connector API, user sign-in (PKCE)** | It's the only way to get the full-hub extract. The API accepts 3-legged tokens only. PKCE means no client secret is stored on the PC |
| **Bring your own APS app** | Each organization controls which apps can reach its hub (Custom Integrations), and nothing depends on a third-party app |
| **App-triggered daily job** (not a Data Connector schedule) | You choose when it runs, and you can see it in the app. The request list stays tidy because the app deletes its own older one-time requests |
| **Persisted sync state** | Extraction can take hours; a reboot mustn't create a second job against the 24/day limit |
| **Electron `net.fetch`** | Uses Chromium's network stack, so corporate proxies and PAC files work like they do in the browser |
| **Engine compiled with Bun** | Native SQLite (`bun:sqlite`), fast CSV loading, and a single self-contained `.exe`: users don't install Bun or Node, and Claude Desktop starts it directly |
| **Official schema for types** | Every extract ships `schemas/schema.json`, which is authoritative, unlike sampling the first rows |
| **STRICT tables with `ANY` for numbers/booleans** | Clean numbers are stored as numbers, while odd values (codes in "number" columns) are kept exactly as text instead of being coerced or nulled |
| **Immutable database files + `current.json` pointer** | Windows can't rename or replace a file another process has open, and several servers (Desktop and Code) may have it open. Builds never touch the live file |
| **Scalar lookups in views** | Guarantees one row per base record, even when lookup tables contain duplicates |
| **Precomputed `project_rollup`, `_columns`, `_status_counts`** | Hub-wide answers and column value checks become single, instant queries; the model spends tokens on reasoning, not discovery |
| **Query worker with timeout** | A runaway query (e.g. an accidental cross join) is abandoned after 30 s while the server keeps answering |
| **Dashboard guide built into the server** | Claude has no supported way for an app to install a skill into someone's account. Serving the guide as an MCP tool makes it automatic in every client; the plugin/skill stays optional |
| **Connect first, load data after** | MCP clients time out if a server is slow to start; the server responds to `initialize` immediately |

## Data folder protocol

1. Build writes `forma-<UTC stamp>.db.partial`, with no journaling or fsync during the bulk load.
2. Integrity check, then the sanity checks from [sync.md](sync.md#safety-checks-before-new-data-goes-live).
3. Rename to `forma-<stamp>.db`. Nobody has this file open yet.
4. Write `current.json.<pid>.tmp`, then rename it over `current.json` (atomic replace, retried if a reader holds it for a moment).
5. Servers check `current.json`'s modification time every 3 seconds. On a change, they open the new file read-only, verify `_meta.build_complete` and the schema version, swap, and close the old handle (the worker releases its handle too).
6. Old versions beyond the keep count are deleted. Files still open are skipped and retried after the next build.

## Repository layout

```
engine/         forma-data engine (build + MCP server), Bun, tests in engine/test
desktop/        Forma Data Manager (Electron), tests in desktop/test, installer config
claude-plugin/  Claude plugin with the forma-data-dashboards skill (also built into the engine as forma_dashboard_guide)
.claude-plugin/ marketplace.json: makes this repo a Claude plugin marketplace
docs/           documentation
.github/        CI (tests, Windows smoke test, installer artifact) and tagged releases
```

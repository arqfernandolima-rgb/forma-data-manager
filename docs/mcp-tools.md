# MCP tools reference

Server name: **`forma-data`** (stdio). Started by Claude Desktop/Code as `forma-data.exe serve` with `FORMA_DATA_DIR` set to your data folder.

Every result is compact JSON and includes `as_of` (the extraction date). Tabular results use `{ "columns": [...], "rows": [[...]] }`, and responses are capped at about 60K characters (with a `note` when trimmed). All tools are read-only.

The server also sends **instructions** to the client at connect time: the fast path and the data rules from [data-model.md](data-model.md).

## `forma_overview`

Call once per conversation. Returns `as_of`, `data_age_days`, `freshness` (`current` / `N days old` / `STALE: …`), `changes_since_previous` (new/closed issues, RFIs, submittals, forms and checklists, project additions and status changes, and modules that grew or shrank, compared with the previous extract), project counts by status and classification, modules with data, the available views with descriptions and row counts, what `project_rollup` contains, and the conventions to follow. About 9K characters.

## `forma_find_projects`

| Arg | Type | Notes |
|---|---|---|
| `name` | string | Partial, case-insensitive; also matches job number |
| `status` | string | `active`, `archived`, `inactive` |
| `type` | string | Partial project type, e.g. `Data Center` |
| `production_only` | boolean | `classification = production` and not test-looking |
| `limit` | 1–5000 (100) | |

Returns `total_matched` (exact) plus rows with `is_production` and `looks_like_test`.

## `forma_project_summary`

| Arg | Notes |
|---|---|
| `project` | Project id, exact name, or part of a name |

If several projects match, returns `ambiguous: true` and the candidates. It never merges projects. Otherwise returns the project row, its `project_rollup` row (NULL fields dropped), record counts by status for every table, and the 5 most overdue issues, RFIs, submittals and meeting items.

## `forma_sql`

| Arg | Notes |
|---|---|
| `sql` | One `SELECT` or `WITH` statement. Leading/trailing comments and a trailing semicolon are fine |
| `max_rows` | 1–2000 (200). The server reads `max_rows + 1` rows lazily and reports `truncated: true`; your own `LIMIT`, CTEs and subqueries are untouched |

Runs in a worker thread with a **30-second timeout** (`FORMA_QUERY_TIMEOUT_MS` to change it). The server stays responsive while a query runs. On errors it suggests close matches: `no such column: statuss` → `v_rfis.status`, and `no such table` → similar names.

## `forma_describe`

| Arg | Notes |
|---|---|
| `name` | Table or view |
| `sample_rows` | 0–10 (2) |

Per column: kind, **Autodesk's description** (from the official schema), filled count, distinct count, and either the actual values with counts (up to 25 distinct) or the min/max. Use it before filtering, so `WHERE status = 'Open'` vs `'open'` is never a guess.

## `forma_catalog`

| Arg | Notes |
|---|---|
| none | Every module with its tables and row counts (~8K characters) |
| `module` | That module's tables with their columns, plus its views |
| `search` | Tables/columns whose name or Autodesk description mentions the term, e.g. `retention` |

## `forma_search`

| Arg | Notes |
|---|---|
| `query` | Plain words, or FTS5 syntax (`"exact phrase"`, `term*`, `OR`, `NOT`). Input that isn't valid FTS syntax is retried as plain words |
| `module` | e.g. `rfis`, `issues`, `cost` |
| `project` | Project id or exact name |
| `limit` | 1–100 (25) |

Covers issues, issue/RFI comments, RFIs, submittals, meetings, topics, action items, checklists and items, daily-log notes, forms, assets, change orders, contracts, budgets, schedule activities, photos, companies and projects. Active records only. Returns table, id, project, title, status and a highlighted excerpt.

## `forma_dashboard_guide`

No arguments. Returns the dashboard house style and data rules as plain text (~10K characters). This is the [dashboard skill](../claude-plugin/skills/forma-data-dashboards/SKILL.md), built into the server: the tool description and the server instructions tell Claude to call it once before building any dashboard, chart or visual summary. Nothing has to be installed, and it works in every MCP client. If the skill is also installed, Claude skips the tool.

## Prompt: `forma_dashboard`

Argument `request` (optional). Returns the same guide plus your request. In Claude Desktop, use the **+** menu → forma-data → forma_dashboard.

## Running it by hand

```powershell
# Claude Desktop does this for you; useful for testing
$env:FORMA_DATA_DIR = "$env:LOCALAPPDATA\FormaData"
& "$env:LOCALAPPDATA\Programs\forma-data-manager\resources\engine\forma-data.exe" serve
```

Other engine commands: `build --zip <extract.zip> [--data-dir DIR] [--force]`, `info`, `rollback`, `version`.

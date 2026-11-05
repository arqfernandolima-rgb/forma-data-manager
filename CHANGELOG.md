# Changelog

## 4.0.0 (2026-11)

A rewrite: from a set of scripts fed by hand-downloaded ZIPs to a Windows app that pulls Data Connector extracts itself.

### New
- **Forma Data Manager** (Windows installer): Autodesk sign-in (PKCE, bring-your-own APS app), hub picker, daily sync at a chosen time plus **Sync now**, resumable syncs, history, rollback, tray icon, start with Windows.
- **Setup wizard**: disclaimer, APS app, sign-in, hub, data folder, schedule, Claude Desktop config (both install types, with backup), dashboard skill.
- **Single `forma-data.exe` engine** (no Bun/Node needed): `build`, `serve`, `info`, `rollback`.
- New views: `v_projects`, `v_meeting_items`, `v_forms`, `v_cost_budgets`, `v_cost_contracts`, `v_change_orders`, `v_change_order_chains`, `v_schedule_activities`, `v_takeoff_quantities`.
- `status_group`, `is_overdue`, `days_overdue`, `age_days` on every relevant view, measured against the extraction date.
- Precomputed `project_rollup`; column stats with real values and Autodesk's column descriptions.
- MCP tools renamed `forma_*`; new `forma_describe` and `forma_catalog`; `forma_dashboard` prompt; server instructions.

### Fixed (data accuracy)
- Numeric **zeros were stored as NULL**: `parseInt(v) || null`. For example, 18,816 not-started schedule activities disappeared from averages and counts.
- Column types were guessed from the first 100 rows; now taken from the official schema. Codes with leading zeros stay text; sparse numeric columns are no longer text.
- `v_rfis` and `v_submittals` failed on extracts without `deleted_at`; views are now built defensively and verified at build time.
- JOIN-based name lookups could duplicate rows when a user ID appeared twice; lookups are now scalar.
- Booleans (`t`/`f`, `true`/`false`, `0`/`1`), timestamps (mixed precision, `UTC` suffix) and stray whitespace are normalized.
- Project drill-down merged up to 10 name matches into one result; now returns candidates.
- Hot-swap could open a database that was still being written. Builds now write a new file and atomically update a pointer, which is also safe with several readers on Windows.
- `LIMIT` detection skipped the row cap when a subquery had a LIMIT; trailing semicolons and leading comments broke queries; no query timeout.
- `acc_list_tables` (~110K characters) and `acc_hub_kpis` (~68K) overflowed the model's context; replaced with compact overview/catalog/describe tools (~9K).

### Removed
- ZIP drop folder, `watch.js`, port-4000 status page, and the v3 Electron app (replaced by Forma Data Manager).

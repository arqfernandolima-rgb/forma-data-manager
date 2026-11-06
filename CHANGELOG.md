# Changelog

## 4.0.1 (2026-11)

### Forma Data Manager (Windows app)
- Fixed: after a sync finished or failed, the tray icon and the Status page could stay on "syncing" (with a Cancel button) until you restarted the app.
- The project moved to [github.com/arqfernandolima-rgb/forma-data-manager](https://github.com/arqfernandolima-rgb/forma-data-manager). The app's links, the Claude plugin marketplace and the docs point there. Fixed the in-app links to the APS setup guide and the license, which pointed at a branch without those files.
- If you move the app to another folder (run the installer and pick a new location) or change the data folder in Settings, the app now updates its Claude Desktop entry to match on start-up and tells you to restart Claude Desktop. Before, Claude Desktop kept the old path and the forma-data tools stopped working. It only updates an entry you set up; it never adds one back after you removed it.
- The tray icon now shows the app's state by color: gray not ready (setup unfinished or no data yet), blue syncing, green ready, amber stale (data more than 2 days old), red needs attention (last sync failed, extract waiting for review, or sign-in expired). The tooltip and a new first line in the tray menu say which, and it re-checks every minute so data turns stale on its own.

## 4.0.0 (2026-11)

First public release.

### Forma Data Manager (Windows app)
- Per-user installer (no admin rights) with license and disclaimer acceptance.
- Setup wizard: disclaimer, your own APS app (PKCE, no client secret), Autodesk sign-in, hub, data folder, daily schedule, Claude Desktop config (both install types, backed up first).
- Daily sync at a time you choose, plus **Sync now**. It catches up after the PC was off, resumes the same Data Connector job after a restart, cleans up its own Data Connector requests, and respects the 24 jobs/day limit.
- Step-by-step sync timeline: requested, confirmed (job ID), Autodesk preparing (elapsed time, last/next check, estimate from your past syncs), download (size, speed, time left), build (table X of Y), ready. Notifications when a sync finishes in the background.
- History with per-phase timings, rollback to the previous database, tray icon, start with Windows, log redaction.

### forma-data engine (single `forma-data.exe`)
- Builds SQLite from the extract using the official Data Connector schema: zeros stay zeros, codes keep leading zeros, booleans and timestamps are normalized, values are trimmed, and nothing is silently dropped.
- Views built defensively and verified at build time, with lookups that can't duplicate rows, `status_group`, and `is_overdue`/`days_overdue`/`age_days` measured against the extraction date.
- Views: projects, issues (ACC, BIM 360, combined), RFIs, submittals, assets, checklists, meetings, meeting items, daily logs, reviews, forms, cost budgets, contracts, change orders, change-order chains, schedule activities, takeoff quantities.
- Precomputed `project_rollup`; column stats with real values and Autodesk's column descriptions; full-text search.
- Immutable database versions with an atomic pointer swap, safe on Windows with several readers; a suspiciously small extract is held for review.
- MCP tools: `forma_overview`, `forma_find_projects`, `forma_project_summary`, `forma_sql` (worker thread, 30 s timeout), `forma_describe`, `forma_catalog`, `forma_search`, `forma_dashboard_guide`; `forma_dashboard` prompt; server instructions with the data rules.

### Dashboard guide
- Built into the server (`forma_dashboard_guide`), so there's nothing to install.
- Optional: the repository is a Claude plugin marketplace (`forma-data` plugin), or upload the skill ZIP, or install it for Claude Code.

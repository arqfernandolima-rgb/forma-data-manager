# Changelog

## 4.1.4 (2026-11)

First release for testers (earlier builds were pre-releases).

**What you get**
- A Windows tray app that syncs your whole Autodesk Forma (ACC / BIM 360) hub every day through Data Connector. By default Autodesk prepares the extract on its servers at your time, even while your PC sleeps, and the app downloads it, builds a local database and swaps it in only after it passes its checks.
- The `forma-data` MCP server for Claude Desktop (and Claude Code): eight read-only tools, a built-in dashboard guide, and views that keep the numbers right (zeros stay zeros, no double counting, overdue measured against the extract date).
- A short summary of what changed with every sync, a History page, rollback, and a tray icon whose color shows whether data is ready, syncing, stale or needs attention.
- It rides out sleep and lost connections, and retries a failed daily sync the same day.

**Changes since 4.1.3**
- The disclaimer in the app now also says that query results go to Claude when you ask a question, and that the app creates Data Connector requests in your hub (including the daily schedule it maintains). DISCLAIMER.md and SECURITY.md describe exactly what the app creates in your hub.
- The setup wizard's disclaimer box is taller, so all of it is visible, and the checkbox now covers everything in it. The About page links to the full disclaimer and to SECURITY.md.
- Setup steps corrected: the signed-in user needs **Executive Overview** access (a hub admin grants it; being a hub admin doesn't include it), and the Custom Integrations step names the right access options (Account Administration and Document Management). The 403 message says the same.
- Docs: install paths in the manual Claude setup, what the uninstaller removes, a screenshot in the README, and wording that no longer overpromises about AI answers.
- Releases are now normal (latest) releases with install steps and what's new in the release notes.

## 4.1.3 (2026-11)

### Forma Data Manager (Windows app)
Fixes for laptops that sleep during a sync, found in a real log from Nov 7–10:
- Fixed: "Engine exited with code null". The database build has a 2-hour safety limit, and it counted time the PC was asleep, so a build paused by sleep was stopped the moment the PC woke up. The limit now counts only awake time, and if it ever does stop a build, the message says why.
- Fixed: the first sync after waking failed in a fraction of a second with `net::ERR_NETWORK_IO_SUSPENDED` or `net::ERR_NAME_NOT_RESOLVED`, because the sign-in refresh wasn't retried. Calls to Autodesk, including the sign-in refresh, now keep trying for about four minutes when there's no connection. The scheduler waits a minute after waking and doesn't start while Windows reports no connection.
- A failed scheduled sync is tried again the same day, 10, 30 and 60 minutes later (at most 3 retries). With Autodesk preparing the extract, a retry collects the same extract again and doesn't use another job. The Status page shows *retrying* and when.
- If the app can't reach Autodesk to look for today's extract, it looks again a few minutes later instead of starting its own extraction, which failed the same way and used up a job.
- Losing the connection while Autodesk prepares the extract no longer fails the sync, and dropped downloads get longer waits between attempts.
- A lost connection during the twice-daily check of Autodesk's schedule is no longer shown as "Autodesk schedule unavailable" for 12 hours. The app checks again in 10 minutes.
- History durations leave out time the PC was asleep and show it underneath ("asleep: 1 h 52 min").
- The log notes when the PC goes to sleep and wakes up.
- A network error that happens to contain "revoked" or "expired" (for example `net::ERR_CERT_REVOKED`) can no longer sign you out. Only Autodesk's own answer can.

## 4.1.2 (2026-11)

### Forma Data Manager (Windows app)
- After an upgrade, a problem with Autodesk's daily schedule left over from the previous version is retried as soon as the app starts, instead of up to an hour later. (After installing 4.1.1, Settings could keep showing the old "Invalid characters" message for a while.)
- Polish across every screen:
  - Settings: the "Sync every day at" checkbox lines up with its text and time box. The schedule status line sits under the two choices, which dim while the daily sync is off. Number boxes are narrower.
  - Claude setup: buttons no longer touch the Claude Desktop table, and the location names are shorter.
  - History: fewer, tidier columns that fit the window. How the sync was started sits under its date, the row count and download size under the data date, and Autodesk's preparation time under the duration.
  - Even spacing inside every card, the setup wizard included.
- Docs: README and sync docs describe the Autodesk-prepared daily extract; troubleshooting covers the old "Invalid characters" message.

## 4.1.1 (2026-11)

### Forma Data Manager (Windows app)
- Fixed: setting up Autodesk's daily extraction failed with "Autodesk API error 400: Invalid characters". Data Connector rejects parentheses in request descriptions; descriptions now use plain characters only, and if Autodesk still refuses, the app retries once with the simplest description. The log now includes Autodesk's full error for refused requests.

## 4.1.0 (2026-11)

### Forma Data Manager (Windows app)
- **Autodesk prepares the daily extract** (new default): the app creates one daily Data Connector request in your hub, so Autodesk makes the extract at your time even when the PC is asleep or off, and the app downloads it as soon as the PC is on. It keeps that schedule working by itself: daily downloads keep Autodesk from pausing it, a paused schedule is turned back on (or replaced), the end date is moved out a year before it arrives, and the schedule follows time changes and daylight saving time. If a day's run fails or doesn't show up within 45 minutes, the app starts a one-time extraction itself. Autodesk's per-job emails are off.
- **This computer starts it** is still available in Settings (and the setup wizard) for hubs where you don't want a standing schedule. Switching to it, turning the daily sync off, or uninstalling removes the app's schedule from Data Connector.
- Upgrading sets up the Autodesk-side schedule automatically on the next start; nothing to do.
- The Status page's Schedule card shows where the extraction comes from and when Autodesk runs it next; History marks those runs as *scheduled (Autodesk)*; the timeline shows when Autodesk actually started and finished.
- Changing the data folder no longer tells you to update Claude Desktop by hand (it's automatic since 4.0.2).

## 4.0.3 (2026-11)

### Forma Data Manager (Windows app)
- **What changed**: each sync now compares the new extract with the previous one and shows a short summary on the Status page, in History (one line per sync, e.g. "23 added · 2 removed · 4 closed"; click it for a per-category Added/Removed/Closed breakdown), and in the "Forma data updated" notification: new and closed issues, RFIs, submittals, forms and checklists (matched by ID), new or archived projects, and other modules that grew or shrank.
- The scheduled sync now runs every day, even if you also clicked Sync now. Before, it was skipped when a sync had finished in the previous 12 hours. If the PC is asleep at the scheduled time it still catches up when it wakes, and the log now says so.
- Fixed: after **Roll back to previous version**, the Status page kept showing the newer version's date, row count and size.

### forma-data engine
- `forma_overview` includes `changes_since_previous`, so Claude can answer "what changed since the last extract?".
- `rollback` rewrites `current.json` from the restored database's own metadata.

## 4.0.2 (2026-11)

### Forma Data Manager (Windows app)
- If you move the app to another folder (run the installer and pick a new location) or change the data folder in Settings, the app now updates its Claude Desktop entry to match on start-up and tells you to restart Claude Desktop. Before, Claude Desktop kept the old path and the forma-data tools stopped working. It only updates an entry you set up; it never adds one back after you removed it.
- Docs: how to move the app to another folder; corrected the default install folder name.

## 4.0.1 (2026-11)

### Forma Data Manager (Windows app)
- Fixed: after a sync finished or failed, the tray icon and the Status page could stay on "syncing" (with a Cancel button) until you restarted the app.
- The project moved to [github.com/arqfernandolima-rgb/forma-data-manager](https://github.com/arqfernandolima-rgb/forma-data-manager). The app's links, the Claude plugin marketplace and the docs point there. Fixed the in-app links to the APS setup guide and the license, which pointed at a branch without those files.
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

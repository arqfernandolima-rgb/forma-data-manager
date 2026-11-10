# Troubleshooting

Start with the **History** page and the log (`%APPDATA%\Forma Data Manager\logs\forma-data-manager.log`, also under About → Open log folder).

## Sign-in and access

| Symptom | Cause and fix |
|---|---|
| Browser shows a redirect URI error | The APS app's callback URL must exactly match the one shown in the app (port and `/callback` included) |
| "Port … is already in use" | Another program uses the callback port. Pick another in Settings and update the APS app's callback URL |
| Hub list is empty | The client ID isn't added under **Hub Admin → Custom Integrations**, or the account has no ACC/BIM 360 hubs. You can also paste the hub ID |
| Sync fails with 403 | Same Custom Integrations check, and the signed-in user needs **Executive Overview** access to the hub (a hub admin grants it; being a hub admin doesn't include it) |
| "Your Autodesk sign-in expired" | Refresh tokens expire after about 15 days without use. Sign in again (Settings) |

## Syncing

| Symptom | Cause and fix |
|---|---|
| Waiting for a long time | Autodesk prepares the extract on its side; large hubs can take hours. The app keeps waiting up to 10 hours and resumes after a restart |
| "Data Connector limit reached" / 429 | 24 jobs per rolling 24 hours, per hub and per user, including jobs started in the Forma web UI. Wait, then try again |
| "The new extract looks incomplete" | It has less than half the rows of the current database. Check the job in Data Connector. **Use it anyway** if the drop is expected (e.g. projects were archived), otherwise **Discard** |
| Download fails repeatedly | Signed URLs are retried with fresh links 4 times. Check the proxy or VPN. The app uses the same network settings as your browser |
| Scheduled sync didn't run | The app must be running (tray). Check **Start with Windows** in Settings. It catches up as soon as it runs (for example when the PC wakes up). With **Autodesk prepares it**, the extract is made at your time even if the PC was asleep, and the app collects it on wake |
| Schedule card or Settings says "Autodesk schedule unavailable" | The app couldn't create or check its daily Data Connector request (the message says why; usually permissions: you need Executive Overview access to the hub). It syncs from this computer meanwhile and retries every hour and at every start. "Autodesk API error 400: Invalid characters" was a bug in 4.1.0: update to the latest version. Or choose **This computer starts it** in Settings |
| A "Forma Data Manager daily extraction - managed by the app" request in Data Connector | That's the app's daily schedule. Leave it: the app maintains it. To remove it, choose **This computer starts it** in Settings |
| "Engine exited with code null" (4.1.2 and earlier) | The PC slept while the database was being built, and on waking the build's 2-hour limit (counted on the wall clock) stopped it. Fixed in 4.1.3: the limit counts only awake time. The previous data stayed in use |
| `net::ERR_NETWORK_IO_SUSPENDED` or `net::ERR_NAME_NOT_RESOLVED` | The PC had just woken up and Wi-Fi/VPN wasn't back yet. From 4.1.3 the app waits for the connection, retries calls for a few minutes, and tries a failed scheduled sync again 10, 30 and 60 minutes later |
| History shows a long duration (hours) for a quick sync | 4.1.2 and earlier counted time the PC was asleep. From 4.1.3 the duration is awake time and the sleep is shown underneath |
| Not enough disk space | Each sync needs room for the download plus two database versions. Lower "versions to keep" to 1, or move the data folder |

## Claude

| Symptom | Cause and fix |
|---|---|
| Claude doesn't show the forma-data tools | Fully quit Claude Desktop (tray → Quit) and reopen it. In the app, Claude setup should say **Connected** for your install type |
| "No database yet in …" | Run a sync. Also check that Claude Desktop's `FORMA_DATA_DIR` matches the app's data folder: after changing folders, click **Set up / update Claude Desktop** |
| "database layout vN doesn't match this server" | The app and database come from different versions. Update the app, then Sync now |
| Answers say "STALE" | The data is more than 7 days old. Sync now, and check that the schedule is on |
| A query was "stopped after 30s" | Aggregate with GROUP BY, filter by project, or avoid joining two large tables directly. Raise `FORMA_QUERY_TIMEOUT_MS` in the server's `env` if needed |
| Numbers look inflated | Check for fan-out (joining two one-to-many tables). Aggregate per module in CTEs, then join. For change orders use `v_change_order_chains` |

## Windows

| Symptom | Fix |
|---|---|
| SmartScreen blocks the installer | It isn't code-signed. Choose **More info → Run anyway**, after checking the SHA-256 checksum from the release |
| Antivirus flags `forma-data.exe` | Compiled single-file executables sometimes trigger heuristics. Check the checksum, then allow it, or build from source ([development.md](development.md)) |

## Collecting details for an issue

Include the app version (About), the History entry, and the last ~50 log lines. Logs redact tokens and signed URLs, but **don't post your data**: no databases, ZIPs or query results with project data.

# How syncing works

A sync gets a fresh copy of the whole hub from Autodesk and rebuilds the local database. It runs **once a day** at the time you choose, and whenever you click **Sync now**.

## Who starts the daily extraction

Settings → Sync (also in the setup wizard) has two choices:

| | **Autodesk prepares it** (default) | **This computer starts it** |
|---|---|---|
| Who starts the extraction | Autodesk, on its servers, at your time every day | The app, at your time |
| PC asleep or off at that time | The extract is still made on time; the app downloads it as soon as the PC is on | The extraction starts when the PC is on again |
| Data date when you open the laptop late | Your scheduled time | When the PC woke up |
| Needs at Autodesk | One daily Data Connector request, created and looked after by the app | Nothing that stays: one-time requests, deleted after use |

**Sync now** always starts a fresh one-time extraction, in both modes.

### How the app looks after Autodesk's schedule

The app creates **one** daily request in your hub's Data Connector, named *Forma Data Manager daily extraction - managed by the app*, with `scheduleInterval: DAY`, a one-year end date and Autodesk's per-job emails turned off. Autodesk pauses daily schedules whose data isn't downloaded for 14 days and stops them at their end date, so the app keeps it working on its own:

- It downloads every day, which is what keeps Autodesk from pausing it.
- If Autodesk paused it anyway (for example after two weeks away), the app turns it back on. If it's still not producing runs two days later, the app deletes it and creates a new one.
- When the end date is less than 30 days away, the app moves it out another year.
- The request fires at a fixed UTC time. When you change the time in Settings, or daylight saving time starts or ends, the app replaces it so it keeps running at your local time.
- If someone deletes it in Data Connector, the app creates it again. To stop it for good, choose **This computer starts it** or turn the daily sync off: the app deletes it. Uninstalling the app deletes it too.
- The app checks it at start-up, after you change settings, sign in or change hub, and about twice a day.

Every day after your scheduled time, the app looks for that day's run:

- **Finished or still running**: the app collects it (waits for it if needed), downloads and builds. History shows it as *scheduled by Autodesk*.
- **Failed**: the app starts a one-time extraction itself right away.
- **Not there 45 minutes after the time**: the app starts a one-time extraction itself and remembers the miss; two misses in a row count as "paused" (see above).
- **Can't reach Autodesk** (no connection yet after waking up): the app looks again a few minutes later. It doesn't start an extraction of its own, which would fail the same way and use up a job.
- **Can't be set up** (for example, missing permissions): the Schedule card and Settings say so, the app syncs from this computer meanwhile and retries every hour (and right away when the app starts, so an upgrade that fixes the problem takes effect at once).

## Phases

| Phase | What happens | Typical time |
|---|---|---|
| Requesting | `POST /data-connector/v1/accounts/{hub}/requests` with `scheduleInterval: ONE_TIME`, `serviceGroups: ["all"]`. Skipped when collecting a run of Autodesk's daily schedule | seconds |
| Waiting | Polls the request's job (`GET …/requests/{id}/jobs`, then `GET …/jobs/{jobId}`) every 20 s, then every 60 s, until `status: complete` and `completionStatus: success` | minutes to a few hours, depending on hub size and Autodesk's queue |
| Downloading | `GET …/jobs/{jobId}/data-listing`, then a signed URL for `autodesk_data_extract.zip` (falls back to individual CSVs if there's no ZIP). Size-checked and retried with a fresh signed URL | about a minute for ~120 MB |
| Building | `forma-data.exe build`: schema-typed load, indexes, views, search index, rollup, column stats, integrity check | under a minute for ~3M rows |
| Done | `current.json` points to the new database. Running MCP servers switch within about 3 seconds | — |

## What you see while it runs

The Status page shows a timeline with a time for each step:

1. **Extraction requested**: sent to Data Connector, or *started by Autodesk's daily schedule*.
2. **Confirmed by Autodesk**: the job ID.
3. **Autodesk prepares your extract**: how long it has been running, when the app last checked and when it checks next, and an estimate. The estimate is the typical time from your last syncs; for the first sync it shows a typical range. There's no progress bar here, because Autodesk doesn't report progress, and a moving bar would suggest it's almost done. You can close the window: the app keeps checking from the tray.
4. **Download**: a real progress bar with size, speed and time left.
5. **Build the database**: table X of Y, then indexes, views and summaries.
6. **Ready for Claude**: the new "data as of" date.

When a sync finishes or fails, Windows shows a notification if the window isn't in front (always for scheduled syncs). Clicking it opens the app. History keeps how long each phase took.

The in-flight state is saved after every step (`%APPDATA%\Forma Data Manager\sync-state.json`). If you close the app or restart Windows while Autodesk is still preparing the extract, the app **resumes the same job** next time instead of starting a new one.

## Schedule rules

- The app checks every minute, after start-up, and a minute after the PC wakes from sleep. While Windows reports no connection it waits.
- If today's scheduled time has passed and today's run hasn't happened yet, it runs now (catch-up). With **Autodesk prepares it**, "runs now" means collecting the extract Autodesk already made at your time.
- It runs every day even if you also clicked **Sync now**; manual syncs don't replace the scheduled one.
- **If today's scheduled sync fails, it's tried again** 10, 30 and 60 minutes later (at most 3 retries a day). The Status page shows *retrying* and the time. With **Autodesk prepares it**, a retry collects the same Autodesk extract again, so it doesn't use another job. A sync that was cancelled, or held for review, isn't retried.
- The schedule needs the app to be running. By default it starts with Windows and stays in the tray. Closing the window keeps it running; use the tray menu → Quit to stop it.
- While the app runs, the Autodesk sign-in is refreshed regularly, even with the schedule off, so it doesn't expire after ~15 idle days.

## Limits

Autodesk allows **24 Data Connector jobs per rolling 24 hours, per hub and per user**. Jobs started from the Forma web UI count too. The app:

- shows how many jobs **it** started in the last 24 hours (including Autodesk's daily run of its schedule),
- warns at 20 and refuses to start a 25th,
- never retries a request Autodesk rejected (429) automatically; retries of a failed scheduled sync (above) are capped at 3 a day.

## Safety checks before new data goes live

A new database only replaces the current one if:

1. every CSV loaded (an empty file still creates its table),
2. `admin_projects` has rows,
3. SQLite's integrity check passes,
4. it isn't **less than half** the size (in rows) of the current database.

If check 4 fails, the extract is kept and the app asks: **Use it anyway** or **Discard**. A Data Connector job can occasionally finish with partial data, and this stops that from quietly replacing a good database.

## What changed

Each build compares the new extract with the one it replaces and keeps a short summary:

- **Projects**: new ones, ones that disappeared, and status changes (for example active → archived), with a few names.
- **Issues, RFIs, submittals, forms and checklists**: how many are new and how many were closed since the previous extract. Items are matched by ID, so an item edited twice still counts once.
- **Everything else**: modules whose main table grew or shrank (markups, photos, daily logs, …).

It shows on the **Status** page (What changed), on the **History** page as one line per sync (for example "23 added · 2 removed · 4 closed"; click it for a breakdown by category, project names and other modules), and in the "Forma data updated" notification. "Removed" means the item was in the previous extract but not in this one, usually because it was deleted. Claude sees the same summary in `forma_overview` (`changes_since_previous`), so you can ask "what changed since yesterday?".

The first sync has nothing to compare with, so it has no summary. The comparison never stops a build: if it can't run (for example, the previous database was deleted), that sync just has no summary.

## Versions and rollback

Each build writes a new file `forma-<UTC timestamp>.db` and then updates `current.json`. Nothing is overwritten in place, which matters on Windows, where open files can't be replaced. The last **2** versions are kept by default (Settings → Database versions to keep). **Settings → Roll back to previous version** switches back instantly. The Status page then shows that version's date, size and change summary.

Older versions are deleted after a successful build. A file that a running server still has open is skipped and removed after the next build.

## Housekeeping at Autodesk

Each sync creates one one-time request in your hub's Data Connector. After a successful sync, the app deletes the **older requests it created itself**. It keeps the IDs of its own requests and never touches requests created by people or other tools.

## Sleep and lost connections

Laptops sleep in the middle of syncs. From 4.1.3 the app expects it:

- While waiting for Autodesk, a lost connection doesn't fail the sync; it keeps checking (Autodesk keeps working either way).
- Calls to Autodesk, including the sign-in refresh, are retried for about four minutes when there's no connection. Downloads that drop are retried with longer waits (5 s up to 2 min).
- The build's 2-hour safety limit counts only time the PC is awake, so a build paused by sleep finishes when the PC wakes.
- Durations in History leave out the time the PC was asleep, and show it separately ("asleep: 1 h 52 min").
- The log notes when the PC went to sleep and woke up, which makes gaps easy to read.

## Logs and history

- **History** page: the last 50 runs with result, data date, rows, duration (awake time; Autodesk's preparation and any sleep shown underneath) and what changed.
- Log file: `%APPDATA%\Forma Data Manager\logs\forma-data-manager.log`. Tokens and signed-URL credentials are redacted.

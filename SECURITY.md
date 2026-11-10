# Security

This is unofficial test code (see [DISCLAIMER.md](DISCLAIMER.md)). Here's exactly what it touches, so you can judge whether it fits your environment.

## Credentials

- **Sign-in:** OAuth 2.0 authorization code with PKCE through **your** APS app. There is no client secret; the redirect goes to `http://localhost:<port>/callback`, served on `127.0.0.1` only while signing in.
- **Scopes:** `data:read data:write data:create user-profile:read`. See [docs/aps-app-setup.md](docs/aps-app-setup.md#4-scopes-requested) for why each is needed.
- **Token storage:** `%APPDATA%\Forma Data Manager\tokens.bin`, encrypted with Electron `safeStorage` (Windows DPAPI, bound to your Windows user). If secure storage isn't available, the app refuses to store tokens.
- **Logs** redact bearer tokens, authorization codes, PKCE verifiers and signed-URL credentials.

## Network calls

| Destination | Purpose |
|---|---|
| `developer.api.autodesk.com` | Sign-in, token refresh, hub list, Data Connector requests/jobs/listings |
| `api.userprofile.autodesk.com` | Your name and email for display |
| Signed download URLs returned by Data Connector | The extract file |

That's all. The app doesn't call home, has no telemetry and no auto-updater. The MCP server (`forma-data.exe serve`) makes **no network calls**; it reads local files and talks to Claude over stdio.

## What it changes in your hub

The app never edits project data. Its only writes are Data Connector **requests** in your hub:

- **One-time requests**, one per sync it starts. After a successful sync it deletes the older requests **it** created (it keeps their IDs, and never touches requests made by people or other tools).
- **One daily scheduled request** when "Autodesk prepares it" is on (the default), named *Forma Data Manager daily extraction - managed by the app*. The app re-activates, extends or recreates it as needed, and deletes it when you choose "This computer starts it", turn the daily sync off, change hub, or uninstall (if the PC is online).

These requests and their jobs are visible to the hub's other admins in Data Connector, and the jobs count toward Autodesk's 24-per-day limit.

## Data at rest

- Extracts and databases live in the data folder you choose (default `%LOCALAPPDATA%\FormaData`), protected by normal Windows file permissions. Use an encrypted disk (BitLocker) if your data requires it.
- Downloads are deleted after a successful build (unless you enable "keep downloads").

## Data shared with Claude

The MCP server returns query **results** to the Claude client you connect, as part of your conversation. That data is then processed under your (or your organization's) agreement with Anthropic. The server is read-only: SQLite opened read-only with `query_only`, one `SELECT`/`WITH` statement per call, and `load_extension` blocked.

## Desktop app hardening

`contextIsolation`, `sandbox` and no `nodeIntegration` in the UI; a strict Content Security Policy; external links open in your browser and only for Autodesk, Claude/Anthropic and GitHub addresses; Electron fuses disable `RunAsNode`, `NODE_OPTIONS` and inspector flags.

## Reporting a vulnerability

Please **don't** open a public issue with details. Use GitHub's private vulnerability reporting (repository **Security → Report a vulnerability**). If that option isn't shown, open an issue that only asks for a private contact, without any details. This is a best-effort personal project with no response-time commitment.

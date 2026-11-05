# Install, upgrade and uninstall

## Before you start

- Windows 10 or 11, 64-bit. About 5 GB free disk space for a large hub (the download plus two database versions).
- [Claude Desktop](https://claude.ai/download), installed and opened at least once.
- An APS client ID that your hub trusts: see [aps-app-setup.md](aps-app-setup.md).
- A hub admin account with Executive access.

## Install

1. Download `Forma-Data-Manager-Setup-<version>.exe` and `SHA256SUMS.txt` from the repository's **Releases** page.
2. Optional: verify the file in PowerShell with `Get-FileHash .\Forma-Data-Manager-Setup-<version>.exe` and compare it with `SHA256SUMS.txt`.
3. Run the installer. It isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**.
4. Read and accept the license and disclaimer. The install is per-user, so no admin rights are needed. The default location is `%LOCALAPPDATA%\Programs\forma-data-manager`.
5. The setup wizard opens when the installer finishes.

## The setup wizard

| Step | What happens |
|---|---|
| Welcome | Disclaimer. You must accept it to continue |
| Autodesk app | Paste your APS client ID. The callback URL to register is shown with a copy button |
| Sign in | Your browser opens Autodesk sign-in. Tokens are stored encrypted (Windows DPAPI) |
| Hub | Pick an ACC/BIM 360 hub, or paste the hub (account) ID |
| Data folder | Where databases are stored. Default `%LOCALAPPDATA%\FormaData`. Avoid OneDrive/Dropbox folders: a new multi-GB file is written daily |
| Schedule | Daily time (default 06:00) and "start with Windows" |
| Claude Desktop | Adds `forma-data` to `claude_desktop_config.json` (both Claude Desktop install types are handled; files are backed up first) |
| Dashboard skill | Save a ZIP to upload in Claude, and/or install for Claude Code |
| Finish | Optionally starts the first sync |

Then **fully quit Claude Desktop** (tray icon → Quit) and open it again so it loads the new server.

You can re-run any step later from **Settings → Run the setup wizard again**.

## Where things are stored

| What | Where |
|---|---|
| App | `%LOCALAPPDATA%\Programs\forma-data-manager` |
| Settings, encrypted tokens, sync history | `%APPDATA%\Forma Data Manager` |
| Logs | `%APPDATA%\Forma Data Manager\logs\forma-data-manager.log` |
| Databases, `current.json`, temporary downloads | The data folder you chose (default `%LOCALAPPDATA%\FormaData`) |
| Claude Desktop config | `%APPDATA%\Claude\claude_desktop_config.json` (standard installer) or `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` (Microsoft Store/MSIX) |

## Upgrading

Install the new version over the old one. Settings, sign-in, schedule and data are kept, and the Claude Desktop entry keeps working because the app's path doesn't change. If the release notes say the database layout changed, run **Sync now** afterwards.

### Upgrading from v3

v3 was a set of scripts (`server.js`, `build-cache.js`, ZIP drop folder, `acc-data` server). v4 replaces all of it:

- The **Claude Desktop setup** step removes the old `acc-data` entry (leave the checkbox on) and adds `forma-data`, after making a backup.
- Tool names changed from `acc_*` to `forma_*`. Install the new dashboard skill, which uses the new names, and remove or disable the old skill in Claude.
- Old databases and ZIPs aren't used. Delete them when you're happy with v4.

## Uninstall

Use **Windows Settings → Apps → Forma Data Manager → Uninstall**. The uninstaller also:

- removes the `forma-data` entry from Claude Desktop's config (after a backup), and
- removes the "start with Windows" entry.

It **keeps** your data folder and `%APPDATA%\Forma Data Manager` in case you reinstall. Delete those two folders by hand to remove everything. To also remove the Data Connector request history the app created, open Data Connector in Forma: the app only ever creates one-time requests, and it deletes its older ones after each successful sync.

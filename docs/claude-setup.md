# Claude Desktop, Claude Code and the dashboard guide

## Claude Desktop (automatic)

**Claude setup → Set up Claude Desktop** in the app (also a step in the wizard):

1. Finds Claude Desktop's config for your Windows user. There are two possible locations:
   - Standard installer: `%APPDATA%\Claude\claude_desktop_config.json`
   - Microsoft Store / MSIX: `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json`
2. Backs up each existing file (`claude_desktop_config.json.bak-<timestamp>`).
3. Adds or updates `mcpServers["forma-data"]` and leaves every other server and setting untouched.
4. Never writes to a file it can't parse; that location is reported as an error instead.

Then fully quit Claude Desktop (tray icon → **Quit**) and open it again.

## Claude Desktop (manual)

```json
{
  "mcpServers": {
    "forma-data": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\forma-data-manager\\resources\\engine\\forma-data.exe",
      "args": ["serve"],
      "env": { "FORMA_DATA_DIR": "C:\\Users\\<you>\\AppData\\Local\\FormaData" }
    }
  }
}
```

No Bun or Node is needed. `forma-data.exe` is self-contained.

## Claude Code

The app shows this command with your paths filled in (Claude setup → Claude Code):

```powershell
claude mcp add forma-data --scope user -e FORMA_DATA_DIR="C:\Users\<you>\AppData\Local\FormaData" -- "C:\Users\<you>\AppData\Local\Programs\forma-data-manager\resources\engine\forma-data.exe" serve
```

Claude Desktop and Claude Code can use the same data folder at the same time. Each runs its own read-only server, and both follow `current.json` when a new build lands.

## The dashboard guide

The guide teaches Claude the dashboard layout (header with "Data as of", KPI strip, overview chart, details, notes, drill-downs) and the data rules: status groups, change-order chains, variance sign, fan-out, and demo-project labeling. The source is [`claude-plugin/skills/forma-data-dashboards/SKILL.md`](../claude-plugin/skills/forma-data-dashboards/SKILL.md).

### Built in (nothing to install)

The forma-data server serves the guide as the **`forma_dashboard_guide`** tool, and its instructions tell Claude to call it once before building any dashboard, chart or visual summary. It works the moment Claude Desktop is set up, in Chat, Cowork and Claude Code. The same text is also available as the `forma_dashboard` prompt (Claude Desktop: **+** menu → forma-data).

### Optional: as a skill

Claude doesn't let other apps add skills or plugins to your account, so these are one-time steps in Claude itself. Pick one:

| Option | How |
|---|---|
| **Plugin (updates itself)** | In Claude: **Customize → Plugins → Add → Add marketplace → Add from a repository**, enter `arqfernandolima-rgb/forma-data-manager`, then install **forma-data**. New versions arrive when the repo updates. Plugins need a paid Claude plan |
| **Uploaded skill (customizable)** | In Forma Data Manager: **Claude setup → Save skill ZIP**. Then in Claude: **Customize → Skills → + → Create skill → Upload a skill** and pick the ZIP. Skills need code execution on (**Settings → Capabilities**) |
| **Claude Code** | `/plugin install forma-data --marketplace arqfernandolima-rgb/forma-data-manager` (Claude Code 2.1.275 or later), or on older versions `claude plugin marketplace add arqfernandolima-rgb/forma-data-manager` then `claude plugin install forma-data@forma-data`. Or click **Install for Claude Code** in the app to copy the skill to `%USERPROFILE%\.claude\skills` |
| **Team / Enterprise** | An owner can provision the skill for the whole organization from the ZIP, or add the marketplace for everyone |

When the skill is loaded, Claude skips `forma_dashboard_guide` (it's the same content).

**Customize before saving** (in the app) opens the SKILL.md text so you can change colors, KPIs or tone, or rename the skill (the folder name follows the `name:` line). The app checks the front matter before packaging.

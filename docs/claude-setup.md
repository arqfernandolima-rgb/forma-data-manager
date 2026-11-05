# Claude Desktop, Claude Code and the dashboard skill

## Claude Desktop (automatic)

**Claude setup → Set up Claude Desktop** in the app (also a step in the wizard):

1. Finds Claude Desktop's config for your Windows user. There are two possible locations:
   - Standard installer: `%APPDATA%\Claude\claude_desktop_config.json`
   - Microsoft Store / MSIX: `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json`
2. Backs up each existing file (`claude_desktop_config.json.bak-<timestamp>`).
3. Adds or updates `mcpServers["forma-data"]` and leaves every other server and setting untouched.
4. Optionally removes the old v3 `acc-data` entry.
5. Never writes to a file it can't parse; that location is reported as an error instead.

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

## The dashboard skill

`skill/forma-data-dashboards/SKILL.md` teaches Claude the dashboard layout (header with "Data as of", KPI strip, overview chart, details, notes, drill-downs) and the data rules: status groups, change-order chains, variance sign, fan-out, and demo-project labeling.

| Where | How |
|---|---|
| Claude Desktop / claude.ai | **Save skill ZIP** in the app, then in Claude: **Settings → Capabilities** → make sure code execution is on → **Skills → Upload skill** → pick the ZIP. Skills are per account and can't be installed by another program |
| Claude Code | **Install for Claude Code** copies it to `%USERPROFILE%\.claude\skills\forma-data-dashboards` |
| No install | The MCP server exposes the same guidance as the `forma_dashboard` prompt |

**Customize before saving** opens the SKILL.md text so you can change colors, KPIs or tone, or rename the skill (the folder name follows the `name:` line). The app checks the front matter before packaging.

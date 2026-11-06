/**
 * MCP server (stdio). Connects first, then loads data, so clients never time out
 * on start-up even when the database is large.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from './store.js';
import { registerTools } from './tools.js';
import { ENGINE_VERSION } from '../version.js';
import dashboardGuide from '../../../claude-plugin/skills/forma-data-dashboards/SKILL.md' with { type: 'text' };

export const INSTRUCTIONS = `Forma Data is a local, read-only SQLite snapshot of an Autodesk Forma (ACC / BIM 360) hub, built from a Data Connector extract.

Fast path
1. Call forma_overview once per conversation. Say "Data as of <as_of>" in answers; if it reports STALE, say so.
2. Projects: forma_find_projects. One project in depth: forma_project_summary (returns candidates if ambiguous).
3. Hub-wide rankings or comparisons: query project_rollup (one precomputed row per project) with forma_sql.
4. Everything else: forma_sql on the v_* views. Use forma_describe before filtering on a column whose values you haven't seen; it lists the real values.
5. Free text: forma_search. Unsure where something lives: forma_catalog with search=.

Rules that keep numbers right
- v_* views already exclude soft-deleted rows and resolve names. One row per base record; no deleted_at filter needed.
- Open/closed: use status_group ('draft','open','closed','void'; meeting items also 'info'). Raw statuses differ by module.
- Overdue and age are relative to as_of (is_overdue, days_overdue, age_days), not today.
- Booleans are 1/0. Timestamps are 'YYYY-MM-DD HH:MM:SS' UTC; compare with date(col).
- Change orders: use v_change_order_chains for exposure. Never SUM amounts over v_change_orders (one change spans several forms).
- Cost: forecast_variance < 0 = projected overrun; rank risk on negative variance only, with % of revised budget. Sum budget lines with has_children = 0.
- Aggregate in SQL. Joining two one-to-many tables multiplies rows: aggregate each in a CTE, then join.
- is_production = 0 or looks_like_test = 1 marks demo/template/training projects: include, but label them.
- NULL in project_rollup = module has no data for that project ("module empty"), not zero.
Dashboards, charts and visual summaries: call forma_dashboard_guide once first (skip it if the forma-data-dashboards skill is already loaded; it's the same guide).`;

/** The skill text without its front matter: served by the guide tool and the prompt. */
export const DASHBOARD_GUIDE = dashboardGuide.replace(/^---[\s\S]*?---\s*/, '');

export async function startServer({ dataDir }) {
  const log = (msg) => process.stderr.write(`[forma-data] ${msg}\n`);
  const store = new Store(dataDir, log);
  const server = new McpServer({ name: 'forma-data', version: ENGINE_VERSION }, { instructions: INSTRUCTIONS });

  registerTools(server, store);

  // The dashboard skill, built in: Claude loads it on demand like a skill, with nothing to install.
  // Works in every MCP client (Claude Desktop chat, Cowork, Claude Code).
  server.registerTool(
    'forma_dashboard_guide',
    {
      title: 'Dashboard guide',
      description:
        'Call once, before building any dashboard, chart, report or visual summary from Forma data. Returns the house style (layout, KPI tiles, colors, Chart.js setup, drill-downs) and the data rules that keep the numbers right. Not needed for plain-text answers, or if the forma-data-dashboards skill is already loaded.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => ({ content: [{ type: 'text', text: DASHBOARD_GUIDE }] })
  );

  server.registerPrompt(
    'forma_dashboard',
    {
      title: 'Build a Forma dashboard',
      description: 'Dashboard house style and data rules for Forma data, plus your request.',
      argsSchema: { request: z.string().optional().describe('What the dashboard should show, e.g. "RFI aging for all active projects"') },
    },
    ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${DASHBOARD_GUIDE}\n\n---\n\nRequest:${request || 'Ask me which project(s) and module(s), then build the dashboard.'}`,
          },
        },
      ],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${ENGINE_VERSION} connected; data folder: ${dataDir}`);
  setTimeout(() => store.start(), 50);
}

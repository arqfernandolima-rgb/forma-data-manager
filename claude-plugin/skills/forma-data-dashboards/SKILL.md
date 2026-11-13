---
name: forma-data-dashboards
description: Quick, accurate dashboards and answers from the Forma Data MCP (forma-data). Use whenever the user asks for a summary, status, risk view, KPIs, ranking or dashboard on Autodesk Forma / ACC / BIM 360 projects, issues, RFIs, submittals, cost, change orders, contracts, assets, schedule, forms, checklists, takeoff or meeting minutes, even if they never say dashboard.
---

# Forma data dashboards

Turn a question about the user's Autodesk Forma (formerly Autodesk Construction Cloud) data into **one quick dashboard drawn right in the chat**. The data comes from the local `forma-data` MCP server: a read-only SQLite snapshot of a Data Connector extract.

This guide is also built into the server as the `forma_dashboard_guide` tool. If you already have it from either place, don't load it again. For Forma data it replaces generic dashboard, data-visualization or report skills (for example a data plugin's "build dashboard"): don't load those as well.

**Two things matter every time: the numbers are right, and the answer comes fast.** Everything below serves those two.

## Quick by default

- **Budget: about 4 tool calls before you draw.** `forma_overview` (once per conversation), `forma_find_projects` or `forma_project_summary`, then one or two `forma_sql` queries using the recipes below. Don't explore the schema; use `forma_describe` only before filtering on a column whose values you haven't seen.
- **Defaults, not questions.** Pick sensible scope, say it in one line, and build: when a name matches a live project and a sandbox or template, use the live one (`is_production = 1`, `looks_like_test = 0`). Ask only when several real projects match.
- **Where to draw.** If the chat has an inline visual tool (for example `show_widget`), use it. Otherwise make **one small, self-contained HTML artifact**. Don't use dashboard, data or spreadsheet artifact types, don't upload datasets or files, don't save the data to disk, and don't wire up connectors, storage or live refresh. Aggregate in SQL and type the results straight into the page.
- **Size.** A header, 4 to 6 KPI tiles, at most 2 small visuals, one short list (8 rows, the rest behind "+ N more"), and a one-line caveat. No tabs, filters, search boxes, multiple pages or settings. Draw bars with plain HTML/CSS (they render instantly); load Chart.js only for a trend over time. Keep the page under about 150 lines.
- **Bigger only when asked.** Build a full, interactive or shareable dashboard only when the user asks for one ("full dashboard", "something I can share", "interactive", "export").

## Accuracy checklist (before you draw)

1. Every number comes from a query in this conversation. Never estimate, extrapolate or fill gaps.
2. Parts add up to totals: status counts sum to the total, open by category sums to open. A mismatch is a query bug (usually a fan-out). Fix the query; never explain it away on the page.
3. The header says **"Data as of <as_of>"** (every tool result carries `as_of`). If `forma_overview` says STALE, say so.
4. Overdue and age are measured against `as_of`, not today.
5. Anything derived is labeled "est." with how it was derived.

## Data rules (built into the views; keep to them)

- **Views are canonical.** `v_*` views exclude soft-deleted rows, add `status_group`, `is_overdue`, `days_overdue`, `age_days`, and resolve names with lookups that can't duplicate rows. Prefer them to raw tables.
- **Who holds it.** `assignee_name` (issues, forms), `manager_name` (RFIs, submittals), `subcontractor_name` and `ball_in_court_names` (submittals) are users, companies or roles; `assignee_type` / `manager_type` say which. Group by the name. A NULL name with an ID means the extract doesn't list that party: show "(not in extract)", not "unassigned".
- **Open vs closed:** `status_group` (`draft`, `open`, `closed`, `void`; meeting items also `info`). "Completed" issues and "answered" RFIs are still open until someone closes them.
- **Booleans** are 1/0. **Timestamps** are `YYYY-MM-DD HH:MM:SS` UTC; compare with `date(col)`.
- **Fan-out:** joining two one-to-many tables multiplies rows. Aggregate each module in its own CTE, then join the CTEs.
- **Change orders are chains:** use `v_change_order_chains` (one row per change, `exposure`, `open_legs`). Never sum `proposed` over `v_change_orders`.
- **Cost variance:** `forecast_variance < 0` is a projected overrun (`is_overrun = 1`). Rank on the adverse direction only (never `ABS()`), with % of revised budget. Sum budget lines with `has_children = 0`.
- **Demo and template projects** (`is_production = 0` or `looks_like_test = 1`): label them; don't present them as live risk.
- **Empty modules:** NULL in `project_rollup` means no data for that project. Say "module empty", not 0.
- **Meeting items:** report open items without a due date as their own number.

## Recipes

Replace `<project_id>` with the `project_id` from `forma_find_projects`. Each recipe is one call.

**One project, one module: KPIs and every breakdown at once** (issues shown; swap the view and columns for others):

```sql
WITH i AS (SELECT * FROM v_issues WHERE bim360_project_id = '<project_id>')
SELECT 'kpi' f, NULL k, COUNT(*) n, SUM(status_group = 'open') open_n, SUM(status_group = 'closed') closed_n, SUM(is_overdue) overdue FROM i
UNION ALL SELECT 'status', status, COUNT(*), SUM(status_group = 'open'), SUM(status_group = 'closed'), SUM(is_overdue) FROM i GROUP BY 2
UNION ALL SELECT 'type', type_name, COUNT(*), SUM(status_group = 'open'), SUM(status_group = 'closed'), SUM(is_overdue) FROM i GROUP BY 2
UNION ALL SELECT 'who', COALESCE(assignee_name, CASE WHEN assignee_id IS NULL THEN '(unassigned)' ELSE '(not in extract)' END), COUNT(*), SUM(status_group = 'open'), NULL, SUM(is_overdue) FROM i GROUP BY 2
UNION ALL SELECT 'created', substr(created_at, 1, 7), COUNT(*), NULL, NULL, NULL FROM i GROUP BY 2
UNION ALL SELECT 'closed', substr(closed_at, 1, 7), COUNT(*), NULL, NULL, NULL FROM i WHERE status_group = 'closed' GROUP BY 2
```

| Module | View | Type column | Who column |
|---|---|---|---|
| Issues | `v_issues` (BIM 360: `v_all_issues`) | `type_name` | `assignee_name` |
| RFIs | `v_rfis` | `priority` | `manager_name` |
| Submittals | `v_submittals` | `type` | `ball_in_court_names` |
| Forms | `v_forms` | `template_name` | `assignee_name` |

**Most overdue open items** (the short list):

```sql
SELECT display_id, title, status, assignee_name, date(due_date) due, days_overdue
FROM v_issues WHERE bim360_project_id = '<project_id>' AND status_group = 'open' AND is_overdue = 1
ORDER BY days_overdue DESC LIMIT 8
```

**Across projects:** rank from `project_rollup` (one precomputed row per project), then detail the top few with the recipes above.

## Look

Use the host's CSS variables when present (`--color-text-primary`, `--color-text-secondary`, `--color-background-secondary`, `--color-border-tertiary`) so light and dark both work; fall back to neutral grays. Badges: red `#791F1F` on `#FCEBEB`, amber `#8B4513` on `#FAEEDA`, green `#27500A` on `#EAF3DE`, blue `#0C447C` on `#E6F1FB`. Series: `#185FA5`, `#1D9E75`, `#B45309`, `#7C3AED`, `#888780`. Color a value only when it means something (red bad, amber watch, green good).

Starter (adapt it; HTML fragment only):

```html
<div style="font-size:13px;display:flex;flex-direction:column;gap:12px;padding:.5rem 0">
  <div style="border-left:3px solid #185FA5;padding:4px 12px">
    <div style="font-size:15px;font-weight:600">PROJECT · MODULE</div>
    <div style="font-size:12px;opacity:.7">Scope line · Data as of DATE</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
    <div style="background:var(--color-background-secondary,#f4f4f2);border-radius:6px;padding:8px 10px"><div style="font-size:11px;opacity:.7">Open</div><div style="font-size:18px;font-weight:600">262</div></div>
  </div>
  <div><div style="font-size:12px;opacity:.7;margin-bottom:4px">Open by type</div>
    <div style="display:flex;align-items:center;gap:8px"><span style="width:35%">Clash</span><div style="flex:1;height:8px;background:var(--color-background-secondary,#eee);border-radius:4px"><div style="width:60%;height:100%;background:#185FA5;border-radius:4px"></div></div><span>155</span></div>
  </div>
  <details><summary style="cursor:pointer;font-size:12px">Most overdue · + N more</summary><!-- rows --></details>
  <div style="font-size:12px;opacity:.7">One-line caveat.</div>
</div>
```

In hosts that support it, 2 or 3 buttons with `sendPrompt('…')` can offer the obvious next questions; the prompt must name the project and module. Skip them in artifacts.

## After the dashboard

Two or three sentences: the headline finding, the one thing worth attention, and any caveat. Don't repeat numbers the dashboard already shows.

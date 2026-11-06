---
name: forma-data-dashboards
description: Build fast, accurate dashboards and answers from the Forma Data MCP (forma-data). Use whenever the user asks for a summary, status, risk view, KPIs, ranking, or any dashboard on Autodesk Forma / ACC / BIM 360 projects, issues, RFIs, submittals, cost, change orders, contracts, assets, schedule, forms, checklists, takeoff, or meeting minutes, even if they never say dashboard.
---

# Forma data dashboards

Turn questions about the user's Autodesk Forma (formerly Autodesk Construction Cloud) data into a single inline dashboard: key numbers on top, details underneath, drill-downs where they help. The data comes from the local `forma-data` MCP server, which serves a read-only SQLite snapshot built from a Data Connector extract.

This same guide is built into the forma-data server as the `forma_dashboard_guide` tool. If you already have it from either place, don't load it again.

Speed matters. The user wants the dashboard, not a questionnaire. Pick sensible defaults, say which ones you picked in one line, and build. Only ask when the request is truly ambiguous (for example "my project" and several projects match).

## Freshness

Every number is as fresh as the last Data Connector sync. Call `forma_overview` once per conversation and print **"Data as of <as_of>"** in the dashboard header. If `freshness` says STALE, add one line saying so. Never imply the numbers reflect today.

## Tools (fast path)

| Need | Tool |
|---|---|
| Freshness, modules, views, conventions | `forma_overview` (once) |
| Which / how many projects | `forma_find_projects` |
| One project in depth | `forma_project_summary` (returns candidates if the name is ambiguous; never merges projects) |
| Hub-wide ranking or comparison | `forma_sql` on `project_rollup` (one precomputed row per project) |
| Real column values before filtering | `forma_describe` |
| Where is X stored? | `forma_catalog` with `search=` |
| Free-text ("leak", "fire pump") | `forma_search` |
| Anything else | `forma_sql` on the `v_*` views |

Tools may appear as `forma_*`, `mcp__forma-data__*`, or with a device prefix, and may be deferred; load them in one ToolSearch call if needed.

## Steps

1. **Scope**: resolve project(s) and module(s). For "all my projects", rank from `project_rollup` first, then detail the top few.
2. **Query in as few calls as possible**: one query for the KPI strip, one for the detail table. Aggregate in SQL; results are capped.
3. **Reconcile before rendering**: parts must add up to totals (status counts sum to the total, by-type totals match the headline). A mismatch means a join fan-out or double count: fix the query, never explain it away in the UI.
4. **Render once**: with the inline visualization tool if available (for example `show_widget`), otherwise as an HTML artifact.
5. **Follow up in 2 to 4 sentences**: the headline finding, the thing most worth attention, and any caveat. Don't repeat numbers the dashboard already shows.

## Data rules (built into the views; keep to them)

- **Views are canonical.** `v_*` views exclude soft-deleted rows, resolve project/user/type names with lookups that can't duplicate rows, and add `status_group`, `is_overdue`, `days_overdue`, `age_days`. Prefer them to raw tables.
- **Open vs closed**: use `status_group` (`draft`, `open`, `closed`, `void`; meeting items also `info`). Raw status vocabularies differ by module and by capitalization.
- **Overdue and age** are measured against the extraction date (`as_of`), not today.
- **Booleans** are 1/0. **Timestamps** are `YYYY-MM-DD HH:MM:SS` (UTC); compare with `date(col)`.
- **Fan-out**: joining two one-to-many tables multiplies rows (this has inflated takeoff totals by 700x and doubled duct counts). Aggregate each module in its own CTE, then join the CTEs.
- **Change orders are chains**: one real change appears as PCO, RFQ, RCO, OCO and SCO rows with the same name. Use `v_change_order_chains` (one row per change, `exposure` = largest proposed amount, `open_legs` = forms not yet executed/approved/accepted/rejected/void). Never sum `proposed` over `v_change_orders`. Stuck legs matter more than totals, e.g. an executed OCO whose RFQ is still proposed.
- **Variance sign**: `forecast_variance < 0` is a projected overrun (`is_overrun = 1`). Rank risk on the adverse direction only; never `ABS()`. Pair dollars with % of revised budget: an overrun of 0.6% on a very large budget is a different story than 16% on a small one. Sum budget lines with `has_children = 0`.
- **Estimates**: if a number is derived (for example linear feet from standard segment lengths), label it "est." and say how in the note.
- **Demo and template projects**: `is_production = 0` or `looks_like_test = 1`. Don't hide them; tag them so they aren't mistaken for live risk.
- **Empty modules**: NULL in `project_rollup` means the module has no data for that project. Say "module empty" rather than showing zeros that look like good news.
- **Meeting items**: many open items have no due date; report `meeting_items_open_no_due_date` as its own metric.
- **Assets**: each asset has exactly one status (`status_label`, ordered by `status_sort_order`), so status counts must sum to the total.

## Layout (house style)

Top to bottom:

1. **Header**: title, one context line (scope, counts), and "Data as of DATE". Secondary background, 3px left accent border.
2. **KPI strip**: 6 to 8 small tiles (label 11px muted, value 15 to 18px bold). Color a value only when it carries meaning (red = bad, amber = watch, green = good).
3. **Overview visual** (only if it earns its place): stacked bar for status pipelines, doughnut for share of total, bar chart for comparisons. Chart.js 4.4.1 from cdnjs; give each canvas `role="img"` and an `aria-label`.
4. **Details**: cards with tables, progress bars and badges. Status first, then type or category, then quantities. Show percent of total next to absolute numbers whenever composition or progress matters.
5. **Note box**: why this matters, plus caveats (estimates, demo data, stale dates, unpriced items).

When ranking projects, show a rank badge (#1 Critical, #2 High, #3 Watch) and, for each, a short "Why this needs attention" with concrete evidence (the stuck item, the date, the amount), not generic risk language. Say in the header how the ranking works so the user can challenge it.

## Drill-down

- **Expand/collapse** when the rows are already in hand: `<details><summary>` for long lists, about 8 rows visible, then "+ N more".
- **Prompt drill-down** (in hosts that support it): `<button onclick="sendPrompt('...')">Label ↗</button>`. The prompt must be self-contained (project, module, what to show). Offer 2 or 3 obvious next questions, not one per row.

## Risk tiers

Use the same four tiers everywhere: **Critical** (red), **High** (amber), **Watch** (blue), **OK** (green). For project ranking, combine adverse variance, open change-order exposure (from chains), open cost-impact RFIs, and overdue counts, and explain the formula in the header.

## Visual tokens

Use the host's CSS variables when present (`--color-background-primary`, `--color-background-secondary`, `--color-border-tertiary`, `--color-text-primary`, `--color-text-secondary`, `--color-text-danger`, `--border-radius-md`, `--border-radius-lg`) so light and dark both work; fall back to neutral grays. Badges: red `#791F1F` on `#FCEBEB`, amber `#8B4513` on `#FAEEDA`, green `#27500A` on `#EAF3DE`, blue `#0C447C` on `#E6F1FB`. Chart series: `#185FA5`, `#7C3AED`, `#27500A`, `#B45309`, `#D85A30`, `#888780`. For Chart.js text and grid colors, read `matchMedia('(prefers-color-scheme: dark)')`.

## Starter skeleton

Adapt it, don't copy it blindly. HTML fragment only:

```html
<style>
*{box-sizing:border-box;margin:0;padding:0}
.wrap{padding:.75rem 0;display:flex;flex-direction:column;gap:12px;font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap}
.kpi{flex:1;min-width:90px;background:var(--color-background-secondary,#f4f4f2);border-radius:var(--border-radius-md,6px);padding:9px 12px;text-align:center}
.kl{font-size:11px;color:var(--color-text-secondary,#666);margin-bottom:3px}
.kv{font-size:16px;font-weight:600}
.card{background:var(--color-background-primary,#fff);border:0.5px solid var(--color-border-tertiary,#ddd);border-radius:var(--border-radius-lg,8px);overflow:hidden}
.ch{padding:10px 14px;border-bottom:0.5px solid var(--color-border-tertiary,#ddd);font-size:12px;font-weight:600;color:var(--color-text-secondary,#666);text-transform:uppercase;letter-spacing:.05em}
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{font-size:11px;font-weight:500;color:var(--color-text-secondary,#666);text-align:left;padding:5px 10px;border-bottom:0.5px solid var(--color-border-tertiary,#ddd)}
.tbl td{padding:6px 10px;border-bottom:0.5px solid var(--color-border-tertiary,#eee)}
.bdg{display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:3px}
.cr{background:#FCEBEB;color:#791F1F}.hi{background:#FAEEDA;color:#8B4513}.ok{background:#EAF3DE;color:#27500A}.bl{background:#E6F1FB;color:#0C447C}
.bar-bg{background:var(--color-background-secondary,#eee);border-radius:3px;height:8px;overflow:hidden}
.bar-f{height:100%;border-radius:3px}
</style>
<div class="wrap">
  <div style="background:var(--color-background-secondary,#f4f4f2);border-radius:var(--border-radius-md,6px);padding:10px 14px;border-left:3px solid #185FA5">
    <div style="font-size:14px;font-weight:600">TITLE</div>
    <div style="font-size:12px;color:var(--color-text-secondary,#666);margin-top:2px">Scope line · Data as of DATE</div>
  </div>
  <div class="row"><!-- 6-8 .kpi tiles --></div>
  <div class="card"><div class="ch">Overview</div><div style="padding:12px 14px"><!-- pipeline bar or chart --></div></div>
  <div class="card"><div class="ch">Details</div><!-- table or cards; details/summary for long lists --></div>
  <div style="background:var(--color-background-secondary,#f4f4f2);border-radius:var(--border-radius-md,6px);padding:10px 14px;font-size:12px;color:var(--color-text-secondary,#666);line-height:1.6"><strong style="color:var(--color-text-primary,#222)">Note:</strong> caveats and why it matters.</div>
</div>
```

Load Chart.js with `<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>` after the markup, and keep charts small (150 to 180px tall).

## Tone

Friendly and plain. Lead with what matters, and flag uncertainty and estimates honestly instead of smoothing them over.

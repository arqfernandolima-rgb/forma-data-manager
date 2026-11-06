# Data model and accuracy rules

The database is a read-only SQLite file built from one Data Connector extract. It contains every table from the extract, plus views and summaries designed so that the obvious query is also the correct one.

## Raw tables

- One table per CSV, named like the file: `<service>_<table>` (`issues_issues`, `rfis_rfis`, `cost_budgets`, …). Even an empty CSV creates its (empty) table, so a missing module returns 0 rows instead of "no such table".
- Tables are `STRICT`. Column types come from the **official Data Connector schema** (`schemas/schema.json`, shipped inside every extract), not from guessing:

| Schema type | Stored as | Rule |
|---|---|---|
| `number` | INTEGER or REAL | Only clean numbers convert. `0` stays `0` (a common loader bug turns zeros into NULL). Values with leading zeros (`007`) or letters (`SUB-14-000-0001`) are kept as text and counted as anomalies |
| `boolean` | 1 / 0 | `t`, `true`, `1` → 1; `f`, `false`, `0` → 0. All three encodings appear in real extracts |
| `timestamp: SQL` | text `YYYY-MM-DD HH:MM:SS` | Sub-second precision and `Z`/`UTC` suffixes are normalized. Values are UTC as delivered |
| `date: string` | text `YYYY-MM-DD` | |
| everything else | text | IDs, codes, job numbers and postal codes keep leading zeros |

- Every value is trimmed. Stray tabs and trailing spaces would otherwise split groups (`"Canal / Waterway"` vs `"Canal / Waterway "`).
- Nothing is dropped: a value that doesn't fit its declared type is kept as text and reported in `_columns.anomalies`.

## Views (`v_*`)

All views follow the same rules:

1. **Soft-deleted rows excluded**, but only when the table has `deleted_at`. If a column doesn't exist in this extract, the view returns NULL for it instead of failing.
2. **Lookups can't multiply rows.** Project, user, company and type names are scalar lookups (`SELECT … LIMIT 1`), not JOINs, so a view always has exactly one row per base record. A real hub had a duplicated user ID; with JOINs, that duplicates every issue assigned to them.
3. **`status_group`** normalizes each module's status vocabulary.
4. **`is_overdue`, `days_overdue`, `age_days`** are measured against the extraction date (`as_of`), not today, so a two-week-old snapshot doesn't look worse every day.

| View | One row per | Highlights |
|---|---|---|
| `v_projects` | project | `project_id`, `project_name`, `status`, `project_type`, `classification`, `is_production`, `looks_like_test` |
| `v_issues`, `v_issues_bim360` | issue | type, subtype, root cause, assignee/creator/owner names |
| `v_all_issues` | issue | both, with `source` = `acc` / `bim360` |
| `v_rfis` | RFI | manager, `cost_impact`, `schedule_impact`, `official_response` |
| `v_submittals` | submittal item | `status` (= status_value), `response`, spec, package, ball in court |
| `v_assets` | asset | `category_name`, `status_label` + `status_sort_order` (workflow stage), company |
| `v_checklists` | checklist | progress, item counts, template title (`scheduled_date` drives overdue) |
| `v_meetings` | meeting | |
| `v_meeting_items` | action item | meeting title/date, topic, `assignee_names` |
| `v_daily_logs` | daily log | |
| `v_reviews` | document review | approved/rejected counts, step progress (`next_due_date` drives overdue) |
| `v_forms` | form | template name/type, assignee |
| `v_cost_budgets` | budget line | all budget figures, contract, `is_overrun`, `has_children` |
| `v_cost_contracts` | contract | company, awarded/revised/forecast figures, `is_overrun` |
| `v_change_orders` | change-order form | `form_type` (pco/rfq/rco/oco/sco), statuses, amounts, `chain_key` |
| `v_change_order_chains` | real change | `form_types`, `exposure`, `open_legs` |
| `v_schedule_activities` | activity | schedule name, `completion_pct` (0–100), `is_late` |
| `v_takeoff_quantities` | takeoff quantity | package, takeoff type, object, quantity, cost |

### `status_group` mapping

| Module | draft | closed | void | open (everything else) |
|---|---|---|---|---|
| Issues (ACC, BIM 360) | draft | closed | void, deleted | open, pending, in_progress, in_review, completed, in_dispute, not_approved, answered, work_completed, ready_to_inspect |
| RFIs | draft | closed | void | submitted, open, openRev*, answered, answeredRev*, answeredManager |
| Submittals | Draft | Closed | Void | Open, Required |
| Checklists | — | Completed | — | Not Started, In Progress |
| Forms | draft | closed, archived, submitted | discarded | in_progress, in_review |
| Reviews | — | closed, completed | void | open |
| Meeting items | — | closed, resolved | — | open, ongoing, on-hold (and `info` for information items) |

"Open" deliberately means **not finished**. For example, a "completed" ACC issue still waits for the creator to close it. Use the raw `status` column when you need finer distinctions; `forma_describe` lists the real values.

### Cost rules

- `forecast_variance < 0` is a **projected overrun** (`is_overrun = 1`). Rank risk on negative variance only, and show it as a percentage of the revised budget as well as in dollars.
- `v_cost_budgets.has_children = 1` marks parent lines. Sum lines with `has_children = 0` to avoid double counting.
- **Change orders are chains.** One real change typically appears as several forms (PCO → RFQ → RCO → OCO/SCO) sharing a name. Summing `proposed` across `v_change_orders` counts the same dollars up to five times. `v_change_order_chains` groups them by project + normalized name:
  - `exposure` = the largest proposed amount in the chain
  - `open_legs` = forms whose status isn't executed/approved/accepted/rejected/void/closed

### Projects that aren't real

Hubs used for demos and training carry many sample, template and training projects. `v_projects.is_production` comes from the hub's own classification. `looks_like_test` flags names or types containing demo, sandbox, test, template, training, POC, sample, dummy or playground. Neither flag removes anything; the intent is to **label** these projects, not hide them.

## `project_rollup` (precomputed)

One row per project, built from the views: open/overdue counts for issues, RFIs (plus open cost-impact RFIs), submittals, meeting items (plus open without a due date), checklists and forms; asset totals; budget original/revised/forecast/variance/actual (leaf lines only); open change-order chains and their exposure; late schedule activities.

**NULL means the module has no data for that project** ("module empty"), not zero. Hub-wide rankings are a single query on this table.

## Internal tables

| Table | Contents |
|---|---|
| `_meta` | Build info: `as_of`, extraction timestamps and region, engine/schema version, counts, warnings, `build_complete` |
| `_tables` | Per table: module, rows, active rows, projects, status column, created_at range, parse errors, anomalies |
| `_columns` | Per column (tables and views): kind, Autodesk's description, filled count, distinct count, min/max, top values with counts |
| `_views` | Per view: status (`ok`/`skipped`/`error`), rows, description |
| `_status_counts` | Per table × project × status: counts (powers `forma_project_summary`) |
| `_fts` | FTS5 search index over the main text columns of 20+ tables |
| `metadata` | The extract's own metadata row (from `metadata.csv`) |

## Verifying a build yourself

```sql
-- every view should have the same row count as its base table's active rows
SELECT name, status, rows FROM _views;
SELECT table_name, rows, active_rows FROM _tables WHERE table_name IN ('issues_issues', 'rfis_rfis');
-- values that didn't fit the official type (kept as text)
SELECT table_name, column_name, anomalies, anomaly_example FROM _columns WHERE anomalies > 0;
```

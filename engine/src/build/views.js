/**
 * Analytical views.
 *
 * Rules every view follows (these are what make answers repeatable):
 *  1. Built defensively: a column that doesn't exist in this extract becomes NULL,
 *     a soft-delete filter is only applied when the table has deleted_at,
 *     and a view whose base table is missing is skipped (and reported).
 *  2. Lookups (project name, user name, type name, ...) are scalar subqueries,
 *     never JOINs. A view always has exactly one row per base row, so
 *     COUNT(*) on a view can't be inflated by duplicate lookup rows.
 *  3. status_group normalizes each module's status vocabulary to
 *     draft / open / closed / void (plus info for meeting items).
 *  4. "Today" is the extraction date (AS_OF), not the wall clock, so overdue and
 *     age figures describe the snapshot consistently.
 */

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function makeContext(db, asOf) {
  const cache = new Map();
  const cols = (t) => {
    if (!cache.has(t)) {
      let set = new Set();
      try {
        set = new Set(db.query(`PRAGMA table_info(${q(t)})`).all().map((r) => r.name));
      } catch {}
      cache.set(t, set);
    }
    return cache.get(t);
  };
  const has = (t, c) => (c ? cols(t).has(c) : cols(t).size > 0);
  return { db, asOf, has, cols, invalidate: (t) => cache.delete(t) };
}

/** Small query builder that degrades gracefully when columns are missing. */
class View {
  constructor(ctx, table, alias) {
    this.ctx = ctx;
    this.table = table;
    this.alias = alias;
    this.select = [];
    this.where = [];
  }
  ref(col) {
    return this.ctx.has(this.table, col) ? `${this.alias}.${q(col)}` : 'NULL';
  }
  col(col, as = col) {
    this.select.push(`${this.ref(col)} AS ${q(as)}`);
    return this;
  }
  cols(...names) {
    for (const n of names) this.col(n);
    return this;
  }
  /** Raw expression; `needs` lists base-table columns that must exist, else NULL. */
  expr(sql, as, needs = []) {
    const ok = needs.every((c) => this.ctx.has(this.table, c));
    this.select.push(`${ok ? sql : 'NULL'} AS ${q(as)}`);
    return this;
  }
  /** Scalar lookup: (SELECT value FROM table WHERE key = base.col [AND ...] LIMIT 1) */
  lookup(as, table, valueCol, keys) {
    const ok =
      this.ctx.has(table, valueCol) &&
      keys.every(([k, baseCol]) => this.ctx.has(table, k) && this.ctx.has(this.table, baseCol));
    if (!ok) {
      this.select.push(`NULL AS ${q(as)}`);
      return this;
    }
    const cond = keys.map(([k, baseCol]) => `lk.${q(k)} = ${this.alias}.${q(baseCol)}`).join(' AND ');
    this.select.push(`(SELECT lk.${q(valueCol)} FROM ${q(table)} lk WHERE ${cond} LIMIT 1) AS ${q(as)}`);
    return this;
  }
  project() {
    this.col('bim360_project_id');
    return this.lookup('project_name', 'admin_projects', 'name', [['id', 'bim360_project_id']]);
  }
  user(as, baseCol) {
    return this.lookup(as, 'admin_users', 'name', [['autodesk_id', baseCol]]);
  }
  activeOnly() {
    if (this.ctx.has(this.table, 'deleted_at')) this.where.push(`${this.alias}.deleted_at IS NULL`);
    return this;
  }
  filter(sql, needs = []) {
    if (needs.every((c) => this.ctx.has(this.table, c))) this.where.push(sql);
    return this;
  }
  sql() {
    const where = this.where.length ? `\nWHERE ${this.where.join(' AND ')}` : '';
    return `SELECT\n  ${this.select.join(',\n  ')}\nFROM ${q(this.table)} ${this.alias}${where}`;
  }
}

/** CASE expression mapping raw status text to a status group. NULL stays NULL. */
function statusGroup(expr, groups, fallback = 'open') {
  const parts = [];
  for (const [group, values] of Object.entries(groups)) {
    if (!values.length) continue;
    parts.push(`WHEN lower(trim(${expr})) IN (${values.map((v) => lit(v.toLowerCase())).join(', ')}) THEN ${lit(group)}`);
  }
  return `CASE WHEN ${expr} IS NULL THEN NULL ${parts.join(' ')} ELSE ${lit(fallback)} END`;
}

/** Wraps a view so derived columns (overdue, age) can reference status_group. */
function withDerived(inner, asOf, { due = 'due_date', created = 'created_at', openGroup = 'open' } = {}) {
  const AS = lit(asOf);
  const derived = [];
  if (due) {
    derived.push(
      `CASE WHEN status_group = ${lit(openGroup)} AND ${q(due)} IS NOT NULL AND date(${q(due)}) < date(${AS}) THEN 1 ELSE 0 END AS is_overdue`,
      `CASE WHEN status_group = ${lit(openGroup)} AND ${q(due)} IS NOT NULL AND date(${q(due)}) < date(${AS}) THEN CAST(julianday(date(${AS})) - julianday(date(${q(due)})) AS INTEGER) END AS days_overdue`
    );
  }
  if (created) {
    derived.push(`CASE WHEN ${q(created)} IS NOT NULL THEN CAST(julianday(date(${AS})) - julianday(date(${q(created)})) AS INTEGER) END AS age_days`);
  }
  return `SELECT *, ${derived.join(', ')} FROM (\n${inner}\n)`;
}

/** Which module each view belongs to (used by the catalog). */
export const VIEW_MODULE = {
  v_projects: 'admin',
  v_issues: 'issues',
  v_issues_bim360: 'issuesbim360',
  v_all_issues: 'issues',
  v_rfis: 'rfis',
  v_submittals: 'submittalsacc',
  v_assets: 'assets',
  v_checklists: 'checklists',
  v_meetings: 'meetingminutes',
  v_meeting_items: 'meetingminutes',
  v_daily_logs: 'dailylogs',
  v_reviews: 'reviews',
  v_forms: 'forms',
  v_cost_budgets: 'cost',
  v_cost_contracts: 'cost',
  v_change_orders: 'cost',
  v_change_order_chains: 'cost',
  v_schedule_activities: 'schedule',
  v_takeoff_quantities: 'takeoff',
};

const TEST_PATTERNS =['demo', 'sandbox', 'test', 'template', 'training', 'poc', 'sample', 'dummy', 'playground'];

// Each entry: { name, description, build(ctx) -> sql | null }
export const VIEW_DEFS = [
  {
    name: 'v_projects',
    description:
      'One row per project. is_production comes from the hub classification (production/sample/template/component); looks_like_test flags demo/sandbox/template/training names or types so they can be tagged, not silently hidden.',
    build(ctx) {
      if (!ctx.has('admin_projects')) return null;
      const v = new View(ctx, 'admin_projects', 'p');
      v.col('id', 'project_id').col('name', 'project_name').col('status');
      v.col(ctx.has('admin_projects', 'type') ? 'type' : 'project_type', 'project_type');
      v.cols('classification', 'job_number', 'value', 'currency', 'start_date', 'end_date', 'city', 'state_or_province', 'country', 'construction_type', 'contract_type', 'total_member_size', 'total_company_size', 'acc_project', 'created_at', 'updated_at', 'last_sign_in');
      v.lookup('business_unit', 'admin_business_units', 'name', [['id', 'business_unit_id']]);
      v.expr(`CASE WHEN p.classification IS NULL THEN NULL WHEN lower(p.classification) = 'production' THEN 1 ELSE 0 END`, 'is_production', ['classification']);
      const nameRef = v.ref('name');
      const typeRef = ctx.has('admin_projects', 'type') ? 'p."type"' : v.ref('project_type');
      const likes = TEST_PATTERNS.map((t) => `lower(COALESCE(${nameRef}, '')) LIKE '%${t}%' OR lower(COALESCE(${typeRef}, '')) LIKE '%${t}%'`).join(' OR ');
      v.expr(`CASE WHEN ${likes} THEN 1 ELSE 0 END`, 'looks_like_test');
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_issues',
    description: 'ACC issues (active only) with project, type, subtype, root cause, assignee and creator names, status_group, is_overdue, days_overdue, age_days.',
    build(ctx) {
      if (!ctx.has('issues_issues')) return null;
      const v = new View(ctx, 'issues_issues', 'i');
      v.col('issue_id').project().cols('display_id', 'title', 'description', 'status');
      v.expr(statusGroup('i.status', { draft: ['draft'], closed: ['closed'], void: ['void', 'deleted'] }), 'status_group', ['status']);
      v.lookup('type_name', 'issues_issue_types', 'issue_type', [['issue_type_id', 'type_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('subtype_name', 'issues_issue_subtypes', 'issue_subtype', [['issue_subtype_id', 'subtype_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('root_cause', 'issues_root_causes', 'title', [['root_cause_id', 'root_cause_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('root_cause_category', 'issues_root_cause_categories', 'root_cause_category', [['root_cause_category_id', 'root_cause_category_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.cols('assignee_id', 'assignee_type').user('assignee_name', 'assignee_id').user('created_by_name', 'created_by').user('owner_name', 'owner_id');
      v.cols('due_date', 'start_date', 'created_at', 'opened_at', 'closed_at', 'updated_at', 'location_details', 'response', 'published');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf);
    },
  },
  {
    name: 'v_issues_bim360',
    description: 'BIM 360 issues (active only), same shape as v_issues.',
    build(ctx) {
      if (!ctx.has('issuesbim360_issues')) return null;
      const v = new View(ctx, 'issuesbim360_issues', 'i');
      v.col('issue_id').project().cols('display_id', 'title', 'description', 'status');
      v.expr(statusGroup('i.status', { draft: ['draft'], closed: ['closed'], void: ['void', 'deleted'] }), 'status_group', ['status']);
      v.lookup('type_name', 'issuesbim360_issue_types', 'issue_type', [['issue_type_id', 'type_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('subtype_name', 'issuesbim360_issue_subtypes', 'issue_subtype', [['issue_subtype_id', 'subtype_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('root_cause', 'issuesbim360_root_causes', 'title', [['root_cause_id', 'root_cause_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('root_cause_category', 'issuesbim360_root_cause_categories', 'root_cause_category', [['root_cause_category_id', 'root_cause_category_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.cols('assignee_id', 'assignee_type').user('assignee_name', 'assignee_id').user('created_by_name', 'created_by').user('owner_name', 'owner_id');
      v.cols('due_date', 'start_date', 'created_at', 'opened_at', 'closed_at', 'updated_at', 'location_details', 'response', 'published');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf);
    },
  },
  {
    name: 'v_all_issues',
    description: 'v_issues and v_issues_bim360 combined, with a source column (acc / bim360).',
    after: ['v_issues', 'v_issues_bim360'],
    build(ctx, built) {
      const parts = [];
      if (built.has('v_issues')) parts.push(`SELECT 'acc' AS source, * FROM v_issues`);
      if (built.has('v_issues_bim360')) parts.push(`SELECT 'bim360' AS source, * FROM v_issues_bim360`);
      return parts.length ? parts.join('\nUNION ALL\n') : null;
    },
  },
  {
    name: 'v_rfis',
    description: 'RFIs (active only when the extract tracks deletion) with project, manager and creator names, status_group (submitted/open/openRevN/answered* count as open), is_overdue, days_overdue, age_days.',
    build(ctx) {
      if (!ctx.has('rfis_rfis')) return null;
      const v = new View(ctx, 'rfis_rfis', 'r');
      v.col('id', 'rfi_id').project().cols('custom_identifier', 'title', 'question', 'status');
      v.expr(statusGroup('r.status', { draft: ['draft'], closed: ['closed'], void: ['void'] }), 'status_group', ['status']);
      v.cols('priority', 'rfi_type', 'cost_impact', 'schedule_impact', 'reference', 'location_id');
      v.cols('due_date', 'created_at', 'opened_at', 'answered_at', 'responded_at', 'closed_at', 'updated_at');
      v.user('manager_name', 'manager_id').user('created_by_name', 'created_by').user('answered_by_name', 'answered_by');
      v.cols('official_response', 'official_response_status', 'suggested_answer');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf);
    },
  },
  {
    name: 'v_submittals',
    description: 'ACC submittal items (active only when tracked) with project, status (status_value), status_group, response, priority, spec, package, ball in court, is_overdue, days_overdue, age_days.',
    build(ctx) {
      if (!ctx.has('submittalsacc_items')) return null;
      const v = new View(ctx, 'submittalsacc_items', 's');
      v.col('id').project().cols('identifier', 'custom_identifier', 'title', 'description');
      v.col('type_value', 'type').col('status_value', 'status');
      v.expr(statusGroup('s.status_value', { draft: ['draft'], closed: ['closed'], void: ['void'] }), 'status_group', ['status_value']);
      v.col('response_value', 'response').col('priority_value', 'priority');
      v.cols('spec_identifier', 'package_title', 'package_identifier', 'ball_in_court', 'revision', 'manager', 'subcontractor');
      v.cols('due_date', 'required_on_job_date', 'required_approval_date', 'lead_time', 'manager_due_date', 'submitter_due_date', 'created_at', 'updated_at', 'responded_at', 'published_date');
      v.user('created_by_name', 'created_by');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf);
    },
  },
  {
    name: 'v_assets',
    description: 'Assets (active only) with project, category, status label and sort order (workflow stage), company and creator names. Each asset has exactly one status.',
    build(ctx) {
      if (!ctx.has('assets_assets')) return null;
      const v = new View(ctx, 'assets_assets', 'a');
      v.col('id', 'asset_id').project().cols('client_asset_id', 'description', 'barcode', 'category_id', 'status_id', 'location_id');
      v.lookup('category_name', 'assets_categories', 'name', [['id', 'category_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('status_label', 'assets_asset_statuses', 'label', [['id', 'status_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('status_sort_order', 'assets_asset_statuses', 'sort_order', [['id', 'status_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.lookup('company_name', 'admin_companies', 'name', [['id', 'company_id']]);
      v.cols('created_at', 'updated_at').user('created_by_name', 'created_by');
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_checklists',
    description: 'Checklists (active only) with project, status, status_group (completed = closed), progress, item counts, template title, dates.',
    build(ctx) {
      if (!ctx.has('checklists_checklists')) return null;
      const v = new View(ctx, 'checklists_checklists', 'c');
      v.col('id').project().cols('title', 'status');
      v.expr(statusGroup('c.status', { closed: ['completed', 'complete', 'closed'], void: ['void', 'deleted'] }), 'status_group', ['status']);
      v.cols('progress', 'items_count', 'completed_items_count', 'required_signatures_count', 'unsigned_signatures_count', 'template_type', 'location');
      v.lookup('template_title', 'checklists_templates', 'title', [['template_id', 'template_id'], ['bim360_project_id', 'bim360_project_id']]);
      v.cols('scheduled_date', 'started_on', 'completed_on', 'is_archived', 'created_at', 'updated_at').user('created_by_name', 'created_by');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf, { due: 'scheduled_date' });
    },
  },
  {
    name: 'v_meetings',
    description: 'Meetings (active only) with project, status, start time, series and creator.',
    build(ctx) {
      if (!ctx.has('meetingminutes_meetings')) return null;
      const v = new View(ctx, 'meetingminutes_meetings', 'm');
      v.col('id', 'meeting_id').project().cols('title', 'description', 'summary', 'status', 'starts_at', 'duration', 'meeting_location', 'series_id', 'num_in_series', 'created_at', 'updated_at');
      v.user('created_by_name', 'created_by');
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_meeting_items',
    description: 'Meeting action items (active only) with meeting title/date, topic, assignee names (semicolon-separated), status_group (information = info), is_overdue, days_overdue. Many open items have no due date; count those separately.',
    build(ctx) {
      if (!ctx.has('meetingminutes_items')) return null;
      const v = new View(ctx, 'meetingminutes_items', 'i');
      v.col('id', 'item_id').project().cols('topic_id', 'description', 'status');
      v.expr(statusGroup('i.status', { closed: ['closed', 'resolved'], info: ['information', 'info'] }), 'status_group', ['status']);
      v.lookup('topic_name', 'meetingminutes_topics', 'name', [['id', 'topic_id']]);
      v.lookup('meeting_id', 'meetingminutes_topics', 'meeting_id', [['id', 'topic_id']]);
      const canMeeting = ctx.has('meetingminutes_topics', 'meeting_id') && ctx.has('meetingminutes_meetings', 'id') && ctx.has('meetingminutes_items', 'topic_id');
      v.expr(`(SELECT m.title FROM meetingminutes_topics t JOIN meetingminutes_meetings m ON m.id = t.meeting_id WHERE t.id = i.topic_id LIMIT 1)`, 'meeting_title', canMeeting ? [] : ['__missing__']);
      v.expr(`(SELECT m.starts_at FROM meetingminutes_topics t JOIN meetingminutes_meetings m ON m.id = t.meeting_id WHERE t.id = i.topic_id LIMIT 1)`, 'meeting_starts_at', canMeeting && ctx.has('meetingminutes_meetings', 'starts_at') ? [] : ['__missing__']);
      const canAssignees = ctx.has('meetingminutes_assignees', 'item_id') && ctx.has('meetingminutes_participants', 'autodesk_id') && ctx.has('admin_users', 'autodesk_id');
      const asgDeleted = ctx.has('meetingminutes_assignees', 'deleted_at') ? 'AND a.deleted_at IS NULL' : '';
      v.expr(
        `(SELECT group_concat(name, '; ') FROM (SELECT DISTINCT (SELECT u.name FROM admin_users u WHERE u.autodesk_id = pt.autodesk_id LIMIT 1) AS name FROM meetingminutes_assignees a JOIN meetingminutes_participants pt ON pt.id = a.participant_id WHERE a.item_id = i.id ${asgDeleted}))`,
        'assignee_names',
        canAssignees ? [] : ['__missing__']
      );
      v.cols('due_date', 'created_at', 'updated_at').user('created_by_name', 'created_by');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf);
    },
  },
  {
    name: 'v_daily_logs',
    description: 'Daily logs with project, date, status, company, creator and publisher.',
    build(ctx) {
      if (!ctx.has('dailylogs_dailylogs')) return null;
      const v = new View(ctx, 'dailylogs_dailylogs', 'd');
      v.col('id').project().cols('date', 'status', 'created_at', 'published_at');
      v.lookup('company_name', 'admin_companies', 'name', [['id', 'company_id']]);
      v.user('created_by_name', 'created_by').user('published_by_name', 'published_by');
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_reviews',
    description: 'Document reviews with project, workflow, status_group, document/approved/rejected counts, step progress, next due date (is_overdue uses next_due_date).',
    build(ctx) {
      if (!ctx.has('reviews_reviews')) return null;
      const v = new View(ctx, 'reviews_reviews', 'r');
      v.col('id').project().col('review_name', 'title').cols('workflow_name', 'status');
      v.expr(statusGroup('r.status', { closed: ['closed', 'completed'], void: ['void'] }), 'status_group', ['status']);
      v.cols('docs_count', 'approved_count', 'rejected_count', 'current_step', 'total_steps', 'current_round_num', 'next_due_date', 'started_at', 'finished_at', 'created_at', 'updated_at', 'is_archived');
      v.user('created_by_name', 'created_by');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf, { due: 'next_due_date' });
    },
  },
  {
    name: 'v_forms',
    description: 'Forms with project, template name/type, status_group (closed/archived = closed, discarded = void), assignee, form date, is_overdue.',
    build(ctx) {
      if (!ctx.has('forms_forms')) return null;
      const v = new View(ctx, 'forms_forms', 'f');
      v.col('id').project().cols('name', 'number', 'status');
      v.expr(statusGroup('f.status', { draft: ['draft'], closed: ['closed', 'archived', 'submitted'], void: ['discarded', 'void', 'deleted'] }), 'status_group', ['status']);
      v.lookup('template_name', 'forms_form_templates', 'name', [['id', 'template_id']]);
      v.lookup('template_type', 'forms_form_templates', 'template_type', [['id', 'template_id']]);
      v.cols('assignee_id', 'assignee_type').user('assignee_name', 'assignee_id');
      v.cols('form_date', 'due_date', 'last_submitted_at', 'created_at', 'updated_at', 'description', 'notes').user('created_by_name', 'created_by');
      v.activeOnly();
      return withDerived(v.sql(), ctx.asOf);
    },
  },
  {
    name: 'v_cost_budgets',
    description:
      'Budget lines with project and contract. forecast_variance < 0 means a projected overrun (is_overrun = 1). has_children = 1 marks parent lines; sum only rows with has_children = 0 to avoid double counting.',
    build(ctx) {
      if (!ctx.has('cost_budgets')) return null;
      const v = new View(ctx, 'cost_budgets', 'b');
      v.col('id').project().cols('code', 'name', 'description', 'parent_id', 'unit', 'quantity', 'unit_price');
      v.cols('original_amount', 'internal_adjustment', 'approved_owner_changes', 'pending_owner_changes', 'original_commitment', 'approved_change_orders', 'pending_change_orders', 'reserves', 'actual_cost', 'revised', 'projected_cost', 'projected_budget', 'forecast_final_cost', 'forecast_variance', 'variance_total', 'uncommitted', 'adjustments_total');
      v.col('contract_id').lookup('contract_code', 'cost_contracts', 'code', [['id', 'contract_id']]).lookup('contract_name', 'cost_contracts', 'name', [['id', 'contract_id']]);
      v.expr(`CASE WHEN b.forecast_variance IS NULL THEN NULL WHEN b.forecast_variance < 0 THEN 1 ELSE 0 END`, 'is_overrun', ['forecast_variance']);
      v.expr(`CASE WHEN EXISTS (SELECT 1 FROM cost_budgets c WHERE c.parent_id = b.id) THEN 1 ELSE 0 END`, 'has_children', ['parent_id', 'id']);
      v.cols('created_at', 'updated_at');
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_cost_contracts',
    description: 'Commitments/contracts with project, company, status, awarded and budget figures, change orders, forecast_variance (< 0 = overrun).',
    build(ctx) {
      if (!ctx.has('cost_contracts')) return null;
      const v = new View(ctx, 'cost_contracts', 'c');
      v.col('id', 'contract_id').project().cols('code', 'name', 'type', 'status', 'currency');
      v.lookup('company_name', 'admin_companies', 'name', [['id', 'company_id']]);
      v.cols('awarded', 'original_budget', 'revised', 'approved_change_orders', 'pending_change_orders', 'actual_cost', 'projected_cost', 'forecast_final_cost', 'forecast_variance', 'uncommitted', 'compliance_status');
      v.expr(`CASE WHEN c.forecast_variance IS NULL THEN NULL WHEN c.forecast_variance < 0 THEN 1 ELSE 0 END`, 'is_overrun', ['forecast_variance']);
      v.cols('awarded_at', 'executed_at', 'status_changed_at', 'created_at', 'updated_at');
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_change_orders',
    description:
      'Every change-order form row (PCO, RFQ, RCO, OCO, SCO) with project and contract. One real change usually appears as several rows sharing the same name, so do NOT sum amounts here for exposure; use v_change_order_chains.',
    build(ctx) {
      if (!ctx.has('cost_change_orders')) return null;
      const v = new View(ctx, 'cost_change_orders', 'co');
      v.col('id').project().cols('number', 'name', 'description');
      v.expr(`lower(co.form_type)`, 'form_type', ['form_type']);
      v.cols('type', 'source_type', 'budget_status', 'cost_status', 'estimated', 'proposed', 'submitted', 'approved', 'committed', 'schedule_change', 'scope_of_work');
      v.col('contract_id').lookup('contract_name', 'cost_contracts', 'name', [['id', 'contract_id']]);
      v.cols('created_at', 'updated_at', 'approved_at', 'applied_at', 'status_changed_at');
      v.expr(`lower(trim(co.name))`, 'chain_key', ['name']);
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_change_order_chains',
    description:
      'One row per real change (change-order rows grouped by project + name). exposure = largest proposed amount across the chain (not the sum). open_legs counts forms not yet executed/approved/accepted/rejected/void.',
    after: ['v_change_orders'],
    build(ctx, built) {
      if (!built.has('v_change_orders')) return null;
      const done = `('executed','approved','accepted','rejected','void','closed')`;
      return `SELECT
  bim360_project_id,
  MAX(project_name) AS project_name,
  chain_key,
  MAX(name) AS name,
  COUNT(*) AS form_count,
  group_concat(DISTINCT form_type) AS form_types,
  MAX(proposed) AS exposure,
  MAX(approved) AS max_approved,
  MAX(committed) AS max_committed,
  SUM(CASE WHEN lower(COALESCE(cost_status, budget_status, '')) NOT IN ${done} THEN 1 ELSE 0 END) AS open_legs,
  MIN(created_at) AS first_created_at,
  MAX(updated_at) AS last_updated_at
FROM v_change_orders
WHERE chain_key IS NOT NULL AND chain_key != ''
GROUP BY bim360_project_id, chain_key`;
    },
  },
  {
    name: 'v_schedule_activities',
    description: 'Schedule activities with project and schedule name. completion_pct is 0-100. is_late = finish date before the extract date and not complete (WBS summary rows excluded).',
    build(ctx) {
      if (!ctx.has('schedule_activities')) return null;
      // Data Connector stores completion as a 0-1 fraction; detect the scale from the data.
      let scale = 100;
      try {
        const mx = ctx.db.query('SELECT MAX(completion_percentage) AS m FROM schedule_activities').get()?.m;
        if (typeof mx === 'number' && mx > 1.0001) scale = 1;
      } catch {}
      const AS = lit(ctx.asOf);
      const v = new View(ctx, 'schedule_activities', 'a');
      v.col('id').project().col('schedule_id').lookup('schedule_name', 'schedule_schedules', 'name', [['id', 'schedule_id']]);
      v.cols('name', 'type', 'wbs_code', 'wbs_path_text', 'is_wbs', 'is_critical_path');
      v.expr(`ROUND(a.completion_percentage * ${scale}, 1)`, 'completion_pct', ['completion_percentage']);
      v.cols('planned_start', 'planned_finish', 'actual_start', 'actual_finish', 'start', 'finish', 'duration', 'actual_duration', 'remaining_duration', 'total_slack_duration', 'free_slack_duration');
      v.expr(
        `CASE WHEN COALESCE(a.is_wbs, 0) = 1 THEN NULL WHEN a.finish IS NOT NULL AND date(a.finish) < date(${AS}) AND COALESCE(a.completion_percentage, 0) * ${scale} < 100 THEN 1 ELSE 0 END`,
        'is_late',
        ['finish', 'completion_percentage']
      );
      v.cols('created_at', 'updated_at');
      v.activeOnly();
      return v.sql();
    },
  },
  {
    name: 'v_takeoff_quantities',
    description: 'One row per takeoff quantity with project, package, takeoff type, object name, output, quantity, unit, unit and total cost. Based on the quantities table, so sums don\'t fan out.',
    build(ctx) {
      if (!ctx.has('takeoff_quantities')) return null;
      const v = new View(ctx, 'takeoff_quantities', 'q');
      v.col('id').project().col('item_id');
      const canItem = ctx.has('takeoff_takeoff_items', 'id') && ctx.has('takeoff_quantities', 'item_id');
      const sub = (sel, needs) => (canItem && needs ? sel : null);
      v.expr(sub(`(SELECT ti.object_name FROM takeoff_takeoff_items ti WHERE ti.id = q.item_id LIMIT 1)`, ctx.has('takeoff_takeoff_items', 'object_name')) ?? 'NULL', 'object_name');
      v.expr(sub(`(SELECT tt.name FROM takeoff_takeoff_items ti JOIN takeoff_takeoff_types tt ON tt.id = ti.type_id WHERE ti.id = q.item_id LIMIT 1)`, ctx.has('takeoff_takeoff_types', 'name') && ctx.has('takeoff_takeoff_items', 'type_id')) ?? 'NULL', 'takeoff_type');
      v.expr(sub(`(SELECT tp.name FROM takeoff_takeoff_items ti JOIN takeoff_packages tp ON tp.id = ti.package_id WHERE ti.id = q.item_id LIMIT 1)`, ctx.has('takeoff_packages', 'name') && ctx.has('takeoff_takeoff_items', 'package_id')) ?? 'NULL', 'package_name');
      v.cols('output_name', 'quantity', 'unit_of_measure', 'unit_cost', 'total_cost');
      v.lookup('classification1_code', 'takeoff_classifications', 'code', [['id', 'classification1_id']]);
      v.lookup('classification1_description', 'takeoff_classifications', 'description', [['id', 'classification1_id']]);
      v.activeOnly();
      return v.sql();
    },
  },
];

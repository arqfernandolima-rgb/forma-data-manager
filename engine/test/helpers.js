import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'forma-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Writes a tiny Data Connector-shaped extract (CSVs + schemas/schema.json) into dir. */
export function writeMiniExtract(dir, { omitRfiDeletedAt = true, nextDay = false, parties = false } = {}) {
  const P1 = '11111111-1111-1111-1111-111111111111';
  const P2 = '22222222-2222-2222-2222-222222222222';
  const P3 = '33333333-3333-3333-3333-333333333333';
  const tables = {
    metadata: {
      cols: { created_at: 'timestamp: SQL', region: 'string', request_start_date: 'timestamp: SQL', request_end_date: 'timestamp: SQL' },
      rows: [['2026-06-08 16:26:57', 'US', '2026-06-07 00:00:00', '2026-06-08 00:00:00']],
    },
    admin_projects: {
      cols: { id: 'string: UUID', name: 'string', status: 'string', type: 'string', classification: 'string', job_number: 'string', postal_code: 'string', acc_project: 'boolean', value: 'number' },
      rows: [
        [P1, 'Riverside Hospital', 'active', 'Hospital ', 'production', '00123', '\t07924', 't', '0'],
        [P2, 'Training Sandbox', 'active', 'Training Project', 'sample', '', '', 'f', '1500000.50'],
      ],
    },
    admin_users: {
      cols: { autodesk_id: 'string', name: 'string', email: 'string', last_sign_in: 'timestamp: SQL' },
      rows: [
        ['U1', 'Ana Silva', 'ana@example.com', '2019-10-24 00:32:46 UTC'],
        ['U1', 'Ana Silva (dup)', 'ana@example.com', ''],
        ['U2', 'Ben Ortiz', 'ben@example.com', '2026-05-01 10:00:00.123456'],
      ],
    },
    issues_issue_types: {
      cols: { issue_type_id: 'string: UUID', bim360_project_id: 'string: UUID', issue_type: 'string' },
      rows: [['T1', P1, 'Quality']],
    },
    issues_issues: {
      cols: { issue_id: 'string: UUID', bim360_project_id: 'string: UUID', display_id: 'number', title: 'string', description: 'string', status: 'string', type_id: 'string: UUID', assignee_id: 'string', due_date: 'timestamp: SQL', created_at: 'timestamp: SQL', deleted_at: 'timestamp: SQL', published: 'boolean' },
      rows: [
        ['I1', P1, '1', 'Leak at fire pump room', 'Water on floor, "urgent"', 'open', 'T1', 'U1', '2026-05-01 00:00:00', '2026-04-01 08:00:00', '', 'true'],
        ['I2', P1, '2', 'Closed one', '', 'closed', 'T1', 'U2', '2026-05-01 00:00:00', '2026-04-02 08:00:00', '', 'false'],
        ['I3', P1, '3', 'Deleted one', '', 'open', 'T1', 'U1', '', '2026-04-03 08:00:00', '2026-04-04 08:00:00', '0'],
        ['I4', P2, '1', 'Draft', 'multi\nline', 'draft', '', '', '', '2026-04-05 08:00:00', '', '1'],
      ],
    },
    rfis_rfis: {
      cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', custom_identifier: 'string', title: 'string', status: 'string', cost_impact: 'string', due_date: 'timestamp: SQL', created_at: 'timestamp: SQL', manager_id: 'string', ...(omitRfiDeletedAt ? {} : { deleted_at: 'timestamp: SQL' }) },
      rows: [
        ['R1', P1, '001', 'Concrete mix', 'openRev1', 'Yes', '2026-06-01 00:00:00', '2026-05-01 00:00:00', 'U2', ...(omitRfiDeletedAt ? [] : [''])],
        ['R2', P1, '002', 'Door hardware', 'closed', 'No', '2026-06-01 00:00:00', '2026-05-02 00:00:00', 'U2', ...(omitRfiDeletedAt ? [] : [''])],
      ],
    },
    cost_change_orders: {
      cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', name: 'string', form_type: 'string', cost_status: 'string', budget_status: 'string', proposed: 'number', approved: 'number', number: 'number' },
      rows: [
        ['C1', P1, 'Add heater', 'PCO', 'executed', 'executed', '5000', '5000', '1'],
        ['C2', P1, 'Add heater ', 'rfq', 'proposed', '', '5330', '0', 'SUB-14-000-0001'],
        ['C3', P1, 'Add heater', 'oco', 'executed', 'executed', '5330', '5330', '007'],
        ['C4', P1, 'Wall framing', 'pco', 'executed', 'executed', '2000', '2000', '2'],
      ],
    },
    cost_budgets: {
      cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', parent_id: 'string: UUID', code: 'string', name: 'string', original_amount: 'number', revised: 'number', forecast_final_cost: 'number', forecast_variance: 'number', actual_cost: 'number' },
      rows: [
        ['B0', P1, '', '01', 'Parent', '300', '300', '350', '-50', '0'],
        ['B1', P1, 'B0', '01-100', 'Child A', '100', '100', '160', '-60', '0'],
        ['B2', P1, 'B0', '01-200', 'Child B', '200', '200', '190', '10', ''],
      ],
    },
    schedule_activities: {
      cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', name: 'string', is_wbs: 'boolean', completion_percentage: 'number', finish: 'timestamp: SQL' },
      rows: [
        ['A1', P1, 'Pour slab', 'f', '0', '2026-05-15 00:00:00'],
        ['A2', P1, 'Frame', 'f', '1', '2026-05-15 00:00:00'],
        ['A3', P1, 'Phase 1', 't', '0.5', '2026-05-15 00:00:00'],
      ],
    },
    // Header-only CSV: the table must still exist so queries don't fail with "no such table".
    forms_forms: { cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', status: 'string' }, rows: [] },
  };

  if (nextDay) {
    // The same hub a day later: one issue closed, one new issue, a new project, one project archived.
    tables.metadata.rows[0][0] = '2026-06-09 16:26:57';
    tables.issues_issues.rows[0][5] = 'closed';
    tables.issues_issues.rows.push(['I5', P1, '5', 'Cracked tile', '', 'open', 'T1', 'U2', '2026-07-01 00:00:00', '2026-06-08 09:00:00', '', 'true']);
    tables.admin_projects.rows[1][2] = 'archived';
    tables.admin_projects.rows.push([P3, 'New Clinic', 'active', 'Hospital', 'production', '00200', '', 't', '0']);
  }

  if (parties) {
    // Items held by companies and roles, the way Autodesk stores them: issues, RFIs and submittals
    // use Oxygen (member group) IDs; forms and cost use admin IDs. The same company and role appear
    // in two projects, which must not duplicate any row.
    const OX_GENSLER = '693017753';
    const OX_ARCH = '700001';
    tables.admin_companies = { cols: { id: 'string: UUID', name: 'string' }, rows: [['CO-A', 'Gensler'], ['CO-B', 'CREO']] };
    tables.admin_project_companies = {
      cols: { project_id: 'string: UUID', bim360_project_id: 'string: UUID', company_id: 'string: UUID', company_oxygen_id: 'string' },
      rows: [[P1, P1, 'CO-A', OX_GENSLER], [P2, P2, 'CO-A', OX_GENSLER]],
    };
    tables.admin_project_roles = {
      cols: { bim360_project_id: 'string: UUID', role_id: 'string: UUID', role_oxygen_id: 'string', name: 'string', status: 'string' },
      rows: [[P1, 'RL-1', OX_ARCH, 'Architect', 'active'], [P2, 'RL-1', OX_ARCH, 'Architect', 'active']],
    };
    tables.admin_roles = { cols: { id: 'string: UUID', name: 'string' }, rows: [['RL-1', 'Architect']] };
    tables.issues_issues.cols.assignee_type = 'string';
    for (const r of tables.issues_issues.rows) r.push(r[7] ? 'user' : '');
    tables.issues_issues.rows.push(
      ['I6', P1, '6', 'Facade clash', '', 'open', 'T1', OX_GENSLER, '2026-05-20 00:00:00', '2026-05-01 08:00:00', '', 'true', 'company'],
      ['I7', P1, '7', 'Stair width', '', 'in_review', 'T1', OX_ARCH, '', '2026-05-02 08:00:00', '', 'true', 'role']
    );
    tables.rfis_rfis.cols.manager_type = 'string';
    for (const r of tables.rfis_rfis.rows) r.push('user');
    tables.rfis_rfis.rows.push(['R3', P1, '003', 'Stair landing', 'open', 'Unknown', '2026-06-30 00:00:00', '2026-05-03 00:00:00', OX_ARCH, ...(omitRfiDeletedAt ? [] : ['']), 'role']);
    tables.submittalsacc_items = {
      cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', title: 'string', status_value: 'string', manager: 'string', subcontractor: 'string', ball_in_court: 'string' },
      rows: [
        ['S1', P1, 'Door hardware', 'Open', 'U1', OX_GENSLER, `{U2,${OX_GENSLER},${OX_ARCH}}`],
        ['S2', P1, 'Glazing', 'Closed', OX_ARCH, '', '{}'],
        ['S3', P1, 'Steel', 'Open', 'U2', '', '["U1"]'],
        ['S4', P1, 'Odd value', 'Open', '', '', 'not "a list'],
      ],
    };
    tables.forms_forms = {
      cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', status: 'string', assignee_id: 'string', assignee_type: 'string', assignee_type_id: 'string' },
      rows: [
        ['F1', P1, 'in_progress', '', 'company', 'CO-B'],
        ['F2', P1, 'in_progress', '', 'role', 'RL-1'],
        ['F3', P1, 'in_progress', 'U1', '', 'U1'],
      ],
    };
    tables.cost_contracts = {
      cols: { id: 'string: UUID', bim360_project_id: 'string: UUID', code: 'string', name: 'string', company_id: 'string', company_uid: 'string: UUID' },
      rows: [
        ['K1', P1, '001', 'Facade', OX_GENSLER, 'CO-A'],
        ['K2', P1, '002', 'Structure', '', 'CO-B'],
        ['K3', P1, '003', 'Interiors', OX_GENSLER, ''],
      ],
    };
  }

  const schema = {};
  for (const [name, t] of Object.entries(tables)) {
    const [service, ...rest] = name.split('_');
    const tbl = rest.join('_') || name;
    if (name !== 'metadata') {
      schema[service] ??= {};
      schema[service][tbl] = Object.fromEntries(Object.entries(t.cols).map(([c, dt], i) => [c, { data_type: dt, constraints: [], notes: `${c} of ${tbl}`, ordinal_position: i + 1 }]));
    }
    const lines = [Object.keys(t.cols).join(','), ...t.rows.map((r) => r.map(csvCell).join(','))];
    fs.writeFileSync(path.join(dir, `${name}.csv`), '﻿' + lines.join('\r\n') + '\r\n');
  }
  fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schemas', 'schema.json'), JSON.stringify(schema));
  return { P1, P2, P3 };
}

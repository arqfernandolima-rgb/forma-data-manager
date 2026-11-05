/** Module (service group) labels and the "main" table for each, used for summaries. */

export const MODULES = {
  admin: { label: 'Hub admin (projects, users, companies)', main: 'admin_projects' },
  issues: { label: 'Issues (ACC)', main: 'issues_issues' },
  issuesbim360: { label: 'Issues (BIM 360)', main: 'issuesbim360_issues' },
  rfis: { label: 'RFIs', main: 'rfis_rfis' },
  submittalsacc: { label: 'Submittals (ACC)', main: 'submittalsacc_items' },
  submittals: { label: 'Submittals (BIM 360)', main: 'submittals_items' },
  cost: { label: 'Cost management', main: 'cost_budgets' },
  assets: { label: 'Assets', main: 'assets_assets' },
  checklists: { label: 'Checklists', main: 'checklists_checklists' },
  forms: { label: 'Forms', main: 'forms_forms' },
  meetingminutes: { label: 'Meeting minutes', main: 'meetingminutes_meetings' },
  dailylogs: { label: 'Daily logs', main: 'dailylogs_dailylogs' },
  schedule: { label: 'Schedule', main: 'schedule_activities' },
  sheets: { label: 'Sheets', main: 'sheets_sheets' },
  photos: { label: 'Photos', main: 'photos_photos' },
  reviews: { label: 'Document reviews', main: 'reviews_reviews' },
  transmittals: { label: 'Transmittals', main: 'transmittals_workflow_transmittals' },
  takeoff: { label: 'Takeoff', main: 'takeoff_takeoff_items' },
  estimates: { label: 'Estimates', main: null },
  markups: { label: 'Markups', main: 'markups_markup' },
  clashes: { label: 'Model coordination clashes', main: 'clashes_clash_test' },
  iq: { label: 'Construction IQ', main: null },
  locations: { label: 'Locations', main: 'locations_nodes' },
  packages: { label: 'Packages', main: null },
  relationships: { label: 'Cross-module relationships', main: 'relationships_entity_relationship' },
  activities: { label: 'Activity logs', main: null },
  classifications: { label: 'Classifications', main: null },
  changes: { label: 'Change tracking', main: null },
};

export function moduleOf(tableName) {
  const prefix = String(tableName).split('_')[0];
  return prefix || 'other';
}

export function moduleLabel(mod) {
  return MODULES[mod]?.label ?? mod;
}

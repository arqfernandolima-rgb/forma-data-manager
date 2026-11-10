'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { Auth, pkcePair } = require('../src/main/auth');
const { ApsClient } = require('../src/main/aps');
const { DataConnector, jobOutcome } = require('../src/main/dataconnector');
const { SyncManager } = require('../src/main/sync');
const { Scheduler } = require('../src/main/scheduler');
const { trayState, TRAY_STATES } = require('../src/main/tray-state');
const { CloudSchedule } = require('../src/main/cloud-schedule');
const { changeLines, changeHeading, changeHeadline, changeTable, changeTotals, changeNotes } = require('../src/renderer/changes');
const { JsonStore } = require('../src/main/store');
const claudeConfig = require('../src/main/claude-config');
const skill = require('../src/main/skill');
const { redact } = require('../src/main/log');

const tmp = (p = 'fdm-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quietLog = { info() {}, warn() {}, error() {} };
const fakeSafeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().replace(/^enc:/, '') };
const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('PKCE pair is RFC 7636 shaped', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
});

test('sign-in: browser redirect to the loopback callback, token exchange with PKCE, encrypted storage', async () => {
  const dir = tmp();
  const port = 18000 + Math.floor(Math.random() * 1000);
  let tokenBody;
  const fetch = async (url, opts) => {
    if (url.endsWith('/authentication/v2/token')) {
      tokenBody = new URLSearchParams(opts.body);
      return json(200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
    }
    if (url.includes('userinfo')) return json(200, { name: 'Ana Silva', email: 'ana@example.com', sub: 'U1' });
    throw new Error(`unexpected ${url}`);
  };
  const openExternal = async (authorizeUrl) => {
    const u = new URL(authorizeUrl);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('scope'), 'data:read data:write data:create user-profile:read');
    const cb = `${u.searchParams.get('redirect_uri')}?code=CODE123&state=${u.searchParams.get('state')}`;
    await new Promise((r) => http.get(cb, (res) => (res.resume(), res.on('end', r))));
  };
  const auth = new Auth({ getSettings: () => ({ clientId: 'CID', callbackPort: port }), tokenFile: path.join(dir, 't.bin'), safeStorage: fakeSafeStorage, openExternal, fetch, log: quietLog });
  const user = await auth.signIn();
  assert.equal(user.email, 'ana@example.com');
  assert.equal(tokenBody.get('code'), 'CODE123');
  assert.equal(tokenBody.get('client_id'), 'CID');
  assert.ok(tokenBody.get('code_verifier'));
  assert.equal(tokenBody.get('client_secret'), null, 'public client: no secret');
  assert.ok(fs.readFileSync(path.join(dir, 't.bin'), 'utf8').startsWith('enc:'));
  assert.equal(await auth.accessToken(), 'AT1');
});

test('refresh: concurrent callers share one refresh; invalid_grant signs out', async () => {
  const dir = tmp();
  let refreshes = 0;
  let fail = false;
  const fetch = async () => {
    refreshes++;
    if (fail) return json(400, { error: 'invalid_grant', error_description: 'expired' });
    return json(200, { access_token: `AT${refreshes}`, refresh_token: `RT${refreshes}`, expires_in: 3600 });
  };
  const auth = new Auth({ getSettings: () => ({ clientId: 'CID' }), tokenFile: path.join(dir, 't.bin'), safeStorage: fakeSafeStorage, openExternal: async () => {}, fetch, log: quietLog });
  auth.save({ access_token: 'old', refresh_token: 'RT0', expires_at: Date.now() - 1 });
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(a, b);
  assert.equal(refreshes, 1);
  fail = true;
  auth.tokens.expires_at = 0;
  await assert.rejects(auth.accessToken(), /expired. Sign in again/);
  assert.equal(auth.signedIn, false);
});

test('APS client: retries 429 with Retry-After, explains Data Connector 403', async () => {
  let calls = 0;
  const auth = { accessToken: async () => 'AT', refresh: async () => {} };
  const fetch = async (url) => {
    calls++;
    if (url.includes('/hubs') && calls === 1) return json(429, { message: 'slow down' }, { 'retry-after': '0' });
    if (url.includes('/hubs')) return json(200, { data: [{ id: 'b.acc-1', attributes: { name: 'Demo Hub', region: 'US', extension: { type: 'hubs:autodesk.bim360:Account' } } }, { id: 'a.x', attributes: { name: 'Fusion team', extension: { type: 'hubs:autodesk.core:Hub' } } }] });
    return json(403, { detail: 'not allowed' });
  };
  const aps = new ApsClient({ auth, fetch, log: quietLog });
  const hubs = await aps.listHubs();
  assert.deepEqual(hubs, [{ id: 'b.acc-1', accountId: 'acc-1', name: 'Demo Hub', region: 'US' }]);
  await assert.rejects(aps.get('/data-connector/v1/accounts/acc-1/requests'), /Executive Overview access to the hub.*Custom Integrations/);
});

test('job outcome mapping', () => {
  assert.equal(jobOutcome({ status: 'complete', completionStatus: 'success' }), 'success');
  assert.equal(jobOutcome({ status: 'complete', completionStatus: 'failed' }), 'failed');
  assert.equal(jobOutcome({ status: 'running' }), 'running');
  assert.equal(jobOutcome({ status: 'queued' }), 'running');
  assert.equal(jobOutcome({ status: 'cancelled' }), 'failed');
});

function fakeDcFetch({ zipBytes = Buffer.from('PK-fake-zip-bytes'), jobStatuses = ['queued', 'running', 'complete'], truncate = false, completedAt } = {}) {
  let jobPolls = 0;
  const seen = [];
  const fetch = async (fullUrl, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${fullUrl.replace('https://developer.api.autodesk.com', '')}`);
    const url = fullUrl.startsWith('https://signed.example/') ? fullUrl : fullUrl.split('?')[0];
    if (url.startsWith('https://signed.example/')) {
      const body = truncate ? zipBytes.subarray(0, 5) : zipBytes;
      return new Response(body, { status: 200, headers: { 'content-length': String(zipBytes.length) } });
    }
    if (opts.method === 'POST' && url.endsWith('/requests')) return json(200, { id: 'REQ1' });
    if (url.endsWith('/requests/REQ1/jobs')) return json(200, { results: [{ id: 'JOB1', status: 'queued', createdAt: '2026-11-05T10:00:00Z' }] });
    if (url.endsWith('/jobs/JOB1')) {
      const status = jobStatuses[Math.min(jobPolls++, jobStatuses.length - 1)];
      return json(200, { id: 'JOB1', status, completionStatus: status === 'complete' ? 'success' : undefined, completedAt: status === 'complete' ? completedAt : undefined });
    }
    if (url.endsWith('/jobs/JOB1/data-listing')) return json(200, [{ name: 'README.html', size: 10 }, { name: 'autodesk_data_extract.zip', size: zipBytes.length }, { name: 'issues_issues.csv', size: 5 }]);
    if (url.includes('/jobs/JOB1/data/')) return json(200, { signedUrl: `https://signed.example/${encodeURIComponent(url.split('/data/')[1])}?X-Amz-Signature=abc` });
    if (opts.method === 'DELETE') return json(204, null);
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, seen };
}

function makeSync({ dcFetch, engineResult, engineError, dataDir = tmp('fdm-data-') } = {}) {
  const store = new JsonStore(tmp('fdm-ud-'));
  store.updateSettings({ hub: { accountId: 'acc-1', name: 'Demo' }, dataDir, wizardComplete: true });
  const auth = { signedIn: true, accessToken: async () => 'AT', refresh: async () => {} };
  const aps = new ApsClient({ auth, fetch: dcFetch, log: quietLog });
  const dc = new DataConnector({ aps, fetch: dcFetch, log: quietLog });
  const builds = [];
  const engine = {
    cancel() {},
    async build(args) {
      builds.push(args);
      args.onEvent?.({ event: 'table', index: 1, total: 1, table: 'x' });
      if (engineError) throw engineError;
      return engineResult || { event: 'done', as_of: '2026-11-05', rows: 1234, tables: 250, views_failed: [], warnings: [], size_mb: 900 };
    },
  };
  const notes = [];
  const bodies = [];
  const sync = new SyncManager({ store, auth, dc, engine, log: quietLog, notify: (t, b) => (notes.push(t), bodies.push(b)), sleep: async () => {} });
  return { sync, store, builds, dataDir, notes, bodies };
}

test('sync: request → wait for job → download ZIP → build → history; download removed; own request cleaned up later', async () => {
  const { fetch, seen } = fakeDcFetch();
  const { sync, store, builds, dataDir } = makeSync({ dcFetch: fetch });
  const entry = await sync.start('manual');
  assert.equal(entry.status, 'success');
  assert.equal(entry.rows, 1234);
  assert.equal(builds.length, 1);
  assert.ok(builds[0].zipPath.endsWith(path.join('downloads', 'JOB1.zip')));
  assert.equal(fs.existsSync(builds[0].zipPath), false, 'download deleted after build');
  assert.equal(store.syncState(), null);
  assert.equal(store.history()[0].status, 'success');
  assert.equal(store.settings().ownedRequests[0].id, 'REQ1');
  const post = seen.find((s) => s.startsWith('POST'));
  assert.equal(post, 'POST /data-connector/v1/accounts/acc-1/requests');
  assert.ok(fs.existsSync(path.join(dataDir, 'downloads')));
  assert.equal(sync.jobsLast24h(), 1);
});

test('sync: timeline timestamps, per-phase timings in history, and the estimate for next time', async () => {
  const { fetch } = fakeDcFetch();
  const { sync, store } = makeSync({ dcFetch: fetch });
  let clock = Date.parse('2026-11-05T19:00:00Z');
  sync.now = () => clock;
  sync.sleep = async () => {
    clock += 20 * 60_000; // each poll: 20 minutes pass at Autodesk
  };
  const seen = new Set();
  sync.on('update', (st) => {
    seen.add(st.phase);
    if (st.phase === 'waiting') {
      assert.ok(st.timeline.requestedAt);
      assert.ok(st.lastCheckAt && st.nextCheckAt, 'shows when it last checked and when it checks next');
    }
  });
  assert.equal(sync.estimate().prepareMinutes, null, 'no estimate before the first sync');
  const entry = await sync.start('manual');
  assert.ok(['requesting', 'waiting', 'downloading', 'building', 'done'].every((p) => seen.has(p)));
  assert.equal(entry.prepareMinutes, 40); // two 20-minute polls before the job completed
  assert.equal(entry.sizeBytes, Buffer.from('PK-fake-zip-bytes').length);
  const tl = sync.status.timeline;
  assert.ok(tl.requestedAt && tl.confirmedAt && tl.preparedAt && tl.downloadStartedAt && tl.downloadedAt && tl.buildStartedAt && tl.doneAt);
  assert.equal(tl.jobId, 'JOB1');
  assert.deepEqual(sync.estimate(), { prepareMinutes: 40, sizeBytes: entry.sizeBytes, basedOn: 1 });
  assert.equal(store.history()[0].prepareMinutes, 40);
});

test('sync: truncated download is retried and finally fails without building', async () => {
  const { fetch } = fakeDcFetch({ truncate: true });
  const { sync, store, builds } = makeSync({ dcFetch: fetch });
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => origSetTimeout(fn, 0); // skip retry back-off
  try {
    const entry = await sync.start('scheduled');
    assert.equal(entry.status, 'failed');
    assert.match(entry.error, /Incomplete download/);
  } finally {
    global.setTimeout = origSetTimeout;
  }
  assert.equal(builds.length, 0);
  assert.equal(store.syncState(), null);
});

test('sync: a "much smaller" build is held for review, then applied with force', async () => {
  const { fetch } = fakeDcFetch();
  const err = Object.assign(new Error('New extract has 10 rows, less than half'), { rejected: true });
  const ctx = makeSync({ dcFetch: fetch, engineError: err });
  const entry = await ctx.sync.start('manual');
  assert.equal(entry.status, 'rejected');
  const st = ctx.store.syncState();
  assert.equal(st.phase, 'rejected');
  assert.ok(fs.existsSync(st.input.zipPath), 'download kept for review');
  ctx.sync.engine.build = async (args) => (ctx.builds.push(args), { as_of: '2026-11-05', rows: 10 });
  const applied = await ctx.sync.useRejectedAnyway();
  assert.equal(applied.status, 'success');
  assert.equal(ctx.builds.at(-1).force, true);
});

test('sync: resumes a job that was in progress when the app closed (no new request)', async () => {
  const { fetch, seen } = fakeDcFetch({ jobStatuses: ['complete'] });
  const ctx = makeSync({ dcFetch: fetch });
  ctx.store.setSyncState({ trigger: 'scheduled', startedAt: new Date().toISOString(), accountId: 'acc-1', phase: 'waiting', requestId: 'REQ1', jobId: 'JOB1' });
  const entry = await ctx.sync.resume();
  assert.equal(entry.status, 'success');
  assert.equal(seen.filter((s) => s.startsWith('POST')).length, 0);
});

test('sync: refuses to start past the 24 jobs/day limit', async () => {
  const { fetch } = fakeDcFetch();
  const ctx = makeSync({ dcFetch: fetch });
  ctx.store.updateSettings({ ownedRequests: Array.from({ length: 24 }, (_, i) => ({ id: `R${i}`, createdAt: new Date().toISOString() })) });
  await assert.rejects(ctx.sync.start('manual'), /24 Data Connector jobs/);
});

test('sync: update listeners see busy for the whole run and idle once it ends (tray must not stick on "syncing")', async () => {
  for (const engineError of [null, new Error('engine crashed')]) {
    const { fetch } = fakeDcFetch();
    const ctx = makeSync({ dcFetch: fetch, engineError });
    const seen = [];
    ctx.sync.on('update', (st) => seen.push({ busy: ctx.sync.busy, phase: st.phase }));
    const entry = await ctx.sync.start('manual');
    assert.equal(entry.status, engineError ? 'failed' : 'success');
    assert.ok(seen.length > 2);
    assert.ok(seen.slice(0, -1).every((u) => u.busy), 'busy on every update while the pipeline runs, including the first');
    assert.deepEqual(seen.at(-1), { busy: false, phase: engineError ? 'failed' : 'done' }, 'a final update reports idle');
    assert.equal(ctx.sync.busy, false);
  }
});

test('tray state: priority and colors for each situation', () => {
  const now = Date.parse('2026-11-10T09:00:00');
  const base = { busy: false, wizardComplete: true, signedIn: true, database: { as_of: '2026-11-10' }, lastSync: { status: 'success' }, pendingReview: false, now };
  const key = (p) => trayState({ ...base, ...p }).key;
  assert.equal(key({}), 'ready');
  assert.equal(key({ database: { as_of: '2026-11-08' } }), 'ready', '2 days old is still current, same as the window badge');
  assert.equal(key({ database: { as_of: '2026-11-07' } }), 'stale');
  assert.match(trayState({ ...base, database: { as_of: '2026-11-01' } }).label, /9 days old/);
  assert.equal(key({ database: { as_of: '2026-11-11' } }), 'ready', 'as_of is a UTC date and can be "tomorrow" in the evening');
  assert.equal(key({ database: null }), 'notready');
  assert.equal(key({ wizardComplete: false, signedIn: false, database: null }), 'notready');
  assert.equal(key({ signedIn: false }), 'attention');
  assert.equal(key({ lastSync: { status: 'failed' } }), 'attention');
  assert.equal(key({ lastSync: { status: 'cancelled' } }), 'ready', 'a cancel is not a problem');
  assert.equal(key({ pendingReview: true }), 'attention');
  assert.equal(key({ busy: true, phase: 'downloading', lastSync: { status: 'failed' }, database: null }), 'syncing', 'syncing wins');
  assert.match(trayState({ busy: true, phase: 'waiting' }).label, /preparing/);
  for (const k of TRAY_STATES) {
    for (const f of [`tray-${k}.png`, `tray-${k}@2x.png`]) assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', f)), `missing ${f}`);
  }
});

// Same shape the engine returns (engine/src/build/changes.js).
const SAMPLE_CHANGES = {
  previous: { as_of: '2026-11-06', built_at: '2026-11-06T01:20:14.761Z', extraction_created_at: '2026-11-06 01:14:47' },
  rows: { before: 3539992, after: 3540048 },
  projects: { before: 2494, after: 2496, added: 2, added_names: ['Clinic A', 'Clinic B'], removed: 0, removed_names: [], status_changed: 1, status_examples: [{ name: 'Old Tower', from: 'active', to: 'archived' }] },
  items: [
    { key: 'issues', label: 'Issues', before: 6558, after: 6572, new: 14, closed: 3, open_before: 900, open_after: 911 },
    { key: 'rfis', label: 'RFIs', before: 1671, after: 1671, new: 0, closed: 0, open_before: 200, open_after: 200 },
    { key: 'submittals', label: 'Submittals', before: 14481, after: 14486, new: 5, closed: 0, open_before: 3000, open_after: 3005 },
  ],
  modules: [
    { module: 'markups', label: 'Markups', before: 975100, after: 975140 },
    { module: 'issues', label: 'Issues (ACC)', before: 6558, after: 6572 },
    { module: 'photos', label: 'Photos', before: 37716, after: 37704 },
  ],
};

test('change summary: short lines, most important first; nothing to compare → nothing shown', () => {
  assert.deepEqual(changeLines(SAMPLE_CHANGES), [
    'Projects: 2 new (Clinic A, Clinic B) · 1 status change (Old Tower: active → archived)',
    'Issues: 14 new, 3 closed · Submittals: 5 new',
    'Also changed: Markups +40, Photos −12',
  ]);
  assert.deepEqual(changeLines(null), [], 'first sync ever: no card');
  assert.deepEqual(changeLines({ ...SAMPLE_CHANGES, projects: { ...SAMPLE_CHANGES.projects, added: 0, status_changed: 0 }, items: [], modules: [] }), ['No changes in projects or tracked items.']);
  const many = { ...SAMPLE_CHANGES.projects, added: 7, added_names: ['A', 'B', 'C', 'D', 'E'] };
  assert.match(changeLines({ projects: many })[0], /7 new \(A, B, C \+4 more\)/);
  assert.match(changeHeading(SAMPLE_CHANGES), /^Compared with the extract of .+ · \+56 rows$/);
  assert.equal(changeHeadline(SAMPLE_CHANGES), 'Issues: 14 new, 3 closed · Submittals: 5 new');
});

test('history summary: "N added · N removed · N closed" plus a per-category table', () => {
  assert.equal(changeTotals(SAMPLE_CHANGES), '21 added · 3 closed · 1 status change');
  assert.deepEqual(changeTable(SAMPLE_CHANGES), [
    { label: 'Projects', added: 2, removed: 0, closed: 0, statusChanged: 1 },
    { label: 'Issues', added: 14, removed: 0, closed: 3, statusChanged: 0 },
    { label: 'Submittals', added: 5, removed: 0, closed: 0, statusChanged: 0 },
  ]);
  // 10 issues before, 1 new, 9 now: 2 of the old ones are gone.
  const gone = { items: [{ key: 'issues', label: 'Issues', before: 10, after: 9, new: 1, closed: 0 }], modules: [] };
  assert.equal(changeTotals(gone), '1 added · 2 removed');
  assert.deepEqual(changeNotes(SAMPLE_CHANGES), ['New projects: Clinic A, Clinic B', 'Status changes: Old Tower (active → archived)', 'Also changed: Markups +40, Photos −12']);
  assert.equal(changeTotals({ items: [], modules: [{ module: 'photos', label: 'Photos', before: 1, after: 2 }] }), 'Only other modules changed');
  assert.equal(changeTotals({ items: [], modules: [] }), 'No changes');
  assert.equal(changeTotals(null), '');
});

test('sync: keeps the change summary in history and mentions it in the notification', async () => {
  const { fetch } = fakeDcFetch();
  const ctx = makeSync({ dcFetch: fetch, engineResult: { event: 'done', as_of: '2026-11-07', rows: 3540048, tables: 246, views_failed: [], warnings: [], size_mb: 1760, changes: SAMPLE_CHANGES } });
  const entry = await ctx.sync.start('scheduled');
  assert.deepEqual(entry.changes, SAMPLE_CHANGES);
  assert.deepEqual(ctx.store.history()[0].changes, SAMPLE_CHANGES);
  assert.match(ctx.bodies.at(-1), /Issues: 14 new, 3 closed/);
});

// ── Autodesk's daily extraction ─────────────────────────────────────────────
function fakeDc() {
  const calls = [];
  const dc = {
    requests: new Map(),
    jobs: [],
    nextId: 1,
    async createDailyRequest(accountId, body) {
      calls.push(['create', accountId, body]);
      const id = `DAILY${dc.nextId++}`;
      const req = { id, isActive: true, scheduleInterval: 'DAY', ...body, nextExecAt: body.effectiveFrom };
      dc.requests.set(id, req);
      return req;
    },
    async getRequest(accountId, id) {
      calls.push(['get', id]);
      if (!dc.requests.has(id)) throw Object.assign(new Error('Not found'), { status: 404 });
      return dc.requests.get(id);
    },
    async updateRequest(accountId, id, patch) {
      calls.push(['update', id, patch]);
      Object.assign(dc.requests.get(id), patch);
      return dc.requests.get(id);
    },
    async deleteRequest(accountId, id) {
      calls.push(['delete', id]);
      if (!dc.requests.delete(id)) throw Object.assign(new Error('Not found'), { status: 404 });
    },
    async requestJobs() {
      calls.push(['jobs']);
      return dc.jobs;
    },
  };
  return { dc, calls };
}

function cloudSetup({ now, mode = 'cloud', time = '06:00' } = {}) {
  const store = new JsonStore(tmp());
  store.updateSettings({ wizardComplete: true, hub: { accountId: 'acc-1', name: 'Demo' }, schedule: { enabled: true, time }, extractionMode: mode });
  const { dc, calls } = fakeDc();
  const clock = { t: now };
  const auth = { signedIn: true, tokens: { refresh_token: 'x', obtained_at: Date.now() } };
  const cloud = new CloudSchedule({ store, dc, auth, log: quietLog, now: () => clock.t });
  return { store, dc, calls, clock, auth, cloud };
}

test('Autodesk schedule: created once at the next local time, emails off, a year long', async () => {
  const now = new Date(2026, 10, 6, 12, 0).getTime(); // Nov 6, noon local
  const { store, calls, cloud } = cloudSetup({ now });
  const st = await cloud.ensure('test');
  assert.equal(st.active, true);
  const [, accountId, body] = calls.find((c) => c[0] === 'create');
  assert.equal(accountId, 'acc-1');
  assert.equal(new Date(body.effectiveFrom).getTime(), new Date(2026, 10, 7, 6, 0).getTime(), 'today 06:00 has passed: starts tomorrow');
  assert.equal(Math.round((Date.parse(body.effectiveTo) - Date.parse(body.effectiveFrom)) / 86_400_000), 365);
  assert.match(body.description, /Forma Data Manager/);
  assert.equal(store.settings().cloudSchedule.time, '06:00');
  await cloud.ensure('again');
  assert.equal(calls.filter((c) => c[0] === 'create').length, 1, 'healthy: nothing new created');
});

test('Autodesk schedule: turned back on when paused, extended before it ends, recreated if it stays paused', async () => {
  // Jan → Dec of the same year: same side of daylight saving, so the UTC time stays put.
  const start = new Date(2026, 0, 10, 12, 0).getTime();
  const { dc, calls, clock, cloud, store } = cloudSetup({ now: start });
  await cloud.ensure('create');
  const id = store.settings().cloudSchedule.requestId;

  clock.t = start + 20 * 86_400_000;
  dc.requests.get(id).isActive = false; // Autodesk paused it (not downloaded for 14 days)
  await cloud.ensure('check');
  assert.deepEqual(calls.filter((c) => c[0] === 'update').at(-1), ['update', id, { isActive: true }]);

  clock.t = start + 340 * 86_400_000; // less than 30 days before the end
  await cloud.ensure('check');
  const ext = calls.filter((c) => c[0] === 'update').at(-1);
  assert.ok(Date.parse(ext[2].effectiveTo) > clock.t + 360 * 86_400_000, 'end date moved out a year');

  dc.requests.get(id).isActive = false;
  await cloud.ensure('paused again'); // reactivates once more (last try was long ago)
  dc.requests.get(id).isActive = false;
  await cloud.ensure('still paused'); // tried within 2 days: start over
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === id));
  assert.notEqual(store.settings().cloudSchedule.requestId, id);
});

test('Autodesk schedule: new time, daylight saving, deleted at Autodesk, switched off', async () => {
  const now = new Date(2026, 10, 6, 12, 0).getTime();
  const { dc, calls, cloud, store } = cloudSetup({ now });
  await cloud.ensure('create');
  const first = store.settings().cloudSchedule.requestId;

  store.updateSettings({ schedule: { enabled: true, time: '05:30' } });
  await cloud.ensure('time changed');
  const second = store.settings().cloudSchedule.requestId;
  assert.notEqual(second, first);
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === first));
  assert.equal(new Date(dc.requests.get(second).effectiveFrom).getHours(), 5);

  // Same local time but its UTC equivalent moved (what a daylight-saving switch looks like).
  const r = dc.requests.get(second);
  r.effectiveFrom = new Date(Date.parse(r.effectiveFrom) + 3_600_000).toISOString();
  await cloud.ensure('dst');
  const third = store.settings().cloudSchedule.requestId;
  assert.notEqual(third, second);

  dc.requests.delete(third); // someone deleted it in Data Connector
  await cloud.ensure('gone');
  assert.ok(store.settings().cloudSchedule.requestId);

  store.updateSettings({ extractionMode: 'local' });
  await cloud.ensure('mode');
  assert.equal(store.settings().cloudSchedule, null);
  assert.equal(dc.requests.size, 0, 'nothing left running at Autodesk');
});

test('Autodesk schedule: after a real daylight-saving change it still runs at 06:00 local', async () => {
  const { dc, clock, cloud, store } = cloudSetup({ now: new Date(2026, 10, 6, 12, 0).getTime() }); // November
  await cloud.ensure('create');
  const nov = store.settings().cloudSchedule.requestId;
  clock.t = new Date(2027, 2, 20, 12, 0).getTime(); // March, after clocks moved forward
  await cloud.ensure('check');
  const mar = store.settings().cloudSchedule.requestId;
  const from = new Date(dc.requests.get(mar).effectiveFrom);
  if (new Date(2026, 10, 6).getTimezoneOffset() !== new Date(2027, 2, 20).getTimezoneOffset()) {
    assert.notEqual(mar, nov, 'recreated for the new UTC offset');
  }
  assert.equal(from.getHours(), 6);
  assert.equal(from.getMinutes(), 0);
});

test('Data Connector descriptions: only characters it accepts (it answers 400 "Invalid characters" to parentheses)', async () => {
  const { safeDescription } = require('../src/main/dataconnector');
  assert.equal(safeDescription('Forma Data Manager daily extraction (managed by the app)'), 'Forma Data Manager daily extraction managed by the app');
  assert.equal(safeDescription('Forma Data Manager manual 2026-11-06 01:13Z'), 'Forma Data Manager manual 2026-11-06 01:13Z');
  // Through the real client: what goes over the wire for a daily request.
  const sent = [];
  const fetch = async (url, opts) => (sent.push(JSON.parse(opts.body)), json(200, { id: 'D1' }));
  const dc = new DataConnector({ aps: new ApsClient({ auth: { accessToken: async () => 'AT', refresh: async () => {} }, fetch, log: quietLog }), fetch, log: quietLog });
  await dc.createDailyRequest('acc-1', { description: require('../src/main/cloud-schedule').DESCRIPTION, effectiveFrom: 'a', effectiveTo: 'b' });
  assert.match(sent[0].description, /^[A-Za-z0-9 _.:-]+$/);
  assert.equal(sent[0].scheduleInterval, 'DAY');
  assert.equal(sent[0].sendEmail, false);
});

test('Autodesk schedule: a refused request is retried once with the simplest description', async () => {
  const { dc, calls, cloud, store } = cloudSetup({ now: Date.now() });
  const real = dc.createDailyRequest;
  let n = 0;
  dc.createDailyRequest = async (acc, body) => {
    if (n++ === 0) throw Object.assign(new Error('Autodesk API error 400: Invalid characters'), { status: 400, detail: { detail: 'Invalid characters' } });
    return real(acc, body);
  };
  const st = await cloud.ensure('test');
  assert.equal(st.active, true);
  assert.equal(calls.find((c) => c[0] === 'create')[2].description, 'Forma Data Manager daily');
  assert.equal(store.settings().cloudSchedule.lastError, null);
});

test('Autodesk schedule: errors are kept for the UI, never thrown', async () => {
  const { dc, cloud, store } = cloudSetup({ now: Date.now() });
  dc.createDailyRequest = async () => {
    throw Object.assign(new Error('You need Executive Overview access.'), { status: 403 });
  };
  const st = await cloud.ensure('test');
  assert.equal(st.active, false);
  assert.match(store.settings().cloudSchedule.lastError, /Executive Overview/);
});

function schedulerWithCloud({ now, jobs = [], history = [] } = {}) {
  const setup = cloudSetup({ now: now.getTime() });
  const started = [];
  const collected = [];
  const sync = { busy: false, start: (t) => (started.push(t), Promise.resolve()), collect: (job, req, t) => (collected.push({ job, req, t }), Promise.resolve()) };
  for (const h of history) setup.store.addHistory(h);
  setup.dc.jobs = jobs;
  const clock = { now };
  const sch = new Scheduler({ store: setup.store, sync, auth: setup.auth, log: quietLog, cloud: setup.cloud, dc: setup.dc, now: () => clock.now });
  return { ...setup, sch, started, collected, clock };
}

test('scheduler + Autodesk: collects today’s run (even hours later), waits for it, or falls back', async () => {
  // Schedule created the day before, so Autodesk's 06:00 run is expected today.
  const created = new Date(2026, 10, 5, 12, 0);
  const t = schedulerWithCloud({ now: created });
  await t.cloud.ensure('setup');
  t.store.updateSettings({ cloudSchedule: { ...t.store.settings().cloudSchedule, createdAt: created.toISOString(), checkedAt: new Date(2026, 10, 6, 5, 0).toISOString() } });
  const req = t.store.settings().cloudSchedule.requestId;

  // 06:02, no job yet: wait (and don't ask again for a few minutes).
  t.clock.now = new Date(2026, 10, 6, 6, 2);
  assert.equal(t.sch.check(), 'checking-autodesk');
  assert.equal(await t.sch.autodeskCheck, 'waiting-for-autodesk');
  assert.equal(t.sch.check(), 'waiting-for-autodesk');
  assert.equal(t.started.length + t.collected.length, 0);

  // 09:57 (PC was asleep): Autodesk's 06:00 job finished long ago → collect it, no new extraction.
  t.dc.jobs = [{ id: 'J-0600', status: 'complete', completionStatus: 'success', createdAt: new Date(2026, 10, 6, 6, 0).toISOString() }];
  t.clock.now = new Date(2026, 10, 6, 9, 57);
  t.sch.check();
  assert.equal(await t.sch.autodeskCheck, 'collecting');
  assert.deepEqual(t.collected.map((c) => [c.job.id, c.req, c.t]), [['J-0600', req, 'scheduled']]);
  assert.equal(t.started.length, 0);
  assert.equal(t.sch.check(), 'already-ran');

  // Next day: Autodesk's run never showed up → after 45 min the app starts one itself, and notes the miss.
  t.dc.jobs = [];
  t.sch.lastAutodeskPoll = 0;
  t.clock.now = new Date(2026, 10, 7, 6, 50);
  t.sch.check();
  assert.equal(await t.sch.autodeskCheck, 'started');
  assert.deepEqual(t.started, ['scheduled']);
  assert.equal(t.store.settings().cloudSchedule.missedDays, 1);

  // Day after: Autodesk's run failed → start one here right away.
  t.dc.jobs = [{ id: 'J-bad', status: 'failed', createdAt: new Date(2026, 10, 8, 6, 0).toISOString() }];
  t.sch.lastAutodeskPoll = 0;
  t.clock.now = new Date(2026, 10, 8, 6, 20);
  t.sch.check();
  assert.equal(await t.sch.autodeskCheck, 'started');
  assert.equal(t.started.length, 2);
  assert.equal(t.store.settings().cloudSchedule.missedDays, 0, 'a run showed up (it failed, but the schedule works)');
});

test('scheduler + Autodesk: a schedule created after today’s time is not a miss; "This computer" mode never looks at Autodesk', async () => {
  const t = schedulerWithCloud({ now: new Date(2026, 10, 6, 12, 0) });
  await t.cloud.ensure('setup'); // created at noon: first Autodesk run is tomorrow 06:00
  t.store.updateSettings({ cloudSchedule: { ...t.store.settings().cloudSchedule, checkedAt: new Date(2026, 10, 6, 12, 0).toISOString() } });
  t.sch.check();
  assert.equal(await t.sch.autodeskCheck, 'started', 'today still gets data, from this computer');
  assert.equal(t.store.settings().cloudSchedule.missedDays ?? 0, 0);

  const l = schedulerWithCloud({ now: new Date(2026, 10, 6, 6, 1) });
  l.store.updateSettings({ extractionMode: 'local' });
  assert.equal(l.sch.check(), 'started');
  assert.equal(l.calls.filter((c) => c[0] === 'jobs').length, 0);
});

test('upgrade from 4.0.x: first check sets up Autodesk’s schedule, no extra sync the same day', async () => {
  const t = schedulerWithCloud({ now: new Date(2026, 10, 6, 12, 0) });
  t.store.updateSettings({ lastScheduledRunDate: '2026-11-06', extractionMode: undefined }); // 4.0.x had neither
  assert.equal(t.sch.check(), 'already-ran');
  await t.cloud.inFlight;
  const cs = t.store.settings().cloudSchedule;
  assert.ok(cs.requestId, 'created on the first check');
  assert.equal(new Date(cs.nextExecAt).getTime(), new Date(2026, 10, 7, 6, 0).getTime(), 'first Autodesk run: tomorrow 06:00');
  assert.equal(t.started.length + t.collected.length, 0);
});

test('after an upgrade, a setup error from the old version is retried at start-up, not an hour later', async () => {
  const now = new Date(2026, 10, 6, 13, 4);
  const t = schedulerWithCloud({ now });
  t.store.updateSettings({ lastScheduledRunDate: '2026-11-06', cloudSchedule: { lastError: 'Autodesk API error 400: Invalid characters', checkedAt: new Date(2026, 10, 6, 12, 23).toISOString() } });
  t.sch.check();
  await t.cloud.inFlight;
  assert.ok(t.store.settings().cloudSchedule.requestId, 'created right away');
  assert.equal(t.store.settings().cloudSchedule.lastError, null);
});

test('sync: collecting Autodesk’s job skips creating a request and keeps Autodesk’s own timing', async () => {
  const { fetch, seen } = fakeDcFetch({ jobStatuses: ['complete'], completedAt: '2026-11-05T11:06:00Z' });
  const ctx = makeSync({ dcFetch: fetch });
  ctx.store.updateSettings({ cloudSchedule: { requestId: 'DAILY1', accountId: 'acc-1' } });
  const entry = await ctx.sync.collect({ id: 'JOB1', status: 'complete', createdAt: '2026-11-05T11:00:00Z' }, 'DAILY1', 'scheduled');
  assert.equal(entry.status, 'success');
  assert.equal(entry.source, 'autodesk');
  assert.equal(entry.jobId, 'JOB1');
  assert.equal(entry.prepareMinutes, 6, 'from Autodesk’s createdAt to completedAt');
  assert.equal(seen.filter((x) => x.startsWith('POST')).length, 0, 'no new request');
  assert.ok(!seen.some((x) => x.startsWith('DELETE') && x.includes('DAILY1')), 'the daily request is never cleaned up');
  assert.equal(ctx.sync.jobsLast24h(), 1, 'Autodesk’s daily run counts toward the 24');
});

test('scheduler: runs once a day after the set time, catches up, and runs even after a manual sync', () => {
  const store = new JsonStore(tmp());
  store.updateSettings({ wizardComplete: true, schedule: { enabled: true, time: '06:00' } });
  let started = 0;
  const sync = { busy: false, start: () => (started++, Promise.resolve()) };
  const auth = { signedIn: true, tokens: { refresh_token: 'x', obtained_at: Date.now() } };
  let now = new Date(2026, 10, 5, 5, 30);
  const sch = new Scheduler({ store, sync, auth, log: quietLog, now: () => now });
  assert.equal(sch.check(), 'not-yet');
  now = new Date(2026, 10, 5, 9, 15); // app opened late: catch up
  assert.equal(sch.check(), 'started');
  assert.equal(sch.check(), 'already-ran');
  assert.equal(started, 1);
  store.addHistory({ status: 'success', trigger: 'manual', finishedAt: new Date(2026, 10, 6, 4, 0).toISOString() });
  now = new Date(2026, 10, 6, 6, 1); // a manual sync 2 hours ago doesn't cancel the scheduled one
  assert.equal(sch.check(), 'started');
  assert.equal(started, 2);
  assert.equal(sch.nextRun().getDate(), 7);
});

test('Claude Desktop config: merges, backs up, keeps other servers, leaves invalid JSON alone', () => {
  const root = tmp();
  process.env.APPDATA = path.join(root, 'Roaming');
  process.env.LOCALAPPDATA = path.join(root, 'Local');
  const regular = path.join(process.env.APPDATA, 'Claude');
  const store = path.join(process.env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  fs.mkdirSync(regular, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(regular, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, 'forma-data': { command: 'old.exe' } }, preferences: { a: 1 } }));
  fs.writeFileSync(path.join(store, 'claude_desktop_config.json'), '{ not json');

  const res = claudeConfig.install('C:\\Apps\\forma-data.exe', 'D:\\FormaData');
  const okRes = res.find((r) => r.kind === 'installer');
  const badRes = res.find((r) => r.kind === 'store');
  assert.equal(okRes.ok, true);
  assert.ok(fs.existsSync(okRes.backup));
  const cfg = JSON.parse(fs.readFileSync(path.join(regular, 'claude_desktop_config.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers['forma-data'], { command: 'C:\\Apps\\forma-data.exe', args: ['serve'], env: { FORMA_DATA_DIR: 'D:\\FormaData' } });
  assert.deepEqual(cfg.mcpServers.other, { command: 'x' });
  assert.deepEqual(cfg.preferences, { a: 1 });
  assert.equal(badRes.ok, false);
  assert.equal(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8'), '{ not json');
  const states = claudeConfig.inspect('C:\\Apps\\forma-data.exe', 'D:\\FormaData').map((s) => s.state);
  assert.deepEqual(states, ['configured', 'invalid-json']);
  assert.equal(claudeConfig.inspect('C:\\Apps\\forma-data.exe', 'E:\\Other')[0].state, 'outdated');
});

test('Claude Desktop config repair: follows the app to a new folder, never adds or touches anything else', () => {
  const root = tmp();
  process.env.APPDATA = path.join(root, 'Roaming');
  process.env.LOCALAPPDATA = path.join(root, 'Local');
  const regular = path.join(process.env.APPDATA, 'Claude');
  fs.mkdirSync(regular, { recursive: true });
  const file = path.join(regular, 'claude_desktop_config.json');
  const oldExe = 'C:\\Users\\f\\AppData\\Local\\Programs\\Forma Data Manager\\resources\\engine\\forma-data.exe';
  const newExe = 'D:\\Apps\\Forma Data Manager\\resources\\engine\\forma-data.exe';
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  // Not registered (never set up, or removed by the user): repair leaves it alone.
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  assert.deepEqual(claudeConfig.repair(newExe, 'C:\\FormaData'), []);
  assert.equal(read().mcpServers['forma-data'], undefined);

  // Registered at the old folder: re-pointed, extra env kept, other servers untouched, backup made.
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' }, 'forma-data': { command: oldExe, args: ['serve'], env: { FORMA_DATA_DIR: 'C:\\FormaData', EXTRA: '1' } } } }));
  const res = claudeConfig.repair(newExe, 'C:\\FormaData');
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, true);
  assert.equal(res[0].from, oldExe);
  assert.ok(fs.existsSync(res[0].backup));
  assert.deepEqual(read().mcpServers['forma-data'], { command: newExe, args: ['serve'], env: { FORMA_DATA_DIR: 'C:\\FormaData', EXTRA: '1' } });
  assert.deepEqual(read().mcpServers.other, { command: 'x' });

  // Already current: nothing to do. Data folder changed: follows it.
  assert.deepEqual(claudeConfig.repair(newExe, 'C:\\FormaData'), []);
  assert.equal(claudeConfig.repair(newExe, 'D:\\FormaData')[0].ok, true);
  assert.equal(read().mcpServers['forma-data'].env.FORMA_DATA_DIR, 'D:\\FormaData');

  // Unparseable file: reported, left byte-for-byte as is.
  fs.writeFileSync(file, '{ not json');
  assert.equal(claudeConfig.repair(newExe, 'C:\\FormaData')[0].ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('skill ZIP: folder inside, valid archive, edited SKILL.md validated', () => {
  const src = path.join(__dirname, '..', '..', 'claude-plugin', 'skills', 'forma-data-dashboards');
  const out = skill.writeSkillZip(src, tmp());
  const buf = fs.readFileSync(out);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes(Buffer.from('forma-data-dashboards/SKILL.md')));
  assert.equal(skill.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(skill.validateSkillMd('no front matter'), 'SKILL.md must start with a --- front-matter block.');
  assert.equal(skill.validateSkillMd('---\nname: my-skill\ndescription: Does things\n---\nbody'), null);
  const home = tmp();
  const dest = skill.installForClaudeCode(src, { home, skillMd: '---\nname: my-dash\ndescription: Custom\n---\nhi' });
  assert.equal(path.basename(dest), 'my-dash');
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').trim().endsWith('hi'), true);
});

test('log redaction', () => {
  assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('https://s3/x?X-Amz-Signature=deadbeef&x=1'), 'https://s3/x?X-Amz-Signature=[redacted]&x=1');
  assert.equal(redact('refresh_token=RT1&client_id=C'), 'refresh_token=[redacted]&client_id=C');
});

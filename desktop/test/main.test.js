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
  await assert.rejects(aps.get('/data-connector/v1/accounts/acc-1/requests'), /hub \(account\) admin with Executive access.*Custom Integrations/);
});

test('job outcome mapping', () => {
  assert.equal(jobOutcome({ status: 'complete', completionStatus: 'success' }), 'success');
  assert.equal(jobOutcome({ status: 'complete', completionStatus: 'failed' }), 'failed');
  assert.equal(jobOutcome({ status: 'running' }), 'running');
  assert.equal(jobOutcome({ status: 'queued' }), 'running');
  assert.equal(jobOutcome({ status: 'cancelled' }), 'failed');
});

function fakeDcFetch({ zipBytes = Buffer.from('PK-fake-zip-bytes'), jobStatuses = ['queued', 'running', 'complete'], truncate = false } = {}) {
  let jobPolls = 0;
  const seen = [];
  const fetch = async (url, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${url.replace('https://developer.api.autodesk.com', '')}`);
    if (url.startsWith('https://signed.example/')) {
      const body = truncate ? zipBytes.subarray(0, 5) : zipBytes;
      return new Response(body, { status: 200, headers: { 'content-length': String(zipBytes.length) } });
    }
    if (opts.method === 'POST' && url.endsWith('/requests')) return json(200, { id: 'REQ1' });
    if (url.endsWith('/requests/REQ1/jobs')) return json(200, { results: [{ id: 'JOB1', status: 'queued', createdAt: '2026-11-05T10:00:00Z' }] });
    if (url.endsWith('/jobs/JOB1')) {
      const status = jobStatuses[Math.min(jobPolls++, jobStatuses.length - 1)];
      return json(200, { id: 'JOB1', status, completionStatus: status === 'complete' ? 'success' : undefined });
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
  const sync = new SyncManager({ store, auth, dc, engine, log: quietLog, notify: (t, b) => notes.push(t), sleep: async () => {} });
  return { sync, store, builds, dataDir, notes };
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

test('scheduler: runs once a day after the set time, catches up, skips after a recent sync', () => {
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
  store.addHistory({ status: 'success', finishedAt: new Date(2026, 10, 6, 4, 0).toISOString() });
  now = new Date(2026, 10, 6, 6, 1);
  assert.equal(sch.check(), 'recent');
  assert.equal(started, 1);
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

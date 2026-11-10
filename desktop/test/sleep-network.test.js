'use strict';
/**
 * Replays what happened on a real laptop, Nov 7–10, 2026 (Modern Standby sleeps, slow Wi-Fi on wake):
 *  - a build paused by sleep was killed on wake by a wall-clock 2-hour limit ("Engine exited with code null");
 *  - the first calls after waking failed (token refresh: net::ERR_NETWORK_IO_SUSPENDED / ERR_NAME_NOT_RESOLVED),
 *    the scheduled sync failed in 0.1 s and wasn't tried again that day;
 *  - a failed look at Autodesk's jobs started a new extraction instead of waiting for the connection;
 *  - the History duration counted 2 hours of sleep.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SleepTracker, WALL_CLOCK, isNetworkError } = require('../src/main/power');
const { Engine } = require('../src/main/engine');
const { ApsClient, ApsError } = require('../src/main/aps');
const { DataConnector } = require('../src/main/dataconnector');
const { SyncManager } = require('../src/main/sync');
const { Scheduler } = require('../src/main/scheduler');
const { CloudSchedule } = require('../src/main/cloud-schedule');
const { JsonStore } = require('../src/main/store');

const tmp = (p = 'fdm-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const logs = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`) };
};
const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const netErr = (code = 'ERR_NETWORK_IO_SUSPENDED') => new Error(`net::${code}`);

test('network errors: told apart from answers Autodesk gave', () => {
  assert.equal(isNetworkError(netErr()), true);
  assert.equal(isNetworkError(netErr('ERR_NAME_NOT_RESOLVED')), true);
  assert.equal(isNetworkError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), true);
  assert.equal(isNetworkError(new ApsError('Network error talking to Autodesk: x', { code: 'network' })), true);
  assert.equal(isNetworkError(new ApsError('Data Connector refused the request (403).', { status: 403 })), false);
  assert.equal(isNetworkError(new Error('The Data Connector job ended with status "failed".')), false);
  assert.equal(isNetworkError(null), false);
});

test('sleep tracker: a long gap between ticks is sleep, not awake time', () => {
  let t = 1_000_000;
  const tr = new SleepTracker({ tickMs: 10_000, now: () => t });
  t += 10_000;
  tr.tick();
  t += 3 * 3_600_000; // asleep for 3 hours: no ticks
  assert.equal(Math.round(tr.asleepBetween(1_000_000, t) / 60_000), 180);
  assert.equal(tr.awakeBetween(1_000_000, t), 20_000, 'two ticks of awake time');
  assert.equal(WALL_CLOCK.awakeBetween(0, 5000), 5000);
});

test('engine: a build paused by sleep is not stopped on wake; a stuck build is, with a clear message', async () => {
  const quick = { command: process.execPath, prefix: ['-e', "setTimeout(() => console.log(JSON.stringify({ event: 'done', rows: 1 })), 400)"], exePath: null };
  let clock = Date.parse('2026-11-08T07:25:00Z');
  const tracker = new SleepTracker({ now: () => clock });
  const engine = new Engine(quick, logs(), { sleep: tracker, now: () => clock, watchMs: 30 });
  const run = engine.run([]);
  clock += 2.5 * 3_600_000; // Nov 8: the PC slept mid-build and woke 2.5 hours later
  const out = await run;
  assert.equal(out.event, 'done', 'finished normally after waking');

  const stuck = { command: process.execPath, prefix: ['-e', 'setTimeout(() => {}, 20000)'], exePath: null };
  let clock2 = Date.parse('2026-11-08T07:25:00Z');
  const wall = new Engine(stuck, logs(), { now: () => clock2, watchMs: 30 }); // no sleep info: wall clock
  const run2 = wall.run([]);
  clock2 += 2.5 * 3_600_000;
  await assert.rejects(run2, (e) => /still running after 2 hours/.test(e.message) && e.timedOut === true && !/code null/.test(e.message));
});

test('APS client: the token refresh after waking is retried until the network is back', async () => {
  let refreshes = 0;
  const auth = {
    accessToken: async () => {
      if (refreshes++ < 3) throw netErr(); // first calls after waking: the token refresh can't connect
      return 'AT';
    },
  };
  const waits = [];
  const aps = new ApsClient({ auth, fetch: async () => json(200, { ok: 1 }), log: logs(), wait: async (ms) => waits.push(ms) });
  assert.deepEqual(await aps.get('/x'), { ok: 1 });
  assert.deepEqual(waits, [2000, 4000, 8000]);

  // Signed out is final: no retries.
  const out = new ApsClient({ auth: { accessToken: async () => Promise.reject(Object.assign(new Error('Not signed in.'), { name: 'AuthError', code: 'signed_out' })) }, fetch: async () => json(200, {}), log: logs(), wait: async () => assert.fail('no wait') });
  await assert.rejects(out.get('/x'), /Not signed in/);

  // Never comes back: a clear message after about four minutes of trying.
  const waits2 = [];
  const dead = new ApsClient({ auth: { accessToken: async () => 'AT' }, fetch: async () => Promise.reject(netErr('ERR_NAME_NOT_RESOLVED')), log: logs(), wait: async (ms) => waits2.push(ms) });
  await assert.rejects(dead.get('/x'), (e) => e.code === 'network' && /Couldn't reach Autodesk: no network connection \(net::ERR_NAME_NOT_RESOLVED\)/.test(e.message));
  assert.ok(waits2.reduce((a, b) => a + b, 0) >= 3 * 60_000);
});

test('download: a connection dropped by sleep gets longer waits and finishes', async () => {
  const bytes = Buffer.from('PK-zip');
  let gets = 0;
  const fetch = async (url) => {
    if (url.startsWith('https://signed.example/')) {
      if (gets++ < 2) throw netErr(); // Nov 7: "Download attempt 1 ... failed: net::ERR_NETWORK_IO_SUSPENDED"
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    }
    return json(200, { signedUrl: 'https://signed.example/f.zip' });
  };
  const waits = [];
  const log = logs();
  const aps = new ApsClient({ auth: { accessToken: async () => 'AT' }, fetch, log, wait: async () => {} });
  const dc = new DataConnector({ aps, fetch, log, wait: async (ms) => waits.push(ms) });
  const dest = path.join(tmp(), 'x.zip');
  const r = await dc.download('acc', 'JOB', 'autodesk_data_extract.zip', dest, { expectedSize: bytes.length });
  assert.equal(r.size, bytes.length);
  assert.deepEqual(waits, [5000, 15000]);
  assert.match(log.lines[0], /attempt 1 of 6/);
});

function makeSync({ fetch, sleepTracker, now }) {
  const store = new JsonStore(tmp('fdm-ud-'));
  store.updateSettings({ hub: { accountId: 'acc-1', name: 'Demo' }, dataDir: tmp('fdm-data-'), wizardComplete: true });
  const auth = { signedIn: true, accessToken: async () => 'AT', refresh: async () => {} };
  const log = logs();
  const aps = new ApsClient({ auth, fetch, log, wait: async () => {} });
  const dc = new DataConnector({ aps, fetch, log, wait: async () => {} });
  const engine = { cancel() {}, async build() { return { event: 'done', as_of: '2026-11-10', rows: 3551051, tables: 246 }; } };
  const sync = new SyncManager({ store, auth, dc, engine, log, sleep: async () => {}, sleepTracker, now });
  return { sync, store, log };
}

function dcFetch({ offlinePolls = 0 } = {}) {
  let polls = 0;
  return async (fullUrl, opts = {}) => {
    const url = fullUrl.split('?')[0];
    if (url.startsWith('https://signed.example/')) return new Response(Buffer.from('PK'), { status: 200, headers: { 'content-length': '2' } });
    if (opts.method === 'POST') return json(200, { id: 'REQ1' });
    if (url.endsWith('/requests/REQ1/jobs')) return json(200, { results: [{ id: 'JOB1', status: 'queued', createdAt: '2026-11-10T13:46:00Z' }] });
    if (url.endsWith('/jobs/JOB1')) {
      if (polls++ < offlinePolls) throw netErr(); // the PC slept while Autodesk was preparing
      return json(200, { id: 'JOB1', status: 'complete', completionStatus: 'success' });
    }
    if (url.endsWith('/data-listing')) return json(200, [{ name: 'autodesk_data_extract.zip', size: 2 }]);
    if (url.includes('/data/')) return json(200, { signedUrl: 'https://signed.example/z' });
    if (opts.method === 'DELETE') return json(204, null);
    throw new Error(`unexpected ${url}`);
  };
}

test('sync: losing the connection while Autodesk prepares the extract doesn’t fail the sync', async () => {
  // Short drops are absorbed by the API client's own retries (9 tries each); a longer outage reaches
  // the waiting loop, which keeps waiting instead of failing.
  const { sync, log } = makeSync({ fetch: dcFetch({ offlinePolls: 18 }) });
  const entry = await sync.start('scheduled');
  assert.equal(entry.status, 'success');
  assert.equal(log.lines.filter((l) => l.includes('No connection while waiting')).length, 2);

  // An outage that never ends still fails, after a bounded number of checks.
  const dead = makeSync({ fetch: dcFetch({ offlinePolls: 1e9 }) });
  const failed = await dead.sync.start('scheduled');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Couldn't reach Autodesk/);
});

test('sync: the duration in History leaves out time the PC was asleep', async () => {
  let clock = Date.parse('2026-11-10T11:52:15Z');
  const tracker = new SleepTracker({ now: () => clock });
  const fetch = dcFetch();
  const slept = async (...args) => {
    // Nov 10: started at 6:52 AM during a short wake, then the PC slept until 8:44 AM.
    if (clock < Date.parse('2026-11-10T13:00:00Z')) clock = Date.parse('2026-11-10T13:44:00Z');
    clock += 30_000;
    return fetch(...args);
  };
  const { sync, store } = makeSync({ fetch: slept, sleepTracker: tracker, now: () => clock });
  const entry = await sync.start('scheduled');
  assert.equal(entry.status, 'success');
  assert.ok(entry.minutes < 10, `awake time only (got ${entry.minutes} min)`);
  assert.ok(entry.pausedMinutes > 100, `sleep shown separately (got ${entry.pausedMinutes} min)`);
  assert.equal(store.history()[0].pausedMinutes, entry.pausedMinutes);
});

function cloudScheduler({ now, online = true, jobs = [] }) {
  const store = new JsonStore(tmp());
  store.updateSettings({ wizardComplete: true, hub: { accountId: 'acc-1', name: 'Demo' }, schedule: { enabled: true, time: '06:00' }, extractionMode: 'cloud', lastScheduledRunDate: '2026-11-08' });
  const clock = { now, online, jobsError: null };
  const dc = {
    jobs,
    calls: [],
    async requestJobs() {
      dc.calls.push('jobs');
      if (clock.jobsError) throw clock.jobsError;
      return dc.jobs;
    },
    async getRequest(a, id) {
      if (clock.jobsError) throw clock.jobsError;
      return { id, isActive: true, effectiveFrom: new Date(2026, 10, 7, 6, 0).toISOString(), effectiveTo: new Date(2027, 10, 7, 6, 0).toISOString() };
    },
  };
  const auth = { signedIn: true, tokens: { refresh_token: 'x', obtained_at: Date.now() } };
  const log = logs();
  const cloud = new CloudSchedule({ store, dc, auth, log, now: () => clock.now.getTime() });
  store.updateSettings({ cloudSchedule: { requestId: 'DAILY1', accountId: 'acc-1', time: '06:00', createdAt: new Date(2026, 10, 6, 13, 8).toISOString(), checkedAt: new Date(2026, 10, 9, 10, 0).toISOString() } });
  const runs = [];
  // Each run fails or succeeds as the test says, and lands in History like the real thing.
  clock.outcome = 'failed';
  const finish = (kind, t, jobId) => {
    runs.push({ kind, jobId });
    const entry = { status: clock.outcome, trigger: t, startedAt: clock.now.toISOString(), finishedAt: clock.now.toISOString(), jobId, error: clock.outcome === 'failed' ? 'net::ERR_NETWORK_IO_SUSPENDED' : undefined };
    store.addHistory(entry);
    return Promise.resolve(entry);
  };
  const sync = { busy: false, start: (t) => finish('start', t, 'NEW'), collect: (job, req, t) => finish('collect', t, job.id) };
  const sch = new Scheduler({ store, sync, auth, log, cloud, dc, now: () => clock.now, isOnline: () => clock.online });
  sch.checkedScheduleSinceStart = true;
  return { store, sch, clock, runs, dc, log, cloud };
}

test('scheduler: right after waking it waits for the network instead of failing the day', async () => {
  const job = { id: 'J-1109', status: 'complete', completionStatus: 'success', createdAt: new Date(2026, 10, 9, 6, 0).toISOString() };
  const t = cloudScheduler({ now: new Date(2026, 10, 9, 11, 22), online: false, jobs: [job] });
  assert.equal(t.sch.check(), 'offline', 'Windows says no connection: nothing started');
  assert.equal(t.runs.length + t.dc.calls.length, 0);

  // Connected, but the first call still fails (DNS not ready): look again later, don't start a new extraction.
  t.clock.online = true;
  t.clock.jobsError = netErr('ERR_NAME_NOT_RESOLVED');
  t.sch.check();
  assert.equal(await t.sch.autodeskCheck, 'offline');
  assert.equal(t.runs.length, 0, 'no one-time extraction started');
  assert.equal(t.store.settings().lastScheduledRunDate, '2026-11-08', 'today is still to do');

  // A few minutes later it works: Autodesk's 06:00 extract is collected (no new job used).
  t.clock.jobsError = null;
  t.clock.outcome = 'success';
  t.clock.now = new Date(2026, 10, 9, 11, 27);
  t.sch.check();
  assert.equal(await t.sch.autodeskCheck, 'collecting');
  assert.deepEqual(t.runs, [{ kind: 'collect', jobId: 'J-1109' }]);
});

test('scheduler: a failed scheduled sync is tried again 10, 30 and 60 minutes later, then waits for tomorrow', async () => {
  const job = { id: 'J-1109', status: 'complete', completionStatus: 'success', createdAt: new Date(2026, 10, 9, 6, 0).toISOString() };
  const t = cloudScheduler({ now: new Date(2026, 10, 9, 11, 22), jobs: [job] });
  const step = async (h, m) => {
    t.clock.now = new Date(2026, 10, 9, h, m);
    t.sch.lastAutodeskPoll = 0;
    const r = t.sch.check();
    return r === 'checking-autodesk' ? t.sch.autodeskCheck : r;
  };
  assert.equal(await step(11, 22), 'collecting');
  assert.equal(t.runs.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(t.log.lines.some((l) => /will try again at/.test(l)));
  assert.equal(t.sch.pendingRetry().getTime(), new Date(2026, 10, 9, 11, 32).getTime());
  assert.equal(t.sch.nextRun().getTime(), new Date(2026, 10, 9, 11, 32).getTime());
  assert.equal(await step(11, 25), 'retry-later');
  assert.equal(await step(11, 32), 'collecting', '2nd attempt');
  assert.equal(await step(11, 50), 'retry-later');
  assert.equal(await step(12, 2), 'collecting', '3rd attempt, 30 minutes later');
  assert.equal(await step(13, 2), 'collecting', '4th attempt, 60 minutes later');
  assert.equal(await step(15, 0), 'already-ran', 'no more retries today');
  assert.deepEqual(t.runs.map((r) => r.jobId), ['J-1109', 'J-1109', 'J-1109', 'J-1109'], 'every retry collects Autodesk’s same extract: no new jobs');
  assert.equal(t.sch.pendingRetry(), null);

  // A run that worked is never retried.
  const ok = cloudScheduler({ now: new Date(2026, 10, 9, 11, 22), jobs: [job] });
  ok.clock.outcome = 'success';
  ok.sch.check();
  await ok.sch.autodeskCheck;
  ok.clock.now = new Date(2026, 10, 9, 12, 30);
  assert.equal(ok.sch.check(), 'already-ran');
});

test('Autodesk schedule check: no connection is not an error and is re-checked in 10 minutes, not 12 hours', async () => {
  const t = cloudScheduler({ now: new Date(2026, 10, 10, 6, 52) });
  t.store.updateSettings({ lastScheduledRunDate: '2026-11-10', cloudSchedule: { ...t.store.settings().cloudSchedule, checkedAt: new Date(2026, 10, 9, 18, 0).toISOString() } });
  t.clock.jobsError = netErr('ERR_NAME_NOT_RESOLVED');
  t.sch.check(); // 12-hour health check is due
  await t.cloud.inFlight;
  const cs = t.store.settings().cloudSchedule;
  assert.equal(cs.lastError ?? null, null, 'Settings doesn’t show "Autodesk schedule unavailable"');
  assert.equal(Date.parse(cs.recheckAfter), new Date(2026, 10, 10, 7, 2).getTime());
  assert.ok(t.log.lines.some((l) => /Couldn't reach Autodesk to check the daily extraction/.test(l)));

  t.clock.jobsError = null;
  t.clock.now = new Date(2026, 10, 10, 6, 58);
  t.sch.check();
  assert.equal(t.cloud.inFlight ?? null, null, 'not yet');
  t.clock.now = new Date(2026, 10, 10, 7, 3);
  t.sch.check();
  await t.cloud.inFlight;
  assert.equal(t.store.settings().cloudSchedule.recheckAfter, null, 'checked again and healthy');
});

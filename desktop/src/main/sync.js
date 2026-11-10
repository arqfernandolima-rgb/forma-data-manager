'use strict';
/**
 * One sync = Data Connector extraction → download → engine build → pointer swap.
 *
 * Phases: requesting → waiting (job queued/running at Autodesk) → downloading → building → done.
 * The in-flight state is saved after every step, so closing the app or rebooting
 * mid-sync resumes the same job instead of starting (and paying for) a new one.
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { jobOutcome } = require('./dataconnector');
const { changeHeadline } = require('../renderer/changes');
const { WALL_CLOCK, isNetworkError } = require('./power');

const DAY = 24 * 60 * 60_000;
const JOB_LIMIT = 24; // Data Connector: per hub and per user, rolling 24h
const JOB_WARN = 20;
const WAIT_FOR_JOB_MS = 45 * 60_000; // job should appear quickly after the request
const WAIT_FOR_RESULT_MS = 10 * 60 * 60_000; // large hubs can take hours
const MAX_OFFLINE_POLLS = 6; // while waiting: give up after this many checks in a row with no connection (each retries for minutes)

class SyncCancelled extends Error {}

class SyncManager extends EventEmitter {
  constructor({ store, auth, dc, engine, log, notify = () => {}, sleep, now = () => Date.now(), sleepTracker = WALL_CLOCK }) {
    super();
    this.sleepTracker = sleepTracker; // durations count time the PC was awake
    this.store = store;
    this.auth = auth;
    this.dc = dc;
    this.engine = engine;
    this.log = log;
    this.notify = notify;
    this.now = now;
    this.sleep = sleep || ((ms, signal) => new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(new SyncCancelled('Sync cancelled.'))), { once: true });
    }));
    this.running = null;
    this.status = { phase: 'idle' };
    this.abort = null;
  }

  get busy() {
    return !!this.running;
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch, updatedAt: new Date(this.now()).toISOString() };
    this.emit('update', this.status);
  }

  /**
   * Jobs this app started in the last 24h, plus one for Autodesk's daily run when that schedule
   * exists (UI-started jobs at Autodesk also count toward the limit, but we can't see those).
   */
  jobsLast24h() {
    const s = this.store.settings();
    const since = this.now() - DAY;
    return (s.ownedRequests || []).filter((r) => Date.parse(r.createdAt) > since).length + (s.cloudSchedule?.requestId ? 1 : 0);
  }

  preflight() {
    const s = this.store.settings();
    if (!this.auth.signedIn) return 'Sign in to Autodesk first.';
    if (!s.hub?.accountId) return 'Choose a hub first.';
    if (!s.dataDir) return 'Choose a data folder first.';
    if (this.jobsLast24h() >= JOB_LIMIT) return `This app already started ${JOB_LIMIT} Data Connector jobs in the last 24 hours, which is Autodesk's limit. Try again later.`;
    return null;
  }

  /** Start a new sync. trigger: 'manual' | 'scheduled'. */
  start(trigger = 'manual') {
    if (this.running) return this.running;
    const problem = this.preflight();
    if (problem) return Promise.reject(new Error(problem));
    const s = this.store.settings();
    const state = { trigger, startedAt: new Date(this.now()).toISOString(), accountId: s.hub.accountId, hubName: s.hub.name, phase: 'requesting' };
    this.store.setSyncState(state);
    return this.launch(state);
  }

  /**
   * Collect a job that Autodesk's daily schedule started (cloud-schedule.js): no new request,
   * the pipeline starts at "waiting" and polls, downloads and builds as usual.
   */
  collect(job, requestId, trigger = 'scheduled') {
    if (this.running) return this.running;
    const s = this.store.settings();
    if (!this.auth.signedIn) return Promise.reject(new Error('Sign in to Autodesk first.'));
    if (!s.hub?.accountId || !s.dataDir) return Promise.reject(new Error('Finish setup first.'));
    const at = job.createdAt || job.startedAt || new Date(this.now()).toISOString();
    const state = {
      trigger,
      source: 'autodesk',
      startedAt: new Date(this.now()).toISOString(),
      accountId: s.hub.accountId,
      hubName: s.hub.name,
      phase: 'waiting',
      requestId,
      jobId: job.id,
      timeline: { requestedAt: at, confirmedAt: at, requestId, jobId: job.id, byAutodesk: true },
    };
    this.store.setSyncState(state);
    return this.launch(state);
  }

  /** Resume a sync that was in progress when the app closed. */
  resume() {
    const state = this.store.syncState();
    if (!state || this.running) return null;
    if (state.phase === 'rejected') {
      this.setStatus({ phase: 'rejected', message: state.message, trigger: state.trigger, startedAt: state.startedAt });
      return null;
    }
    this.log.info(`Resuming sync from phase "${state.phase}" (job ${state.jobId || 'not created yet'})`);
    return this.launch(state, { resumed: true });
  }

  launch(state, { resumed = false } = {}) {
    // Awake time spent before an app restart is kept in the saved state.
    state.awakeBase = state.awakeMs || 0;
    state.launchedAt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    // Start the pipeline on the next microtask so `running` is already set when it
    // emits its first update; otherwise listeners would see busy === false at the start.
    this.running = Promise.resolve()
      .then(() => this.pipeline(state, abort.signal))
      .catch((e) => this.fail(state, e))
      .finally(() => {
        this.running = null;
        if (this.abort === abort) this.abort = null;
        // The pipeline's final update ("done" / "failed") fired while it was still
        // running. Listeners such as the tray read `busy` on each update, so tell them
        // it's idle now; without this the tray stays on "syncing" forever.
        this.emit('update', this.status);
      });
    if (resumed) this.setStatus({ resumed: true });
    return this.running;
  }

  cancel() {
    if (!this.running) return;
    this.log.info('Sync cancelled by user');
    this.abort?.abort();
    this.engine.cancel();
  }

  save(state) {
    this.store.setSyncState(state);
  }

  /**
   * Timeline shown in the app. Timestamps are kept in the saved sync state,
   * so a resumed sync still shows when each step really happened.
   */
  mark(state, patch) {
    state.timeline = { ...(state.timeline || {}), ...patch };
    state.awakeMs = this.awakeSoFar(state);
    this.save(state);
    this.setStatus({ timeline: state.timeline });
  }

  /** Time this sync has run while the PC was awake (not counting sleep). */
  awakeSoFar(state) {
    const from = state.launchedAt ?? (Date.parse(state.startedAt) || this.now());
    return (state.awakeBase || 0) + this.sleepTracker.awakeBetween(from, this.now());
  }

  /** How long Autodesk took to prepare recent extracts, and how big they were (from history). */
  estimate() {
    const ok = this.store.history().filter((h) => h.status === 'success' && h.prepareMinutes != null).slice(0, 5);
    if (!ok.length) return { prepareMinutes: null, sizeBytes: null, basedOn: 0 };
    const m = ok.map((h) => h.prepareMinutes).sort((a, b) => a - b);
    const median = m.length % 2 ? m[(m.length - 1) / 2] : (m[m.length / 2 - 1] + m[m.length / 2]) / 2;
    return { prepareMinutes: Math.max(1, Math.round(median)), sizeBytes: ok[0].sizeBytes ?? null, basedOn: ok.length };
  }

  async pipeline(state, signal) {
    const s = this.store.settings();
    const t0 = Date.parse(state.startedAt) || this.now();
    const iso = () => new Date(this.now()).toISOString();
    state.timeline = state.timeline || {};
    this.setStatus({ phase: state.phase, trigger: state.trigger, startedAt: state.startedAt, message: null, progress: null, error: null, timeline: state.timeline, estimate: this.estimate(), lastResult: null });

    // 1. Request
    if (!state.requestId) {
      this.setStatus({ phase: 'requesting', message: 'Sending the extraction request to Autodesk Data Connector…' });
      const desc = `Forma Data Manager ${state.trigger} ${new Date(t0).toISOString().slice(0, 16).replace('T', ' ')}Z`;
      const req = await this.dc.createOneTimeRequest(state.accountId, desc);
      if (!req?.id) throw new Error('Data Connector did not return a request id.');
      state.requestId = req.id;
      state.phase = 'waiting';
      this.mark(state, { requestedAt: iso(), requestId: req.id });
      const owned = [...(this.store.settings().ownedRequests || []), { id: req.id, accountId: state.accountId, createdAt: iso() }];
      this.store.updateSettings({ ownedRequests: owned.slice(-200) });
      this.log.info(`Created Data Connector request ${req.id}`);
      const used = this.jobsLast24h();
      if (used >= JOB_WARN) this.setStatus({ warning: `${used} of ${JOB_LIMIT} Data Connector jobs used in the last 24 hours.` });
    }

    // 2. Wait for Autodesk to prepare the extract
    if (state.phase === 'waiting') {
      const waitStart = this.now();
      let polls = 0;
      let offlinePolls = 0;
      let finishedAt = null;
      for (;;) {
        if (signal.aborted) throw new SyncCancelled('Sync cancelled.');
        let jobStatus = null;
        let offline = false;
        try {
          if (!state.jobId) {
            const jobs = await this.dc.requestJobs(state.accountId, state.requestId);
            const job = jobs.sort((a, b) => String(b.createdAt || b.startedAt || '').localeCompare(String(a.createdAt || a.startedAt || '')))[0];
            if (job?.id) {
              state.jobId = job.id;
              this.mark(state, { confirmedAt: iso(), jobId: job.id });
              this.log.info(`Job ${job.id} created (status ${job.status})`);
            } else if (this.now() - waitStart > WAIT_FOR_JOB_MS) {
              throw new Error('Data Connector accepted the request but no job started within 45 minutes. Check Data Connector in Forma, then try again.');
            }
          }
          if (state.jobId) {
            const job = await this.dc.getJob(state.accountId, state.jobId);
            const outcome = jobOutcome(job);
            jobStatus = job?.status ?? null;
            if (outcome === 'success') {
              // A job Autodesk finished hours ago (PC was asleep) should show when it really finished.
              const done = Date.parse(job?.completedAt || '');
              const asked = Date.parse(state.timeline?.confirmedAt || state.timeline?.requestedAt || '') || 0;
              finishedAt = Number.isFinite(done) && done >= asked && done <= this.now() ? new Date(done).toISOString() : null;
              break;
            }
            if (outcome === 'failed') throw new Error(`The Data Connector job ended with status "${job?.status}"${job?.completionStatus ? ` / "${job.completionStatus}"` : ''}. Check Data Connector in Forma for details.`);
            if (this.now() - waitStart > WAIT_FOR_RESULT_MS) throw new Error('The Data Connector job is still running after 10 hours. It may finish later; run Sync now again to pick it up.');
          }
          offlinePolls = 0;
        } catch (e) {
          // Lost the connection (PC slept, Wi-Fi/VPN dropped): Autodesk keeps working, so keep waiting.
          if (!isNetworkError(e) || ++offlinePolls > MAX_OFFLINE_POLLS) throw e;
          offline = true;
          this.log.warn(`No connection while waiting for Autodesk (${e.message}); will keep checking.`);
        }
        polls++;
        const waitMs = polls < 10 ? 20_000 : 60_000;
        this.setStatus({
          phase: 'waiting',
          message: offline ? 'No connection to Autodesk right now; will keep checking.' : null,
          job: { id: state.jobId, status: jobStatus },
          lastCheckAt: iso(),
          nextCheckAt: new Date(this.now() + waitMs).toISOString(),
        });
        await this.sleep(waitMs, signal);
      }
      state.phase = 'downloading';
      this.mark(state, { preparedAt: finishedAt || iso() });
    }

    // 3. Download
    const downloads = path.join(s.dataDir, 'downloads');
    if (state.phase === 'downloading') {
      this.setStatus({ phase: 'downloading', message: 'Listing the extract files…', progress: null });
      const listing = await this.dc.dataListing(state.accountId, state.jobId);
      const zip = listing.find((f) => f.name === 'autodesk_data_extract.zip') || listing.find((f) => /\.zip$/i.test(f.name));
      const dlStart = this.now();
      this.mark(state, { downloadStartedAt: iso() });
      const progress = (done, total, label) => {
        const secs = Math.max(0.5, (this.now() - dlStart) / 1000);
        const rate = done / secs;
        this.setStatus({
          message: label,
          progress: total ? done / total : null,
          download: { done, total, bytesPerSec: rate, secondsLeft: total && rate > 0 ? Math.round((total - done) / rate) : null },
        });
      };
      if (zip) {
        const total = Number(zip.size) || undefined;
        this.mark(state, { downloadBytes: total ?? null, downloadName: zip.name });
        const dest = path.join(downloads, `${state.jobId}.zip`);
        const r = await this.dc.download(state.accountId, state.jobId, zip.name, dest, {
          expectedSize: total,
          signal,
          onProgress: ({ done, total: t }) => progress(done, t, `Downloading ${fmtMb(done)}${t ? ` of ${fmtMb(t)}` : ''}`),
        });
        this.mark(state, { downloadBytes: r.size });
        state.input = { zipPath: dest };
      } else {
        // No bundled ZIP in the listing: fetch the CSVs and schema files individually.
        const files = listing.filter((f) => /\.csv$/i.test(f.name) || /^schemas\/.*\.json$/i.test(f.name));
        if (!files.length) throw new Error('The finished job has no data files.');
        const totalBytes = files.reduce((a, f) => a + (Number(f.size) || 0), 0) || null;
        this.mark(state, { downloadBytes: totalBytes, downloadName: `${files.length} files` });
        const dir = path.join(downloads, state.jobId);
        let doneBytes = 0;
        let i = 0;
        for (const f of files) {
          i++;
          const r = await this.dc.download(state.accountId, state.jobId, f.name, path.join(dir, ...f.name.split('/')), { expectedSize: Number(f.size) || undefined, signal });
          doneBytes += r.size;
          progress(doneBytes, totalBytes || 0, `Downloading file ${i} of ${files.length}`);
        }
        state.input = { csvDir: dir };
      }
      state.phase = 'building';
      this.mark(state, { downloadedAt: iso() });
    }

    // 4. Build
    let result;
    if (state.phase === 'building') {
      this.mark(state, { buildStartedAt: iso() });
      result = await this.build(state, { force: !!state.force, signal });
    }

    // 5. Done
    const finished = this.now();
    const tl = state.timeline || {};
    const toMin = (ms) => Math.round(ms / 6000) / 10;
    const minutesBetween = (a, b) => (a && b ? toMin(Date.parse(b) - Date.parse(a)) : null);
    // Download and build happen on this PC: don't count time it spent asleep.
    const awakeBetween = (a, b) => (a && b ? toMin(this.sleepTracker.awakeBetween(Date.parse(a), Date.parse(b))) : null);
    const awake = this.awakeSoFar(state);
    const paused = Math.max(0, finished - t0 - awake);
    const entry = {
      status: 'success',
      trigger: state.trigger,
      source: state.source || 'app', // 'autodesk' = Autodesk's daily schedule ran the extraction
      startedAt: state.startedAt,
      finishedAt: new Date(finished).toISOString(),
      minutes: toMin(awake),
      pausedMinutes: paused >= 60_000 ? toMin(paused) : 0, // PC asleep (or the app closed) during the sync
      prepareMinutes: minutesBetween(tl.requestedAt || state.startedAt, tl.preparedAt), // at Autodesk: real time
      downloadMinutes: awakeBetween(tl.downloadStartedAt, tl.downloadedAt),
      buildMinutes: awakeBetween(tl.buildStartedAt, new Date(finished).toISOString()),
      sizeBytes: tl.downloadBytes ?? null,
      jobId: state.jobId,
      requestId: state.requestId,
      asOf: result?.as_of,
      rows: result?.rows,
      tables: result?.tables,
      viewsFailed: result?.views_failed,
      warnings: result?.warnings,
      anomalies: result?.value_anomalies,
      sizeMb: result?.size_mb,
      changes: result?.changes ?? null, // compared with the extraction this one replaced
    };
    this.store.addHistory(entry);
    this.store.setSyncState(null);
    this.removeDownload(state);
    this.setStatus({ phase: 'done', message: `Data as of ${result?.as_of}, ${Number(result?.rows || 0).toLocaleString()} rows.`, progress: 1, timeline: { ...tl, doneAt: entry.finishedAt }, lastResult: entry, download: null, build: null });
    this.log.info(`Sync complete: as_of ${result?.as_of}, ${result?.rows} rows, ${entry.minutes} min (Autodesk ${entry.prepareMinutes} min${entry.pausedMinutes ? `; paused ${entry.pausedMinutes} min while the PC slept` : ''})`);
    const headline = changeHeadline(entry.changes);
    this.notify('Forma data updated', `Data as of ${result?.as_of}. Took ${fmtDuration(entry.minutes)}.${headline ? ` ${headline}` : ''}`, { trigger: state.trigger });
    this.cleanupRequests(state.requestId).catch((e) => this.log.warn(`Request cleanup: ${e.message}`));
    return entry;
  }

  async build(state, { force, signal }) {
    const s = this.store.settings();
    this.setStatus({ phase: 'building', message: 'Starting the build…', progress: 0, download: null });
    try {
      return await this.engine.build({
        ...state.input,
        dataDir: s.dataDir,
        keep: s.keepVersions,
        force,
        onEvent: (e) => {
          if (signal?.aborted) return;
          if (e.event === 'table') this.setStatus({ message: `Loading table ${e.index} of ${e.total}: ${e.table}`, progress: (e.index / e.total) * 0.8, build: { index: e.index, total: e.total } });
          if (e.event === 'phase') {
            const label = { indexes: 'Creating indexes', views: 'Building views', search: 'Building the search index', summaries: 'Computing summaries', changes: 'Comparing with the previous extract', finalize: 'Checking the database' }[e.name] || e.name;
            this.setStatus({ message: `${label}…`, progress: { indexes: 0.82, views: 0.86, search: 0.9, summaries: 0.93, changes: 0.96, finalize: 0.98 }[e.name] ?? null });
          }
        },
      });
    } catch (e) {
      if (e.rejected) {
        // Keep the download so the user can choose to use it anyway.
        state.phase = 'rejected';
        state.message = e.message;
        this.save(state);
        const err = new Error(e.message);
        err.rejected = true;
        throw err;
      }
      throw e;
    }
  }

  /** User reviewed a rejected build ("much smaller than current") and wants it anyway. */
  useRejectedAnyway() {
    const state = this.store.syncState();
    if (!state || state.phase !== 'rejected' || this.running) return Promise.reject(new Error('Nothing to apply.'));
    state.phase = 'building';
    state.force = true;
    this.save(state);
    return this.launch(state);
  }

  discardRejected() {
    const state = this.store.syncState();
    if (state?.phase === 'rejected') {
      this.removeDownload(state);
      this.store.setSyncState(null);
      this.setStatus({ phase: 'idle', message: null });
    }
  }

  fail(state, e) {
    const cancelled = e instanceof SyncCancelled || this.abort?.signal.aborted;
    const entry = {
      status: cancelled ? 'cancelled' : e.rejected ? 'rejected' : 'failed',
      trigger: state.trigger,
      startedAt: state.startedAt,
      finishedAt: new Date(this.now()).toISOString(),
      jobId: state.jobId,
      requestId: state.requestId,
      error: e.message,
    };
    this.store.addHistory(entry);
    if (!e.rejected) {
      this.store.setSyncState(null);
      this.removeDownload(state);
    }
    this.setStatus({ phase: entry.status, message: e.message, error: cancelled ? null : e.message, progress: null });
    (cancelled ? this.log.info : this.log.error)(`Sync ${entry.status}: ${e.message}`);
    if (!cancelled) this.notify('Forma data sync failed', e.message.slice(0, 180), { trigger: state.trigger });
    return entry;
  }

  removeDownload(state) {
    if (this.store.settings().keepDownloads || !state?.input) return;
    try {
      if (state.input.zipPath) fs.rmSync(state.input.zipPath, { force: true });
      if (state.input.csvDir) fs.rmSync(state.input.csvDir, { recursive: true, force: true });
    } catch (e) {
      this.log.warn(`Could not remove download: ${e.message}`);
    }
  }

  /** Delete the Data Connector requests this app created, except the latest. Never touches anyone else's. */
  async cleanupRequests(keepId) {
    const s = this.store.settings();
    const remaining = [];
    for (const r of s.ownedRequests || []) {
      if (r.id === keepId) {
        remaining.push(r);
        continue;
      }
      if (r.deleted) {
        if (this.now() - Date.parse(r.createdAt) < DAY) remaining.push(r); // keep for the 24h job count
        continue;
      }
      try {
        await this.dc.deleteRequest(r.accountId || s.hub.accountId, r.id);
        if (this.now() - Date.parse(r.createdAt) < DAY) remaining.push({ ...r, deleted: true });
      } catch (e) {
        if (e.status === 404) continue;
        remaining.push(r);
        this.log.warn(`Could not delete request ${r.id}: ${e.message}`);
      }
    }
    this.store.updateSettings({ ownedRequests: remaining });
  }
}

function fmtDuration(min) {
  if (min == null) return 'a few minutes';
  if (min < 1) return 'under a minute';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fmtMb(b) {
  return `${(b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1)} MB`;
}

module.exports = { SyncManager, SyncCancelled, JOB_LIMIT };

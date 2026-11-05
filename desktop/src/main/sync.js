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

const DAY = 24 * 60 * 60_000;
const JOB_LIMIT = 24; // Data Connector: per hub and per user, rolling 24h
const JOB_WARN = 20;
const WAIT_FOR_JOB_MS = 45 * 60_000; // job should appear quickly after the request
const WAIT_FOR_RESULT_MS = 10 * 60 * 60_000; // large hubs can take hours

class SyncCancelled extends Error {}

class SyncManager extends EventEmitter {
  constructor({ store, auth, dc, engine, log, notify = () => {}, sleep, now = () => Date.now() }) {
    super();
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

  /** Jobs this app started in the last 24h (UI-started jobs at Autodesk also count, but we can't see those). */
  jobsLast24h() {
    const since = this.now() - DAY;
    return (this.store.settings().ownedRequests || []).filter((r) => Date.parse(r.createdAt) > since).length;
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
    this.abort = new AbortController();
    this.running = this.pipeline(state, this.abort.signal)
      .catch((e) => this.fail(state, e))
      .finally(() => {
        this.running = null;
        this.abort = null;
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

  async pipeline(state, signal) {
    const s = this.store.settings();
    const t0 = Date.parse(state.startedAt) || this.now();
    this.setStatus({ phase: state.phase, trigger: state.trigger, startedAt: state.startedAt, message: 'Starting…', progress: null, error: null });

    // 1. Request
    if (!state.requestId) {
      this.setStatus({ phase: 'requesting', message: 'Asking Data Connector for a fresh extract…' });
      const desc = `Forma Data Manager ${state.trigger} ${new Date(t0).toISOString().slice(0, 16).replace('T', ' ')}Z`;
      const req = await this.dc.createOneTimeRequest(state.accountId, desc);
      if (!req?.id) throw new Error('Data Connector did not return a request id.');
      state.requestId = req.id;
      state.phase = 'waiting';
      this.save(state);
      const owned = [...(this.store.settings().ownedRequests || []), { id: req.id, accountId: state.accountId, createdAt: new Date(this.now()).toISOString() }];
      this.store.updateSettings({ ownedRequests: owned.slice(-200) });
      this.log.info(`Created Data Connector request ${req.id}`);
      const used = this.jobsLast24h();
      if (used >= JOB_WARN) this.setStatus({ warning: `${used} of ${JOB_LIMIT} Data Connector jobs used in the last 24 hours.` });
    }

    // 2. Wait for the job
    if (state.phase === 'waiting') {
      const waitStart = this.now();
      let polls = 0;
      for (;;) {
        if (signal.aborted) throw new SyncCancelled('Sync cancelled.');
        if (!state.jobId) {
          const jobs = await this.dc.requestJobs(state.accountId, state.requestId);
          const job = jobs.sort((a, b) => String(b.createdAt || b.startedAt || '').localeCompare(String(a.createdAt || a.startedAt || '')))[0];
          if (job?.id) {
            state.jobId = job.id;
            this.save(state);
            this.log.info(`Job ${job.id} created (status ${job.status})`);
          } else if (this.now() - waitStart > WAIT_FOR_JOB_MS) {
            throw new Error('Data Connector accepted the request but no job started within 45 minutes. Check Data Connector in Forma, then try again.');
          }
        }
        if (state.jobId) {
          const job = await this.dc.getJob(state.accountId, state.jobId);
          const outcome = jobOutcome(job);
          const elapsedMin = Math.round((this.now() - (Date.parse(state.startedAt) || waitStart)) / 60_000);
          this.setStatus({ phase: 'waiting', message: `Autodesk is preparing the extract (job ${String(job?.status || 'queued').toLowerCase()}, ${elapsedMin} min so far)…`, job: { id: state.jobId, status: job?.status, completionStatus: job?.completionStatus } });
          if (outcome === 'success') break;
          if (outcome === 'failed') throw new Error(`The Data Connector job ended with status "${job?.status}"${job?.completionStatus ? ` / "${job.completionStatus}"` : ''}. Check Data Connector in Forma for details.`);
          if (this.now() - waitStart > WAIT_FOR_RESULT_MS) throw new Error('The Data Connector job is still running after 10 hours. It may finish later; run Sync now again to pick it up.');
        }
        polls++;
        await this.sleep(polls < 10 ? 20_000 : 60_000, signal);
      }
      state.phase = 'downloading';
      this.save(state);
    }

    // 3. Download
    const downloads = path.join(s.dataDir, 'downloads');
    if (state.phase === 'downloading') {
      this.setStatus({ phase: 'downloading', message: 'Listing extract files…', progress: null });
      const listing = await this.dc.dataListing(state.accountId, state.jobId);
      const zip = listing.find((f) => f.name === 'autodesk_data_extract.zip') || listing.find((f) => /\.zip$/i.test(f.name));
      if (zip) {
        const dest = path.join(downloads, `${state.jobId}.zip`);
        await this.dc.download(state.accountId, state.jobId, zip.name, dest, {
          expectedSize: Number(zip.size) || undefined,
          signal,
          onProgress: ({ done, total }) => this.setStatus({ message: `Downloading extract… ${fmtMb(done)}${total ? ` of ${fmtMb(total)}` : ''}`, progress: total ? done / total : null }),
        });
        state.input = { zipPath: dest };
      } else {
        // No bundled ZIP in the listing: fetch the CSVs and schema files individually.
        const files = listing.filter((f) => /\.csv$/i.test(f.name) || /^schemas\/.*\.json$/i.test(f.name));
        if (!files.length) throw new Error('The finished job has no data files.');
        const dir = path.join(downloads, state.jobId);
        let i = 0;
        for (const f of files) {
          i++;
          this.setStatus({ message: `Downloading ${f.name} (${i}/${files.length})…`, progress: i / files.length });
          await this.dc.download(state.accountId, state.jobId, f.name, path.join(dir, ...f.name.split('/')), { expectedSize: Number(f.size) || undefined, signal });
        }
        state.input = { csvDir: dir };
      }
      state.phase = 'building';
      this.save(state);
    }

    // 4. Build
    let result;
    if (state.phase === 'building') {
      result = await this.build(state, { force: !!state.force, signal });
    }

    // 5. Done
    const finished = this.now();
    const entry = {
      status: 'success',
      trigger: state.trigger,
      startedAt: state.startedAt,
      finishedAt: new Date(finished).toISOString(),
      minutes: Math.round((finished - t0) / 6000) / 10,
      jobId: state.jobId,
      requestId: state.requestId,
      asOf: result?.as_of,
      rows: result?.rows,
      tables: result?.tables,
      viewsFailed: result?.views_failed,
      warnings: result?.warnings,
      anomalies: result?.value_anomalies,
      sizeMb: result?.size_mb,
    };
    this.store.addHistory(entry);
    this.store.setSyncState(null);
    this.removeDownload(state);
    this.setStatus({ phase: 'done', message: `Done. Data as of ${result?.as_of}, ${Number(result?.rows || 0).toLocaleString()} rows.`, progress: 1, lastResult: entry });
    this.log.info(`Sync complete: as_of ${result?.as_of}, ${result?.rows} rows, ${entry.minutes} min`);
    if (state.trigger === 'scheduled') this.notify('Forma data updated', `Data as of ${result?.as_of}.`);
    this.cleanupRequests(state.requestId).catch((e) => this.log.warn(`Request cleanup: ${e.message}`));
    return entry;
  }

  async build(state, { force, signal }) {
    const s = this.store.settings();
    this.setStatus({ phase: 'building', message: 'Building the database…', progress: 0 });
    try {
      return await this.engine.build({
        ...state.input,
        dataDir: s.dataDir,
        keep: s.keepVersions,
        force,
        onEvent: (e) => {
          if (signal?.aborted) return;
          if (e.event === 'table') this.setStatus({ message: `Loading tables (${e.index}/${e.total}): ${e.table}`, progress: (e.index / e.total) * 0.8 });
          if (e.event === 'phase') this.setStatus({ message: `Building ${e.name}…`, progress: { indexes: 0.82, views: 0.86, search: 0.9, summaries: 0.94, finalize: 0.98 }[e.name] ?? null });
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
    if (!cancelled && state.trigger === 'scheduled') this.notify('Forma data sync failed', e.message.slice(0, 180));
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

function fmtMb(b) {
  return `${(b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1)} MB`;
}

module.exports = { SyncManager, SyncCancelled, JOB_LIMIT };

'use strict';
/**
 * Data Connector API (APS), v1:
 *   POST   /data-connector/v1/accounts/:accountId/requests                 create a request (one-time or daily)
 *   GET    /data-connector/v1/accounts/:accountId/requests/:id             one request (isActive, effectiveTo, nextExecAt, lastQueuedAt)
 *   PATCH  /data-connector/v1/accounts/:accountId/requests/:id             turn back on / extend a daily request
 *   GET    /data-connector/v1/accounts/:accountId/requests/:id/jobs        jobs of a request (newest first)
 *   GET    /data-connector/v1/accounts/:accountId/jobs/:jobId              one job
 *   GET    /data-connector/v1/accounts/:accountId/jobs/:jobId/data-listing files produced by a job
 *   GET    /data-connector/v1/accounts/:accountId/jobs/:jobId/data/:name   -> { signedUrl }
 *   DELETE /data-connector/v1/accounts/:accountId/requests/:id
 * A finished job has status "complete"; completionStatus "success" means data is ready.
 * The listing contains autodesk_data_extract.zip (everything), each CSV, and README.html.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isNetworkError } = require('./power');

const base = (accountId) => `/data-connector/v1/accounts/${encodeURIComponent(accountId)}`;

/**
 * Data Connector rejects some characters in descriptions with "400 Invalid characters"
 * (parentheses, for one). Keep letters, digits, spaces and - _ . : only.
 */
function safeDescription(text) {
  return String(text || '').replace(/[^A-Za-z0-9 _.:-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Forma Data Manager';
}

class DataConnector {
  constructor({ aps, fetch, log, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.aps = aps;
    this.fetch = fetch; // used for signed-URL downloads (no auth header)
    this.log = log;
    this.wait = wait;
  }

  /** One-time extraction of every service group, starting now. */
  createOneTimeRequest(accountId, description) {
    return this.aps.post(`${base(accountId)}/requests`, {
      description: safeDescription(description),
      isActive: true,
      scheduleInterval: 'ONE_TIME',
      // A moment in the past so the job starts right away.
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      serviceGroups: ['all'],
    });
  }

  /**
   * Daily extraction that Autodesk runs on its own servers at the UTC time of effectiveFrom,
   * until effectiveTo. Emails off: the app tells the user itself.
   */
  createDailyRequest(accountId, { description, effectiveFrom, effectiveTo }) {
    return this.aps.post(`${base(accountId)}/requests`, {
      description: safeDescription(description),
      isActive: true,
      scheduleInterval: 'DAY',
      reoccuringInterval: 1,
      effectiveFrom,
      effectiveTo,
      serviceGroups: ['all'],
      sendEmail: false,
    });
  }

  getRequest(accountId, requestId) {
    return this.aps.get(`${base(accountId)}/requests/${encodeURIComponent(requestId)}`);
  }

  updateRequest(accountId, requestId, patch) {
    return this.aps.patch(`${base(accountId)}/requests/${encodeURIComponent(requestId)}`, patch);
  }

  /** Newest first. A daily request collects many jobs; the API's default order is oldest first. */
  async requestJobs(accountId, requestId, { limit = 10 } = {}) {
    const res = await this.aps.get(`${base(accountId)}/requests/${encodeURIComponent(requestId)}/jobs?sort=desc&limit=${limit}&offset=0`);
    const jobs = res?.results ?? (Array.isArray(res) ? res : []);
    const at = (j) => String(j.createdAt || j.startedAt || '');
    return jobs.sort((a, b) => at(b).localeCompare(at(a)));
  }

  getJob(accountId, jobId) {
    return this.aps.get(`${base(accountId)}/jobs/${encodeURIComponent(jobId)}`);
  }

  async dataListing(accountId, jobId) {
    const res = await this.aps.get(`${base(accountId)}/jobs/${encodeURIComponent(jobId)}/data-listing`);
    return Array.isArray(res) ? res : res?.results ?? [];
  }

  async signedUrl(accountId, jobId, name) {
    const res = await this.aps.get(`${base(accountId)}/jobs/${encodeURIComponent(jobId)}/data/${encodeURIComponent(name)}`);
    if (!res?.signedUrl) throw new Error(`No download link returned for ${name}.`);
    return res.signedUrl;
  }

  deleteRequest(accountId, requestId) {
    return this.aps.del(`${base(accountId)}/requests/${encodeURIComponent(requestId)}`);
  }

  /**
   * Download one file from a job to dest, with progress and retries
   * (signed URLs expire, so each retry asks for a fresh one).
   */
  async download(accountId, jobId, name, dest, { expectedSize, onProgress, signal } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    // Each attempt gets a fresh signed URL. A dropped connection (the PC went to sleep mid-download)
    // gets more and longer waits than a bad response, so the network has time to come back.
    const NETWORK_WAITS_S = [5, 15, 30, 60, 120];
    for (let attempt = 1; ; attempt++) {
      try {
        const url = await this.signedUrl(accountId, jobId, name);
        const res = await this.fetch(url, { signal });
        if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || expectedSize || 0;
        let done = 0;
        let lastEmit = 0;
        const counter = new TransformCounter((n) => {
          done += n;
          const now = Date.now();
          if (onProgress && (now - lastEmit > 250 || done === total)) {
            lastEmit = now;
            onProgress({ done, total });
          }
        });
        await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
        const size = fs.statSync(tmp).size;
        if (total && size !== total) throw new Error(`Incomplete download: got ${size} of ${total} bytes`);
        fs.renameSync(tmp, dest);
        onProgress?.({ done: size, total: size });
        return { path: dest, size };
      } catch (e) {
        if (signal?.aborted) throw e;
        const offline = isNetworkError(e);
        const max = offline ? NETWORK_WAITS_S.length + 1 : 4;
        this.log?.warn(`Download attempt ${attempt} of ${max} for ${name} failed: ${e.message}`);
        try {
          fs.unlinkSync(tmp);
        } catch {}
        if (attempt >= max) throw e;
        await this.wait(offline ? NETWORK_WAITS_S[attempt - 1] * 1000 : 2000 * attempt);
      }
    }
  }
}

const { Transform } = require('node:stream');
class TransformCounter extends Transform {
  constructor(onBytes) {
    super();
    this.onBytes = onBytes;
  }
  _transform(chunk, _enc, cb) {
    this.onBytes(chunk.length);
    cb(null, chunk);
  }
}

/** Interpret a job object across the field variants the API has used. */
function jobOutcome(job) {
  const status = String(job?.status ?? '').toLowerCase();
  const completion = String(job?.completionStatus ?? job?.completion_status ?? '').toLowerCase();
  if (status === 'complete' || status === 'completed') {
    return completion === 'success' || completion === '' ? 'success' : 'failed';
  }
  if (['failed', 'cancelled', 'canceled', 'error', 'expired'].includes(status)) return 'failed';
  return 'running';
}

module.exports = { DataConnector, jobOutcome, safeDescription };

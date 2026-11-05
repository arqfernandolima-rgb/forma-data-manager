'use strict';
/**
 * Data Connector API (APS), v1:
 *   POST   /data-connector/v1/accounts/:accountId/requests                 create a request
 *   GET    /data-connector/v1/accounts/:accountId/requests/:id/jobs        jobs of a request
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

const base = (accountId) => `/data-connector/v1/accounts/${encodeURIComponent(accountId)}`;

class DataConnector {
  constructor({ aps, fetch, log }) {
    this.aps = aps;
    this.fetch = fetch; // used for signed-URL downloads (no auth header)
    this.log = log;
  }

  /** One-time extraction of every service group, starting now. */
  createOneTimeRequest(accountId, description) {
    return this.aps.post(`${base(accountId)}/requests`, {
      description,
      isActive: true,
      scheduleInterval: 'ONE_TIME',
      // A moment in the past so the job starts right away.
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      serviceGroups: ['all'],
    });
  }

  async requestJobs(accountId, requestId) {
    const res = await this.aps.get(`${base(accountId)}/requests/${encodeURIComponent(requestId)}/jobs`);
    return res?.results ?? (Array.isArray(res) ? res : []);
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
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
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
        lastErr = e;
        if (signal?.aborted) throw e;
        this.log?.warn(`Download attempt ${attempt} for ${name} failed: ${e.message}`);
        try {
          fs.unlinkSync(tmp);
        } catch {}
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw lastErr;
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

module.exports = { DataConnector, jobOutcome };

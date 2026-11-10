'use strict';
/**
 * Daily schedule, run by the app itself (it starts at Windows login and lives in the tray).
 *  - Checks every minute, and right after start-up or waking from sleep.
 *  - If the scheduled time today has passed and today's run hasn't happened, it runs now (catch-up).
 *  - Always runs, even if you clicked Sync now earlier: scheduled and manual syncs are independent.
 *  - "Autodesk's cloud" mode (default): Autodesk runs the extraction itself at that time (cloud-schedule.js),
 *    so after the time passes the app collects today's job, even hours later when the PC wakes up.
 *    If Autodesk's job failed or hasn't shown up 45 minutes after the time, the app starts one itself.
 *  - Waits while Windows reports no connection (right after waking up), and a failed scheduled sync
 *    is tried again the same day: 10, 30 and 60 minutes after each failure.
 *  - Keeps the Autodesk sign-in alive even when the schedule is off (refresh tokens expire after ~15 idle days).
 */
const { jobOutcome } = require('./dataconnector');
const { isNetworkError } = require('./power');

const KEEPALIVE_MS = 7 * 24 * 60 * 60_000;
const AUTODESK_GRACE_MS = 45 * 60_000; // Autodesk's daily job should have started by then
const AUTODESK_POLL_MS = 4 * 60_000; // while waiting for it, ask Autodesk at most this often
const RECHECK_SCHEDULE_MS = 12 * 60 * 60_000; // health check of the Autodesk-side schedule
const RETRY_SCHEDULE_MS = 60 * 60_000; // after an error setting it up
const RETRY_AFTER_MIN = [10, 30, 60]; // today's scheduled sync failed: try again this many minutes later

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return { h: 6, m: 0 };
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

function scheduledAt(dateObj, time) {
  const { h, m } = parseTime(time);
  const d = new Date(dateObj);
  d.setHours(h, m, 0, 0);
  return d;
}

class Scheduler {
  constructor({ store, sync, auth, log, cloud = null, dc = null, now = () => new Date(), isOnline = () => true }) {
    this.store = store;
    this.sync = sync;
    this.auth = auth;
    this.log = log;
    this.cloud = cloud; // CloudSchedule, or null to always extract from this computer
    this.dc = dc;
    this.now = now;
    this.isOnline = isOnline;
    this.timer = null;
    this.autodeskCheck = null; // in-flight look at Autodesk's jobs
    this.lastAutodeskPoll = 0;
    this.checkedScheduleSinceStart = false; // first check after start-up (or an upgrade) always runs
  }

  start() {
    this.timer = setInterval(() => this.check(), 60_000);
    setTimeout(() => this.check(), 15_000); // let the window and a resumed sync settle first
  }

  stop() {
    clearInterval(this.timer);
  }

  nextRun() {
    const s = this.store.settings();
    if (!s.schedule?.enabled || !s.wizardComplete) return null;
    const now = this.now();
    const today = scheduledAt(now, s.schedule.time);
    if (s.lastScheduledRunDate !== localDate(now)) return now >= today ? now : today;
    const retry = this.retryAt(localDate(now));
    if (retry) return retry.at > now ? retry.at : now;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }

  /** Returns a short reason string (useful for tests and the log). */
  check() {
    const s = this.store.settings();
    const online = this.isOnline();
    if (online) {
      this.keepSignInAlive();
      this.checkAutodeskSchedule(s);
    }
    if (!s.wizardComplete) return 'setup-incomplete';
    if (!s.schedule?.enabled) return 'disabled';
    if (this.sync.busy) return 'busy';
    const now = this.now();
    const today = localDate(now);
    let retry = null;
    if (s.lastScheduledRunDate === today) {
      retry = this.retryAt(today);
      if (!retry) return 'already-ran';
      if (now < retry.at) return 'retry-later';
    }
    const due = scheduledAt(now, s.schedule.time);
    if (now < due) return 'not-yet';
    if (!this.auth.signedIn) return 'signed-out';
    if (!online) return 'offline'; // just woke up, or no Wi-Fi: try again next minute
    if (retry) {
      this.log.info(`Trying today's scheduled sync again (attempt ${retry.attempt} of ${RETRY_AFTER_MIN.length + 1})`);
      this.store.updateSettings({ lastScheduledRunDate: null });
    }
    const cs = s.cloudSchedule;
    if (this.cloud && this.dc && s.extractionMode !== 'local' && cs?.requestId) return this.checkAutodesk(s, cs, due, today);
    return this.startHere(s, due, today);
  }

  /** Start a one-time extraction from this computer. */
  startHere(s, due, today) {
    this.store.updateSettings({ lastScheduledRunDate: today });
    // More than a few minutes late usually means the PC was asleep or off at the set time.
    const late = this.now() - due > 5 * 60_000;
    this.log.info(late ? `Starting scheduled sync (catching up: it was due at ${s.schedule.time})` : 'Starting scheduled sync');
    this.sync.start('scheduled').then(
      (entry) => this.afterRun(today, entry),
      (e) => this.log.error(`Scheduled sync could not start: ${e.message}`)
    );
    return 'started';
  }

  /** When to try today's scheduled sync again after it failed, or null (it worked, or 3 retries used). */
  retryAt(today) {
    const runs = this.store.history().filter((h) => h.trigger === 'scheduled' && h.startedAt && localDate(new Date(h.startedAt)) === today);
    if (!runs.length || runs[0].status !== 'failed') return null; // newest first
    const failures = runs.filter((h) => h.status === 'failed').length;
    if (failures > RETRY_AFTER_MIN.length) return null;
    const failedAt = Date.parse(runs[0].finishedAt || runs[0].startedAt);
    return { at: new Date(failedAt + RETRY_AFTER_MIN[failures - 1] * 60_000), attempt: failures + 1 };
  }

  /** Pending retry of today's failed scheduled sync, for the Status page (null when none). */
  pendingRetry() {
    if (this.sync.busy) return null;
    const today = localDate(this.now());
    if (this.store.settings().lastScheduledRunDate !== today) return null;
    return this.retryAt(today)?.at ?? null;
  }

  afterRun(today, entry) {
    if (entry?.status !== 'failed') return;
    const retry = this.retryAt(today);
    const hhmm = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (retry) this.log.info(`Scheduled sync failed; will try again at ${hhmm(retry.at)}.`);
    else this.log.warn('Scheduled sync failed again; no more retries today. The next one runs at the usual time tomorrow, or click Sync now.');
  }

  /** Look for today's run of Autodesk's daily extraction (async; one look at a time, every few minutes). */
  checkAutodesk(s, cs, due, today) {
    if (this.autodeskCheck) return 'checking-autodesk';
    if (this.now() - this.lastAutodeskPoll < AUTODESK_POLL_MS) return 'waiting-for-autodesk';
    this.lastAutodeskPoll = this.now().getTime();
    this.autodeskCheck = this.collectFromAutodesk(s, cs, due, today)
      .catch((e) => {
        if (isNetworkError(e)) {
          // Not a problem with Autodesk's run: starting one from here would fail the same way (and
          // waste a job). Look again in a few minutes; Autodesk's extract will still be there.
          this.log.warn(`Couldn't reach Autodesk to look for today's extraction (${e.message}); will look again in a few minutes.`);
          return 'offline';
        }
        this.log.warn(`Could not check Autodesk's daily extraction: ${e.message}`);
        if (e.status === 404) this.cloud.ensure('request not found');
        // Can't see Autodesk's run: don't leave the user without data.
        if (this.now() - due > AUTODESK_GRACE_MS && this.store.settings().lastScheduledRunDate !== today) return this.startHere(s, due, today);
        return 'error';
      })
      .finally(() => (this.autodeskCheck = null));
    return 'checking-autodesk';
  }

  async collectFromAutodesk(s, cs, due, today) {
    const jobs = await this.dc.requestJobs(cs.accountId, cs.requestId);
    // Today's run: created around or after today's time (Autodesk may queue it a little early).
    const since = due.getTime() - 60 * 60_000;
    const job = jobs.find((j) => (Date.parse(j.createdAt || j.startedAt || '') || 0) >= since);
    if (this.sync.busy || this.store.settings().lastScheduledRunDate === today) return 'already-ran';
    if (job) {
      this.cloud.noteRan();
      if (jobOutcome(job) === 'failed') {
        this.log.warn(`Autodesk's daily extraction failed today (status "${job.status}"); starting one from this computer.`);
        return this.startHere(s, due, today);
      }
      this.store.updateSettings({ lastScheduledRunDate: today });
      if (this.store.history().some((h) => h.status === 'success' && h.jobId === job.id)) return 'already-have-it';
      this.log.info(`Collecting Autodesk's daily extraction (job ${job.id}, status ${job.status})`);
      this.sync.collect(job, cs.requestId, 'scheduled').then(
        (entry) => this.afterRun(today, entry),
        (e) => this.log.error(`Could not collect Autodesk's extraction: ${e.message}`)
      );
      return 'collecting';
    }
    if (this.now() - due < AUTODESK_GRACE_MS) return 'waiting-for-autodesk';
    // Only a miss if the schedule already existed at today's time (a new one starts tomorrow).
    if (Date.parse(cs.createdAt || '') < due.getTime()) this.cloud.noteMissed(today);
    this.log.warn(`Autodesk's daily extraction for ${s.schedule.time} hasn't shown up; starting one from this computer.`);
    return this.startHere(s, due, today);
  }

  /** Keep the Autodesk-side schedule in step with the settings (create, repair, remove). */
  checkAutodeskSchedule(s) {
    if (!this.cloud || this.sync.busy) return;
    const cs = s.cloudSchedule;
    const since = cs?.checkedAt ? this.now() - Date.parse(cs.checkedAt) : Infinity;
    const wanted = this.cloud.wanted();
    const recheck = Date.parse(cs?.recheckAfter || '');
    if (Number.isFinite(recheck)) {
      // The last look couldn't reach Autodesk: try again at that time (not 12 hours later).
      if (this.now() < recheck) return;
      this.checkedScheduleSinceStart = true;
      this.cloud.ensure('re-check after a lost connection');
      return;
    }
    // Remove one that's no longer wanted (retry every few minutes if offline), re-check a healthy one
    // twice a day, and retry setting one up hourly after an error.
    const due =
      (!this.checkedScheduleSinceStart && (wanted || cs?.requestId)) ||
      (cs?.requestId && !wanted && since > 5 * 60_000) ||
      (cs?.requestId && wanted && since > RECHECK_SCHEDULE_MS) ||
      (!cs?.requestId && wanted && since > RETRY_SCHEDULE_MS);
    if (due) {
      this.checkedScheduleSinceStart = true;
      this.cloud.ensure('scheduled check');
    }
  }

  keepSignInAlive() {
    const t = this.auth.tokens;
    if (!t?.refresh_token || this.sync.busy) return;
    if (Date.now() - (t.obtained_at || 0) > KEEPALIVE_MS) {
      this.auth.refresh().then(
        () => this.log.info('Refreshed Autodesk sign-in (keep-alive)'),
        (e) => this.log.warn(`Sign-in keep-alive failed: ${e.message}`)
      );
    }
  }
}

module.exports = { Scheduler, localDate, scheduledAt, parseTime };

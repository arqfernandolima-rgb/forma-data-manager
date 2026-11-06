'use strict';
/**
 * Daily schedule, run by the app itself (it starts at Windows login and lives in the tray).
 *  - Checks every minute, and right after start-up or waking from sleep.
 *  - If the scheduled time today has passed and today's run hasn't happened, it runs now (catch-up).
 *  - Always runs, even if you clicked Sync now earlier: scheduled and manual syncs are independent.
 *  - Keeps the Autodesk sign-in alive even when the schedule is off (refresh tokens expire after ~15 idle days).
 */
const KEEPALIVE_MS = 7 * 24 * 60 * 60_000;

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
  constructor({ store, sync, auth, log, now = () => new Date() }) {
    this.store = store;
    this.sync = sync;
    this.auth = auth;
    this.log = log;
    this.now = now;
    this.timer = null;
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
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }

  /** Returns a short reason string (useful for tests and the log). */
  check() {
    const s = this.store.settings();
    this.keepSignInAlive();
    if (!s.wizardComplete) return 'setup-incomplete';
    if (!s.schedule?.enabled) return 'disabled';
    if (this.sync.busy) return 'busy';
    const now = this.now();
    const today = localDate(now);
    if (s.lastScheduledRunDate === today) return 'already-ran';
    const due = scheduledAt(now, s.schedule.time);
    if (now < due) return 'not-yet';
    if (!this.auth.signedIn) return 'signed-out';
    this.store.updateSettings({ lastScheduledRunDate: today });
    // More than a few minutes late usually means the PC was asleep or off at the set time.
    const late = now - due > 5 * 60_000;
    this.log.info(late ? `Starting scheduled sync (catching up: it was due at ${s.schedule.time})` : 'Starting scheduled sync');
    this.sync.start('scheduled').catch((e) => this.log.error(`Scheduled sync could not start: ${e.message}`));
    return 'started';
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

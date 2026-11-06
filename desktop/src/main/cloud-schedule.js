'use strict';
/**
 * The daily extraction Autodesk runs on its own servers ("Autodesk's cloud" mode, the default).
 *
 * The app creates ONE recurring Data Connector request (scheduleInterval DAY) at the user's
 * schedule time, so the extract is prepared even when this PC is asleep or off. The scheduler then
 * collects the newest job (scheduler.js), and starts a one-time extraction itself if Autodesk's
 * didn't run. This module only keeps that request healthy:
 *
 *  - Autodesk pauses a daily schedule whose data isn't downloaded for 14 days, and stops it at its
 *    end date. The app downloads every day, turns a paused request back on (and starts over if
 *    that doesn't help), and moves the end date out a year when it's less than 30 days away.
 *  - The request fires at a fixed UTC time, so a new time in Settings, or a daylight-saving
 *    switch, means a new request at the right local time.
 *  - Switching to "This computer", turning the schedule off, or changing hub removes it.
 *  - The request is the user's own (3-legged), named so it's recognizable, with emails off.
 *
 * Never throws: problems are logged and kept in settings.cloudSchedule.lastError, and the
 * scheduler then simply starts extractions from this computer.
 */
const { scheduledAt } = require('./scheduler');

const DAY = 86_400_000;
const LIFETIME_DAYS = 365;
const FALLBACK_LIFETIME_DAYS = 90; // if Autodesk refuses an end date a year out
const RENEW_WITHIN_DAYS = 30;
const QUIET_TOO_LONG_MS = 36 * 3_600_000; // a daily request should have queued a job by then
const MISSED_DAYS_PAUSED = 2; // Autodesk's run didn't show up this many days in a row
// Plain characters only: Data Connector answers "400 Invalid characters" to parentheses.
const DESCRIPTION = 'Forma Data Manager daily extraction - managed by the app';

const utcClock = (d) => d.toISOString().slice(11, 16);

class CloudSchedule {
  constructor({ store, dc, auth, log, now = () => Date.now() }) {
    this.store = store;
    this.dc = dc;
    this.auth = auth;
    this.log = log;
    this.now = now;
    this.inFlight = null;
    this.onChange = null; // set by main.js to refresh the window and tray
  }

  /** Should an Autodesk-side schedule exist right now? */
  wanted() {
    const s = this.store.settings();
    return s.extractionMode !== 'local' && !!s.schedule?.enabled && !!s.wizardComplete && this.auth.signedIn && !!s.hub?.accountId;
  }

  /** What the UI shows. */
  status() {
    const s = this.store.settings();
    const cs = s.cloudSchedule || {};
    return {
      mode: s.extractionMode === 'local' ? 'local' : 'cloud',
      active: !!cs.requestId,
      requestId: cs.requestId || null,
      nextExecAt: cs.nextExecAt || null,
      effectiveTo: cs.effectiveTo || null,
      lastError: cs.lastError || null,
    };
  }

  /** One check at a time; callers can fire and forget. */
  ensure(reason = 'check') {
    if (!this.inFlight) {
      this.inFlight = this.run(reason).finally(() => {
        this.inFlight = null;
        this.onChange?.();
      });
    }
    return this.inFlight;
  }

  async run(reason) {
    const iso = () => new Date(this.now()).toISOString();
    try {
      const s = this.store.settings();
      if (!this.wanted()) {
        // Removing needs a sign-in; if signed out, keep the record and remove it after sign-in.
        if (s.cloudSchedule?.requestId && this.auth.signedIn) await this.remove('no longer needed');
        return this.status();
      }
      if (s.cloudSchedule?.requestId && s.cloudSchedule.accountId !== s.hub.accountId) await this.remove('hub changed');

      const cur = this.store.settings().cloudSchedule;
      if (!cur?.requestId) return await this.create(reason);

      let req;
      try {
        req = await this.dc.getRequest(cur.accountId, cur.requestId);
      } catch (e) {
        if (e.status !== 404) throw e;
        this.store.updateSettings({ cloudSchedule: null });
        return await this.create('it was deleted at Autodesk');
      }

      // Time of day: the user picked a new one, or daylight saving moved its UTC equivalent.
      const wantUtc = utcClock(scheduledAt(new Date(this.now()), s.schedule.time));
      const haveUtc = req?.effectiveFrom ? utcClock(new Date(req.effectiveFrom)) : null;
      if (cur.time !== s.schedule.time || (haveUtc && haveUtc !== wantUtc)) {
        await this.remove(cur.time !== s.schedule.time ? 'schedule time changed' : 'daylight saving time changed');
        return await this.create(reason);
      }

      // Paused: marked inactive, or it stopped producing jobs. Judged from what we can see:
      // lastQueuedAt when the API returns it, and days the scheduler found no run (noteMissed).
      const lastQueued = Date.parse(req.lastQueuedAt || '');
      const quietAtAutodesk = Number.isFinite(lastQueued) && this.now() - lastQueued > QUIET_TOO_LONG_MS && (Date.parse(req.effectiveFrom || '') || 0) < this.now() - QUIET_TOO_LONG_MS;
      const quiet = quietAtAutodesk || (cur.missedDays || 0) >= MISSED_DAYS_PAUSED;
      if (req.isActive === false || quiet) {
        const triedRecently = cur.reactivatedAt && this.now() - Date.parse(cur.reactivatedAt) < 2 * DAY;
        if (triedRecently) {
          await this.remove('it stayed paused after turning it back on');
          return await this.create(reason);
        }
        await this.dc.updateRequest(cur.accountId, cur.requestId, { isActive: true });
        this.save({ reactivatedAt: iso(), missedDays: 0 });
        this.log.info('Autodesk had paused the daily extraction (data not downloaded for a while, or it ended); turned it back on.');
      }

      // End date coming up: move it out.
      let effectiveTo = req.effectiveTo || cur.effectiveTo || null;
      const end = Date.parse(effectiveTo || '');
      if (end && end - this.now() < RENEW_WITHIN_DAYS * DAY) {
        const next = new Date(this.now() + LIFETIME_DAYS * DAY).toISOString();
        try {
          await this.dc.updateRequest(cur.accountId, cur.requestId, { effectiveTo: next });
          effectiveTo = next;
          this.log.info(`Extended Autodesk's daily extraction to ${next.slice(0, 10)}.`);
        } catch (e) {
          this.log.warn(`Could not extend Autodesk's daily extraction (${e.message}); creating a new one.`);
          await this.remove('could not extend it');
          return await this.create(reason);
        }
      }

      this.save({ checkedAt: iso(), nextExecAt: req.nextExecAt ?? cur.nextExecAt ?? null, effectiveTo, lastError: null });
      return this.status();
    } catch (e) {
      const detail = e.status === 400 && e.detail ? ` ${JSON.stringify(e.detail).slice(0, 400)}` : '';
      this.log.warn(`Autodesk daily extraction (${reason}): ${e.message}${detail}`);
      this.save({ checkedAt: iso(), lastError: e.message });
      return this.status();
    }
  }

  /** Next time the local schedule time comes round (at least a minute from now). */
  nextStart(time) {
    const d = scheduledAt(new Date(this.now()), time);
    if (d.getTime() <= this.now() + 60_000) d.setDate(d.getDate() + 1);
    return d;
  }

  async create(reason) {
    const s = this.store.settings();
    const start = this.nextStart(s.schedule.time);
    const body = { description: DESCRIPTION, effectiveFrom: start.toISOString(), effectiveTo: new Date(start.getTime() + LIFETIME_DAYS * DAY).toISOString() };
    let req;
    try {
      req = await this.dc.createDailyRequest(s.hub.accountId, body);
    } catch (e) {
      if (e.status !== 400) throw e;
      this.log.warn(`Data Connector refused the daily request: ${e.message}${e.detail ? ` ${JSON.stringify(e.detail).slice(0, 400)}` : ''}. Trying a simpler one.`);
      // Simplest description, and an end date closer in (it's extended automatically later).
      body.description = 'Forma Data Manager daily';
      body.effectiveTo = new Date(start.getTime() + FALLBACK_LIFETIME_DAYS * DAY).toISOString();
      req = await this.dc.createDailyRequest(s.hub.accountId, body);
    }
    if (!req?.id) throw new Error('Data Connector did not return a request id.');
    const now = new Date(this.now()).toISOString();
    this.store.updateSettings({
      cloudSchedule: {
        requestId: req.id,
        accountId: s.hub.accountId,
        time: s.schedule.time,
        createdAt: now,
        checkedAt: now,
        nextExecAt: req.nextExecAt || body.effectiveFrom,
        effectiveTo: req.effectiveTo || body.effectiveTo,
        lastError: null,
      },
    });
    this.log.info(`Created Autodesk's daily extraction ${req.id} at ${s.schedule.time} (${reason}).`);
    return this.status();
  }

  /** Delete the request at Autodesk (already gone is fine) and forget it. */
  async remove(why) {
    const cs = this.store.settings().cloudSchedule;
    if (cs?.requestId) {
      try {
        await this.dc.deleteRequest(cs.accountId, cs.requestId);
        this.log.info(`Removed Autodesk's daily extraction ${cs.requestId} (${why}).`);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    this.store.updateSettings({ cloudSchedule: null });
  }

  /** Scheduler: Autodesk's run for today never showed up. */
  noteMissed(day) {
    const cs = this.store.settings().cloudSchedule;
    if (!cs?.requestId || cs.lastMissedDay === day) return;
    this.save({ missedDays: (cs.missedDays || 0) + 1, lastMissedDay: day });
    if ((cs.missedDays || 0) + 1 >= MISSED_DAYS_PAUSED) this.ensure('runs stopped showing up');
  }

  /** Scheduler: found today's run. */
  noteRan() {
    const cs = this.store.settings().cloudSchedule;
    if (cs?.requestId && cs.missedDays) this.save({ missedDays: 0, lastMissedDay: null });
  }

  save(patch) {
    this.store.updateSettings({ cloudSchedule: { ...(this.store.settings().cloudSchedule || {}), ...patch } });
  }
}

module.exports = { CloudSchedule, DESCRIPTION };

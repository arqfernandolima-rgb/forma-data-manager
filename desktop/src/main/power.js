'use strict';
/**
 * Sleep and network helpers.
 *
 * Windows laptops sleep (often Modern Standby) while a sync is under way. Timers don't run while
 * the PC sleeps, so a wall-clock timeout fires the moment it wakes, and the first network calls
 * after waking fail until Wi-Fi/VPN is back (net::ERR_NETWORK_IO_SUSPENDED, ERR_NAME_NOT_RESOLVED).
 */

/**
 * Records the stretches when the PC was asleep (or the app frozen): a ticker runs every few
 * seconds, and a gap between ticks much longer than that means nothing ran in between.
 */
class SleepTracker {
  constructor({ tickMs = 10_000, now = () => Date.now() } = {}) {
    this.tickMs = tickMs;
    this.now = now;
    this.last = now();
    this.gaps = []; // [from, to] in ms
    this.timer = null;
  }

  start() {
    this.last = this.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  tick(t = this.now()) {
    const gap = t - this.last;
    if (gap > this.tickMs * 3) {
      const from = this.last + this.tickMs;
      this.gaps.push([from, t]);
      if (this.gaps.length > 500) this.gaps.shift();
      this.onGap?.(from, t);
    }
    this.last = t;
  }

  /** Milliseconds the PC was asleep between two times (ms since epoch). */
  asleepBetween(a, b) {
    this.tick();
    let ms = 0;
    for (const [from, to] of this.gaps) ms += Math.max(0, Math.min(b, to) - Math.max(a, from));
    return ms;
  }

  /** Milliseconds the PC was awake between two times. */
  awakeBetween(a, b) {
    return Math.max(0, b - a - this.asleepBetween(a, b));
  }
}

/** Wall-clock stand-in when no tracker is wired in (tests, CLI). */
const WALL_CLOCK = { asleepBetween: () => 0, awakeBetween: (a, b) => Math.max(0, b - a) };

const NETWORK_RE = /net::ERR_|fetch failed|failed to fetch|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|terminated|network/i;

/** True for errors that mean "no connection right now" rather than "Autodesk said no". */
function isNetworkError(e) {
  if (!e) return false;
  if (e.code === 'network') return true;
  if (e.status) return false; // an HTTP answer came back
  return NETWORK_RE.test(`${e.message || e} ${e.cause?.code || ''} ${e.cause?.message || ''}`);
}

module.exports = { SleepTracker, WALL_CLOCK, isNetworkError };

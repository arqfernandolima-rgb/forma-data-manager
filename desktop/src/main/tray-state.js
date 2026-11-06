'use strict';
/**
 * What the tray icon shows. A pure function of the app's state, so it can be tested
 * without Electron. Each key has a colored icon: assets/tray-<key>.png (+ @2x).
 *
 * Priority, first match wins:
 *   syncing    blue   #1f5fa8  a sync is running
 *   attention  red    #c92a2a  last sync failed, a new extract is waiting for review, or
 *                              the Autodesk sign-in expired (scheduled syncs can't run)
 *   notready   gray   #6b7280  setup not finished, or no database built yet
 *   stale      amber  #d97706  data older than STALE_AFTER_DAYS (a daily sync was missed)
 *   ready      green  #2e7d32  current data that Claude can use
 *
 * The icons are tray.png with the blue background swapped for these colors
 * (white bars and anti-aliased edges kept).
 */
const DAY = 86_400_000;
const STALE_AFTER_DAYS = 2; // same threshold as the "Current" badge in the window
const TRAY_STATES = ['syncing', 'attention', 'notready', 'stale', 'ready'];

const PHASE_LABEL = {
  requesting: 'requesting the extract',
  waiting: 'Autodesk is preparing the extract',
  downloading: 'downloading',
  building: 'building the database',
};

/** Whole days since as_of ('YYYY-MM-DD'), same math as the window's age badge. */
function ageDays(asOf, now) {
  if (!asOf) return null;
  const t = Date.parse(`${asOf}T00:00:00`);
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY);
}

function fmtAsOf(asOf) {
  const d = new Date(`${asOf}T12:00:00`);
  return Number.isNaN(d.getTime()) ? asOf : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * @param {object} p
 * @param {boolean} p.busy           a sync is running
 * @param {string}  [p.phase]        sync phase while busy
 * @param {boolean} p.wizardComplete
 * @param {boolean} p.signedIn
 * @param {object}  [p.database]     current.json pointer ({ as_of, ... }) or null
 * @param {object}  [p.lastSync]     newest history entry ({ status, error })
 * @param {boolean} [p.pendingReview] a rejected extract is waiting for "Use it anyway / Discard"
 * @param {number}  [p.now]
 * @returns {{ key: string, label: string }}
 */
function trayState({ busy, phase, wizardComplete, signedIn, database, lastSync, pendingReview, now = Date.now() }) {
  if (busy) return { key: 'syncing', label: `Syncing: ${PHASE_LABEL[phase] || 'starting'}` };
  if (pendingReview) return { key: 'attention', label: 'New extract needs your review' };
  if (lastSync?.status === 'failed') return { key: 'attention', label: 'Last sync failed' };
  if (!wizardComplete) return { key: 'notready', label: 'Not ready: finish setup' };
  if (!signedIn) return { key: 'attention', label: 'Sign in to Autodesk again' };
  if (!database?.as_of) return { key: 'notready', label: 'Not ready: no data yet' };
  const age = ageDays(database.as_of, now);
  if (age != null && age > STALE_AFTER_DAYS) return { key: 'stale', label: `Stale: data is ${age} days old` };
  return { key: 'ready', label: `Ready: data as of ${fmtAsOf(database.as_of)}` };
}

module.exports = { trayState, ageDays, TRAY_STATES, STALE_AFTER_DAYS };

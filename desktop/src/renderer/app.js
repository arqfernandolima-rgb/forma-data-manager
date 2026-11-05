'use strict';
/* Forma Data Manager UI. Plain DOM, no framework. All dynamic text goes through textContent. */

const $ = (sel) => document.querySelector(sel);
const main = $('#main');
let S = null; // latest state from the main process
let page = 'status';
let wizardStep = 0;
let hubsCache = null;
let skillDraft = null;
let wizardOverlay = false; // setup re-opened from Settings

// ── tiny DOM helper ─────────────────────────────────────────────────────────
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick }, label);
const link = (label, url) => h('button', { class: 'link', onclick: () => fdm.openUrl(url) }, label);
const badge = (text, kind) => h('span', { class: `badge b-${kind}` }, text);
const banner = (kind, ...kids) => h('div', { class: `banner ${kind}` }, ...kids);
const copybox = (value) => h('div', { class: 'copybox' }, h('span', { class: 'mono', text: value }), btn('Copy', () => fdm.copy(value).then(() => toast('Copied'))));

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2500);
}

async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r.ok) {
    toast(r.error, true);
    throw new Error(r.error);
  }
  return r.value;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
function ageDays(asOf) {
  if (!asOf) return null;
  return Math.floor((Date.now() - Date.parse(`${asOf}T00:00:00`)) / 86_400_000);
}

// ── routing ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach((b) =>
  b.addEventListener('click', () => {
    page = b.dataset.page;
    render();
  })
);

function render() {
  if (!S) return;
  if (wizardOverlay && wizardStep >= STEPS.length - 1) wizardOverlay = false;
  const inWizard = !S.settings.wizardComplete || wizardOverlay;
  $('#sidebar').hidden = inWizard;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#side-hub').textContent = S.settings.hub?.name || 'No hub selected';
  $('#side-user').textContent = S.signedIn ? `Signed in${S.user?.email ? ` as ${S.user.email}` : ''}` : 'Not signed in';
  const scroll = main.scrollTop;
  const closeSetup = wizardOverlay ? h('div', { class: 'row' }, h('span', { class: 'spacer' }), btn('Close setup', () => ((wizardOverlay = false), render()))) : null;
  main.replaceChildren(closeSetup || '', inWizard ? renderWizard() : { status: renderStatus, history: renderHistory, claude: renderClaude, settings: renderSettings, about: renderAbout }[page]());
  main.scrollTop = scroll;
}

// ── shared text ─────────────────────────────────────────────────────────────
const DISCLAIMER = [
  'Forma Data Manager is an independent, community-built test tool. It is not an Autodesk product, and it is not developed, endorsed, supported or warranted by Autodesk, Inc. or by Anthropic.',
  'The software is provided "as is", without warranty of any kind, express or implied, including fitness for a particular purpose. Autodesk, Inc., Anthropic, and the authors have no liability for any claim, damages, data loss, cost, or other liability arising from its use.',
  'It reads your hub’s data through the official Autodesk Data Connector API using your own sign-in and your own APS app, and stores a copy on this computer. You are responsible for handling that data according to your organization’s policies and your agreements with Autodesk. Answers produced by AI models from this data can be wrong; verify anything important in Autodesk Forma.',
  'Autodesk, Autodesk Forma, Autodesk Construction Cloud and BIM 360 are trademarks of Autodesk, Inc. Claude is a trademark of Anthropic, PBC.',
];

function apsSteps() {
  return h(
    'ol',
    { class: 'steps' },
    h('li', {}, 'Open ', link('APS Applications', 'https://aps.autodesk.com/myapps/'), ' and create an application of type ', h('b', {}, 'Desktop, Mobile, Single-Page App'), ' (it uses PKCE, so there is no client secret).'),
    h('li', {}, 'Set the callback URL to:', copybox(S.redirectUri)),
    h('li', {}, 'Under API access, enable the Autodesk Construction Cloud and Data Management APIs.'),
    h('li', {}, 'Copy the app’s ', h('b', {}, 'Client ID'), ' into the box below.'),
    h('li', {}, 'In Forma, a hub admin adds that Client ID under ', h('b', {}, 'Hub Admin → Custom Integrations'), '.'),
    h('li', {}, 'The person signing in must be a hub admin with Executive access. That’s what the Data Connector API requires.')
  );
}

// ── wizard ──────────────────────────────────────────────────────────────────
const STEPS = ['Welcome', 'Autodesk app', 'Sign in', 'Hub', 'Data folder', 'Schedule', 'Claude Desktop', 'Dashboard skill', 'Finish'];

function renderWizard() {
  const side = h('ol', { class: 'wsteps' }, STEPS.map((name, i) => h('li', { class: i < wizardStep ? 'done' : i === wizardStep ? 'current' : '' }, h('span', { class: 'n' }, i < wizardStep ? '✓' : String(i + 1)), name)));
  const body = [wWelcome, wApp, wSignIn, wHub, wFolder, wSchedule, wClaude, wSkill, wFinish][wizardStep]();
  return h('div', { class: 'wizard' }, h('div', {}, h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, h('span'), h('span'), h('span')), h('div', { class: 'brand-name' }, 'Setup')), side), h('div', {}, body));
}

function wNav({ back = true, next, nextLabel = 'Continue', nextDisabled = false, skip }) {
  const nextBtn = btn(nextLabel, next || (() => ((wizardStep += 1), render())), 'primary');
  nextBtn.disabled = nextDisabled;
  return h(
    'div',
    { class: 'wnav' },
    back && wizardStep > 0 && btn('Back', () => ((wizardStep -= 1), render())),
    h('span', { class: 'spacer' }),
    skip && btn('Skip for now', skip),
    nextBtn
  );
}

function wWelcome() {
  let accepted = !!S.settings.disclaimerAcceptedAt;
  const nav = wNav({
    back: false,
    nextDisabled: !accepted,
    next: async () => {
      await call(fdm.acceptDisclaimer);
      wizardStep = 1;
      refresh();
    },
  });
  const nextBtn = nav.querySelector('.primary');
  return h(
    'div',
    {},
    h('h1', {}, 'Forma data for Claude'),
    h('p', { class: 'lead' }, 'This app pulls your hub’s data from Autodesk Data Connector every day, builds a fast local database, and connects it to Claude Desktop so you can ask questions and build dashboards in plain language.'),
    h('div', { class: 'card' }, h('h2', {}, 'Please read first'), h('div', { class: 'disclaimer-box' }, DISCLAIMER.map((p) => h('p', {}, p)))),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: accepted, onchange: (e) => ((accepted = e.target.checked), (nextBtn.disabled = !accepted)) }),
      h('span', {}, 'I understand this is unofficial test code, provided as is, with no warranty and no liability for Autodesk, Anthropic or the authors.')
    ),
    nav
  );
}

function wApp() {
  const input = h('input', { type: 'text', value: S.settings.clientId, placeholder: 'e.g. AbCdEf123…', spellcheck: 'false' });
  const port = h('input', { type: 'number', value: S.settings.callbackPort, min: 1024, max: 65535 });
  return h(
    'div',
    {},
    h('h1', {}, 'Connect your Autodesk app'),
    h('p', { class: 'lead' }, 'Data Connector only works with a user sign-in through an APS app you control. It takes about five minutes, once. ', link('Step-by-step guide', `${S.repoUrl}/blob/master/docs/aps-app-setup.md`)),
    h('div', { class: 'card' }, apsSteps(), h('label', { class: 'field' }, h('span', {}, 'APS Client ID'), input), h('details', {}, h('summary', { class: 'muted small' }, 'Advanced: callback port'), h('label', { class: 'field' }, h('span', {}, 'Port (the callback URL above changes with it)'), port))),
    wNav({
      next: async () => {
        if (!input.value.trim()) return toast('Paste your Client ID first.', true);
        await call(fdm.updateSettings, { clientId: input.value, callbackPort: Number(port.value) });
        wizardStep = 2;
        refresh();
      },
    })
  );
}

function wSignIn() {
  const status = S.signedIn ? banner('ok', `Signed in${S.user?.name ? ` as ${S.user.name}` : ''}${S.user?.email ? ` (${S.user.email})` : ''}.`) : null;
  return h(
    'div',
    {},
    h('h1', {}, 'Sign in to Autodesk'),
    h('p', { class: 'lead' }, 'Your browser opens the Autodesk sign-in page. After you approve, come back here. Tokens are encrypted with your Windows account and never leave this computer.'),
    status,
    h('div', { class: 'row' }, btn(S.signedIn ? 'Sign in again' : 'Sign in with Autodesk', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Waiting for the browser…';
      try {
        await call(fdm.signIn);
        hubsCache = null;
        toast('Signed in');
        await refresh();
      } finally {
        e.target.disabled = false;
      }
    }, 'primary big-btn')),
    wNav({ nextDisabled: !S.signedIn })
  );
}

function wHub() {
  const holder = h('div', { class: 'list-pick' }, h('div', { class: 'muted' }, 'Loading hubs…'));
  let picked = S.settings.hub;
  const load = async () => {
    try {
      hubsCache = hubsCache || (await call(fdm.listHubs));
      holder.replaceChildren(
        ...(hubsCache.length
          ? hubsCache.map((hub) =>
              h('label', {}, h('input', { type: 'radio', name: 'hub', checked: picked?.accountId === hub.accountId, onchange: () => (picked = hub) }), h('div', {}, h('div', { text: hub.name }), h('div', { class: 'muted small mono', text: `${hub.accountId}${hub.region ? ` · ${hub.region}` : ''}` })))
            )
          : [h('div', { class: 'muted' }, 'No ACC / BIM 360 hubs are visible to this account. Check that the Client ID was added under Custom Integrations, or enter the hub ID below.')])
      );
    } catch {
      holder.replaceChildren(h('div', { class: 'muted' }, 'Could not list hubs. You can enter the hub (account) ID manually below.'));
    }
  };
  load();
  const manualId = h('input', { type: 'text', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', spellcheck: 'false' });
  const manualName = h('input', { type: 'text', placeholder: 'Display name (optional)' });
  return h(
    'div',
    {},
    h('h1', {}, 'Choose your hub'),
    h('p', { class: 'lead' }, 'The whole hub is extracted: all projects and all modules.'),
    holder,
    h('details', {}, h('summary', { class: 'muted small' }, 'Enter a hub ID instead'), h('div', { class: 'row' }, manualId, manualName, btn('Use this ID', async () => {
      await call(fdm.manualHub, manualId.value, manualName.value);
      wizardStep = 4;
      refresh();
    }))),
    wNav({
      next: async () => {
        if (!picked) return toast('Pick a hub.', true);
        await call(fdm.selectHub, picked);
        wizardStep = 4;
        refresh();
      },
    })
  );
}

function wFolder() {
  let dir = S.settings.dataDir || S.settings.defaultDataDir;
  const pathEl = h('div', { class: 'mono', text: dir });
  const info = h('div', {});
  const check = async () => {
    const r = await call(fdm.checkDataDir, dir);
    info.replaceChildren(
      r.writable ? banner('ok', `Writable${r.freeGb != null ? ` · ${r.freeGb} GB free` : ''}`) : banner('bad', `Can’t write here: ${r.error || 'permission denied'}`),
      ...r.warnings.map((w) => banner('warn', w))
    );
  };
  check();
  return h(
    'div',
    {},
    h('h1', {}, 'Where should the database live?'),
    h('p', { class: 'lead' }, 'A local, non-synced folder works best. Each sync writes a new database file (often 1–3 GB) and keeps the previous one for rollback.'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, pathEl, h('span', { class: 'spacer' }), btn('Browse…', async () => {
      const picked = await call(fdm.pickDataDir);
      if (picked) {
        dir = picked;
        pathEl.textContent = dir;
        check();
      }
    })), info),
    wNav({
      next: async () => {
        await call(fdm.setDataDir, dir);
        wizardStep = 5;
        refresh();
      },
    })
  );
}

function wSchedule() {
  const enabled = h('input', { type: 'checkbox', checked: S.settings.schedule.enabled });
  const time = h('input', { type: 'time', value: S.settings.schedule.time });
  const login = h('input', { type: 'checkbox', checked: S.settings.startAtLogin });
  return h(
    'div',
    {},
    h('h1', {}, 'Daily sync'),
    h('p', { class: 'lead' }, 'Once a day the app asks Data Connector for a fresh extract, downloads it and rebuilds the database. Autodesk allows 24 extraction jobs per day per hub and per user, and jobs started in the Forma web UI count too.'),
    h(
      'div',
      { class: 'card' },
      h('label', { class: 'check' }, enabled, h('span', {}, 'Sync automatically every day at ', time, ' (local time)')),
      h('p', { class: 'muted small' }, 'If the computer is off or asleep at that time, the sync runs as soon as the app is running again. It’s skipped if you synced manually in the previous 12 hours.'),
      h('label', { class: 'check' }, login, h('span', {}, 'Start Forma Data Manager when I sign in to Windows (runs quietly in the tray)'))
    ),
    wNav({
      next: async () => {
        await call(fdm.updateSettings, { schedule: { enabled: enabled.checked, time: time.value || '06:00' }, startAtLogin: login.checked });
        wizardStep = 6;
        refresh();
      },
    })
  );
}

function claudeStatusList() {
  const kinds = { installer: 'Claude Desktop (standard installer)', store: 'Claude Desktop (Microsoft Store / MSIX)', macos: 'Claude Desktop' };
  const states = { configured: ['Connected', 'ok'], outdated: ['Needs update', 'warn'], missing: ['Not set up', 'info'], 'not-installed': ['Not found', 'info'], 'invalid-json': ['Config file has errors', 'bad'] };
  return h(
    'table',
    {},
    h('tr', {}, h('th', {}, 'Location'), h('th', {}, 'Status'), h('th', {}, 'Config file')),
    S.claude.map((c) => {
      const [label, kind] = states[c.state] || [c.state, 'info'];
      return h('tr', {}, h('td', { text: kinds[c.kind] || c.kind }), h('td', {}, badge(label, kind), c.legacy?.length ? h('div', { class: 'small muted', text: `Old entry found: ${c.legacy.join(', ')}` }) : null), h('td', { class: 'mono small', text: c.file }));
    })
  );
}

async function doInstallClaude(removeLegacy) {
  const res = await call(fdm.installClaude, { removeLegacy });
  const ok = res.filter((r) => r.ok);
  const bad = res.filter((r) => !r.ok);
  if (ok.length) toast('Claude Desktop is set up. Restart Claude Desktop to load it.');
  await refresh();
  return h('div', {}, ok.map((r) => banner('ok', `Updated ${r.file}`, r.backup ? h('div', { class: 'small', text: `Backup: ${r.backup}` }) : null, r.removedLegacy?.length ? h('div', { class: 'small', text: `Removed old entry: ${r.removedLegacy.join(', ')}` }) : null)), bad.map((r) => banner('bad', `${r.file}: ${r.error}`)));
}

function wClaude() {
  const out = h('div', {});
  const legacy = h('input', { type: 'checkbox', checked: true });
  const anyFound = S.claude.some((c) => c.state !== 'not-installed');
  return h(
    'div',
    {},
    h('h1', {}, 'Connect Claude Desktop'),
    h('p', { class: 'lead' }, 'Adds the ', h('span', { class: 'mono' }, 'forma-data'), ' server to Claude Desktop’s config. Your other MCP servers and settings are kept, and the file is backed up first.'),
    h('div', { class: 'card' }, claudeStatusList(), !anyFound ? banner('warn', 'Claude Desktop wasn’t found for this Windows user. Install it from claude.ai/download and open it once, then click Set up. You can also do this later under Claude setup.') : null, h('label', { class: 'check' }, legacy, h('span', {}, 'Remove the old "acc-data" entry if it exists')), h('div', { class: 'row' }, btn('Set up Claude Desktop', async () => out.replaceChildren(await doInstallClaude(legacy.checked)), 'primary')), out),
    h('details', { class: 'card' }, h('summary', {}, 'Using Claude Code instead?'), h('p', { class: 'small muted' }, 'Run this once in a terminal:'), S.claudeCodeCommand ? copybox(S.claudeCodeCommand) : null),
    wNav({ skip: () => ((wizardStep = 7), render()) })
  );
}

function skillTools() {
  const editor = h('textarea', { spellcheck: 'false' });
  const editorWrap = h('details', {}, h('summary', {}, 'Customize the skill before saving (colors, KPIs, tone…)'), editor);
  fdm.getSkill().then((r) => r.ok && (editor.value = skillDraft ?? r.value));
  editor.addEventListener('input', () => (skillDraft = editor.value));
  const md = () => (skillDraft != null ? skillDraft : null);
  return h(
    'div',
    {},
    h('div', { class: 'card' }, h('h2', {}, 'Claude Desktop and claude.ai'), h('ol', { class: 'steps' }, h('li', {}, 'Click ', h('b', {}, 'Save skill ZIP'), ' (it goes to your Downloads folder).'), h('li', {}, 'In Claude, open ', link('Settings → Capabilities', 'https://claude.ai/settings/capabilities'), ', make sure code execution is on, and under Skills choose ', h('b', {}, 'Upload skill'), '.'), h('li', {}, 'Pick the ZIP. The skill is now available in every chat.')), h('div', { class: 'row' }, btn('Save skill ZIP', async () => {
      const p = await call(fdm.saveSkillZip, md());
      toast(`Saved ${p}`);
    }, 'primary'))),
    h('div', { class: 'card' }, h('h2', {}, 'Claude Code'), h('p', { class: 'muted' }, 'Copies the skill to your user skills folder (~/.claude/skills).'), btn('Install for Claude Code', async () => {
      const p = await call(fdm.installSkillClaudeCode, md());
      toast(`Installed to ${p}`);
    })),
    h('div', { class: 'card' }, h('p', { class: 'muted small' }, 'No upload needed to get started: the MCP server also offers the same guide as the ', h('b', {}, 'forma_dashboard'), ' prompt (in Claude Desktop, use the + menu → forma-data).'), editorWrap)
  );
}

function wSkill() {
  return h('div', {}, h('h1', {}, 'Dashboard skill'), h('p', { class: 'lead' }, 'A prepackaged skill that teaches Claude the house style for Forma dashboards and the data rules that keep numbers right (status groups, change-order chains, cost variance sign, and more).'), skillTools(), wNav({ skip: () => ((wizardStep = 8), render()) }));
}

function wFinish() {
  const runNow = h('input', { type: 'checkbox', checked: true });
  return h(
    'div',
    {},
    h('h1', {}, 'All set'),
    h('div', { class: 'card' }, h('table', {}, [
      ['Hub', S.settings.hub?.name || '—'],
      ['Signed in', S.user?.email || (S.signedIn ? 'yes' : 'no')],
      ['Data folder', S.settings.dataDir || '—'],
      ['Daily sync', S.settings.schedule.enabled ? `every day at ${S.settings.schedule.time}` : 'off'],
      ['Claude Desktop', S.claude.some((c) => c.state === 'configured') ? 'connected' : 'not set up yet'],
    ].map(([k, v]) => h('tr', {}, h('td', { class: 'muted', text: k }), h('td', { text: v }))))),
    h('label', { class: 'check' }, runNow, h('span', {}, 'Run the first sync now. Depending on hub size, Autodesk takes a few minutes to a couple of hours to prepare the extract; you can close the window meanwhile.')),
    wNav({
      nextLabel: 'Finish',
      next: async () => {
        await call(fdm.completeWizard);
        page = 'status';
        if (runNow.checked) await call(fdm.syncNow).catch(() => {});
        refresh();
      },
    })
  );
}

// ── status ──────────────────────────────────────────────────────────────────
function renderStatus() {
  const db = S.database;
  const age = ageDays(db?.as_of);
  const sync = S.sync || {};
  const running = S.busy;
  const ageBadge = age == null ? null : age <= 2 ? badge('Current', 'ok') : age <= 7 ? badge(`${age} days old`, 'warn') : badge(`${age} days old`, 'bad');
  const hero = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'hero' },
      h('div', {}, h('div', { class: 'muted small' }, 'DATA AS OF'), h('div', { class: 'big' }, db?.as_of ? new Date(`${db.as_of}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'long' }) : 'No data yet', ' ', ageBadge), db ? h('div', { class: 'stats' }, [['Rows', fmtNum(db.total_rows)], ['Tables', fmtNum(db.table_count)], ['Size', db.size_bytes ? `${(db.size_bytes / 1073741824).toFixed(2)} GB` : '—'], ['Built', fmtDate(db.built_at)]].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)))) : h('p', { class: 'muted' }, 'Run a sync to build your first database.')),
      h('div', { class: 'row' }, running ? btn('Cancel', () => call(fdm.cancelSync), 'danger') : btn('Sync now', async () => {
        await call(fdm.syncNow);
        refresh();
      }, 'primary big-btn'))
    ),
    db?.warnings?.length ? banner('warn', db.warnings.join(' ')) : null
  );

  const phaseNames = { requesting: 'Requesting extract', waiting: 'Waiting for Autodesk', downloading: 'Downloading', building: 'Building database', done: 'Last sync finished', failed: 'Last sync failed', cancelled: 'Sync cancelled', rejected: 'Extract needs your review' };
  const indeterminate = running && (sync.progress == null || ['requesting', 'waiting'].includes(sync.phase));
  const syncCard =
    sync.phase && sync.phase !== 'idle'
      ? h(
          'div',
          { class: 'card' },
          h('h2', {}, phaseNames[sync.phase] || sync.phase, running && sync.resumed ? h('span', { class: 'muted small' }, ' (resumed)') : null),
          running ? h('div', { class: `progress ${indeterminate ? 'indeterminate' : ''}` }, h('div', {})) : null,
          h('div', { class: sync.phase === 'failed' ? 'banner bad' : 'muted', text: sync.message || '' }),
          sync.warning ? banner('warn', sync.warning) : null
        )
      : null;
  if (syncCard && running && !indeterminate) syncCard.querySelector('.progress > div').style.width = `${Math.round((sync.progress || 0) * 100)}%`;

  const rejected = S.pendingRejected
    ? banner('warn', h('b', {}, 'The new extract looks incomplete. '), S.pendingRejected, h('div', { class: 'row' }, btn('Use it anyway', () => call(fdm.useRejected)), btn('Discard', () => call(fdm.discardRejected))))
    : null;

  const claudeOk = S.claude.some((c) => c.state === 'configured');
  const claudeOutdated = S.claude.some((c) => c.state === 'outdated');
  const info = h(
    'div',
    { class: 'grid' },
    h('div', { class: 'card' }, h('h2', {}, 'Schedule'), h('p', {}, S.settings.schedule.enabled ? `Every day at ${S.settings.schedule.time}` : 'Automatic sync is off'), h('p', { class: 'muted small' }, S.nextRun ? `Next run: ${fmtDate(S.nextRun)}` : ''), h('p', { class: 'muted small' }, `${S.jobsLast24h} of 24 Data Connector jobs used by this app in the last 24 hours`)),
    h('div', { class: 'card' }, h('h2', {}, 'Claude Desktop'), claudeOk ? badge('Connected', 'ok') : claudeOutdated ? badge('Needs update', 'warn') : badge('Not set up', 'info'), h('p', { class: 'muted small' }, claudeOk ? 'Ask Claude about your projects. Restart Claude Desktop after changing settings here.' : 'Connect it so Claude can query the database.'), h('div', { class: 'row' }, btn('Claude setup', () => ((page = 'claude'), render())))),
    h('div', { class: 'card' }, h('h2', {}, 'Hub'), h('p', { text: S.settings.hub?.name || '—' }), h('p', { class: 'muted small mono', text: S.settings.hub?.accountId || '' }), !S.signedIn ? btn('Sign in', async () => (await call(fdm.signIn), refresh()), 'primary') : null)
  );

  return h('div', {}, h('h1', {}, 'Status'), h('p', { class: 'lead' }, 'Your hub’s data, refreshed from Autodesk Data Connector.'), rejected, hero, syncCard, info);
}

// ── history ─────────────────────────────────────────────────────────────────
function renderHistory() {
  const kinds = { success: 'ok', failed: 'bad', rejected: 'warn', cancelled: 'info' };
  return h(
    'div',
    {},
    h('h1', {}, 'History'),
    h('p', { class: 'lead' }, 'The last syncs, newest first. Full details are in the log file.'),
    h(
      'div',
      { class: 'card' },
      S.history.length
        ? h('table', {}, h('tr', {}, ['Started', 'Trigger', 'Result', 'Data as of', 'Rows', 'Minutes', 'Notes'].map((t) => h('th', {}, t))), S.history.map((r) => h('tr', {}, h('td', { class: 'nowrap', text: fmtDate(r.startedAt) }), h('td', { text: r.trigger }), h('td', {}, badge(r.status, kinds[r.status] || 'info')), h('td', { class: 'nowrap', text: r.asOf || '—' }), h('td', { text: fmtNum(r.rows) }), h('td', { text: r.minutes ?? '—' }), h('td', { class: 'small', text: r.error || [...(r.warnings || []), r.viewsFailed?.length ? `Views unavailable: ${r.viewsFailed.join(', ')}` : ''].filter(Boolean).join(' ') || '' }))))
        : h('p', { class: 'muted' }, 'No syncs yet.')
    ),
    h('div', { class: 'row' }, btn('Open log folder', () => fdm.openPath('logs')))
  );
}

// ── claude ──────────────────────────────────────────────────────────────────
function renderClaude() {
  const out = h('div', {});
  const legacy = h('input', { type: 'checkbox', checked: true });
  return h(
    'div',
    {},
    h('h1', {}, 'Claude setup'),
    h('p', { class: 'lead' }, 'Register the forma-data MCP server with Claude, and install the dashboard skill.'),
    h('div', { class: 'card' }, h('h2', {}, 'Claude Desktop'), claudeStatusList(), h('label', { class: 'check' }, legacy, h('span', {}, 'Remove the old "acc-data" entry if it exists')), h('div', { class: 'row' }, btn('Set up / update Claude Desktop', async () => out.replaceChildren(await doInstallClaude(legacy.checked)), 'primary'), btn('Remove from Claude Desktop', async () => {
      await call(fdm.uninstallClaude);
      toast('Removed. Restart Claude Desktop.');
      refresh();
    }, 'danger')), out, h('p', { class: 'muted small' }, 'After any change, fully quit Claude Desktop (tray icon → Quit) and open it again.')),
    h('div', { class: 'card' }, h('h2', {}, 'Claude Code'), h('p', { class: 'muted small' }, 'Run once in a terminal to add the server for all your projects:'), S.claudeCodeCommand ? copybox(S.claudeCodeCommand) : h('p', { class: 'muted' }, 'Engine not found.')),
    h('h2', {}, 'Dashboard skill'),
    skillTools()
  );
}

// ── settings ────────────────────────────────────────────────────────────────
function renderSettings() {
  const s = S.settings;
  const clientId = h('input', { type: 'text', value: s.clientId, spellcheck: 'false' });
  const port = h('input', { type: 'number', value: s.callbackPort });
  const enabled = h('input', { type: 'checkbox', checked: s.schedule.enabled });
  const time = h('input', { type: 'time', value: s.schedule.time });
  const login = h('input', { type: 'checkbox', checked: s.startAtLogin });
  const keep = h('input', { type: 'number', value: s.keepVersions, min: 1, max: 5 });
  const keepDl = h('input', { type: 'checkbox', checked: s.keepDownloads });
  const save = async () => {
    await call(fdm.updateSettings, { clientId: clientId.value, callbackPort: Number(port.value), schedule: { enabled: enabled.checked, time: time.value || '06:00' }, startAtLogin: login.checked, keepVersions: Number(keep.value), keepDownloads: keepDl.checked });
    toast('Saved');
    refresh();
  };
  return h(
    'div',
    {},
    h('h1', {}, 'Settings'),
    h('div', { class: 'card' }, h('h2', {}, 'Sync'), h('label', { class: 'check' }, enabled, h('span', {}, 'Sync every day at ', time)), h('label', { class: 'check' }, login, h('span', {}, 'Start with Windows (in the tray)')), h('label', { class: 'field' }, h('span', {}, 'Database versions to keep (for rollback)'), keep), h('label', { class: 'check' }, keepDl, h('span', {}, 'Keep downloaded extract ZIPs (for troubleshooting; they are large)')), btn('Save', save, 'primary')),
    h('div', { class: 'card' }, h('h2', {}, 'Autodesk app and sign-in'), h('label', { class: 'field' }, h('span', {}, 'APS Client ID'), clientId), h('label', { class: 'field' }, h('span', {}, 'Callback port'), port), h('p', { class: 'small muted' }, 'Callback URL to register in your APS app:'), copybox(S.redirectUri), h('div', { class: 'row' }, btn('Save', save, 'primary'), S.signedIn ? btn('Sign out', async () => (await call(fdm.signOut), refresh()), 'danger') : btn('Sign in', async () => (await call(fdm.signIn), refresh())))),
    h('div', { class: 'card' }, h('h2', {}, 'Hub'), h('p', { text: S.settings.hub ? `${S.settings.hub.name} (${S.settings.hub.accountId})` : 'None' }), btn('Change hub', () => openWizardAt(3))),
    h('div', { class: 'card' }, h('h2', {}, 'Data folder'), h('p', { class: 'mono', text: s.dataDir || '—' }), h('div', { class: 'row' }, btn('Open', () => fdm.openPath('data')), btn('Change…', async () => {
      const picked = await call(fdm.pickDataDir);
      if (!picked) return;
      await call(fdm.setDataDir, picked);
      toast('Data folder changed. Update Claude Desktop on the Claude setup page, then run a sync.');
      refresh();
    })), h('p', { class: 'small muted' }, 'Changing the folder starts fresh there: run a sync, then update Claude Desktop so it points to the new folder.')),
    h('div', { class: 'card' }, h('h2', {}, 'Database'), h('p', { class: 'muted small' }, 'Go back to the previous database version if the latest extract looks wrong.'), btn('Roll back to previous version', async () => {
      const r = await call(fdm.rollback);
      toast(`Now using ${r.now_live}`);
      refresh();
    })),
    h('div', { class: 'card' }, h('h2', {}, 'Setup'), btn('Run the setup wizard again', () => openWizardAt(0)))
  );
}

function openWizardAt(step) {
  // Re-run setup steps without un-completing setup; "Close setup" returns to the app.
  wizardStep = step;
  wizardOverlay = true;
  render();
}

// ── about ───────────────────────────────────────────────────────────────────
function renderAbout() {
  return h(
    'div',
    {},
    h('h1', {}, 'About'),
    h('p', { class: 'lead' }, `Forma Data Manager ${S.version}`),
    h('div', { class: 'card' }, h('h2', {}, 'Disclaimer'), DISCLAIMER.map((p) => h('p', {}, p))),
    h('div', { class: 'card' }, h('h2', {}, 'Links'), h('div', { class: 'row' }, link('Source code and documentation', S.repoUrl), link('Report an issue', `${S.repoUrl}/issues`), link('License (MIT)', `${S.repoUrl}/blob/master/LICENSE`))),
    h('div', { class: 'card' }, h('h2', {}, 'Files'), h('p', { class: 'small' }, 'Log: ', h('span', { class: 'mono', text: S.logFile })), h('p', { class: 'small' }, 'Engine: ', h('span', { class: 'mono', text: S.engineExe || 'development mode' })), h('div', { class: 'row' }, btn('Open log folder', () => fdm.openPath('logs')), btn('Open data folder', () => fdm.openPath('data'))))
  );
}

// ── boot ────────────────────────────────────────────────────────────────────
async function refresh() {
  const r = await fdm.state();
  if (r.ok) S = r.value;
  render();
}

fdm.onState((s) => {
  S = s;
  // Don't rebuild the wizard on background pushes (would reset inputs the user is typing in).
  if (!S.settings.wizardComplete || wizardOverlay) return;
  if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  render();
});

refresh().then(() => {
  if (!S.settings.wizardComplete) {
    // Resume the wizard where the user left off.
    wizardStep = !S.settings.disclaimerAcceptedAt ? 0 : !S.settings.clientId ? 1 : !S.signedIn ? 2 : !S.settings.hub ? 3 : !S.settings.dataDir ? 4 : 5;
    render();
  }
});

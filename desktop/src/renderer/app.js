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
const STEPS = ['Welcome', 'Autodesk app', 'Sign in', 'Hub', 'Data folder', 'Schedule', 'Claude Desktop', 'Dashboards', 'Finish'];

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
    h('p', { class: 'lead' }, 'Data Connector only works with a user sign-in through an APS app you control. It takes about five minutes, once. ', link('Step-by-step guide', `${S.repoUrl}/blob/main/docs/aps-app-setup.md`)),
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

/** "Who starts the daily extraction" choice, used by the wizard and Settings. */
function modeChoice(current) {
  const name = `mode-${Math.random().toString(36).slice(2, 8)}`;
  const cloud = h('input', { type: 'radio', name, value: 'cloud', checked: current !== 'local' });
  const local = h('input', { type: 'radio', name, value: 'local', checked: current === 'local' });
  const el = h(
    'div',
    { class: 'mode-choice' },
    h('label', { class: 'check' }, cloud, h('span', {}, h('b', {}, 'Autodesk prepares it (recommended). '), 'Autodesk runs the extraction on its servers at that time every day, even when this computer is asleep or off. The app downloads it as soon as the computer is on, and starts one itself if Autodesk’s doesn’t show up.')),
    h('label', { class: 'check' }, local, h('span', {}, h('b', {}, 'This computer starts it. '), 'The app asks Autodesk for an extraction at that time. If the computer is asleep or off, it runs when the computer is on again.'))
  );
  return { el, value: () => (local.checked ? 'local' : 'cloud') };
}

/** One line about where today's extraction comes from, for Status and Settings. */
function scheduleSource() {
  const c = S.cloud || {};
  if (!S.settings.schedule.enabled) return null;
  if (c.mode === 'local') return h('p', { class: 'muted small' }, 'Started from this computer.');
  if (c.active) return h('p', { class: 'muted small' }, 'Prepared by Autodesk on its servers', c.nextExecAt && Date.parse(c.nextExecAt) > Date.now() ? ` · next run ${fmtDate(c.nextExecAt)}` : '', '.');
  if (c.lastError) return h('p', { class: 'small' }, badge('Autodesk schedule unavailable', 'warn'), ' ', h('span', { class: 'muted', text: `${c.lastError} Syncing from this computer meanwhile; the app retries every hour.` }));
  return h('p', { class: 'muted small' }, 'Setting up Autodesk’s daily extraction…');
}

function wSchedule() {
  const enabled = h('input', { type: 'checkbox', checked: S.settings.schedule.enabled });
  const time = h('input', { type: 'time', value: S.settings.schedule.time });
  const login = h('input', { type: 'checkbox', checked: S.settings.startAtLogin });
  const mode = modeChoice(S.settings.extractionMode);
  return h(
    'div',
    {},
    h('h1', {}, 'Daily sync'),
    h('p', { class: 'lead' }, 'Once a day Data Connector prepares a fresh extract of your hub, and the app downloads it and rebuilds the database. Autodesk allows 24 extraction jobs per day per hub and per user, and jobs started in the Forma web UI count too.'),
    h(
      'div',
      { class: 'card' },
      h('label', { class: 'check' }, enabled, h('span', {}, 'Sync automatically every day at ', time, ' (local time)')),
      mode.el,
      h('p', { class: 'muted small' }, 'It runs every day, even if you also sync manually. Sync now always starts a fresh extraction right away.'),
      h('label', { class: 'check' }, login, h('span', {}, 'Start Forma Data Manager when I sign in to Windows (runs quietly in the tray)'))
    ),
    wNav({
      next: async () => {
        await call(fdm.updateSettings, { schedule: { enabled: enabled.checked, time: time.value || '06:00' }, extractionMode: mode.value(), startAtLogin: login.checked });
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
      return h('tr', {}, h('td', { text: kinds[c.kind] || c.kind }), h('td', {}, badge(label, kind)), h('td', { class: 'mono small', text: c.file }));
    })
  );
}

async function doInstallClaude() {
  const res = await call(fdm.installClaude);
  const ok = res.filter((r) => r.ok);
  const bad = res.filter((r) => !r.ok);
  if (ok.length) toast('Claude Desktop is set up. Restart Claude Desktop to load it.');
  await refresh();
  return h('div', {}, ok.map((r) => banner('ok', `Updated ${r.file}`, r.backup ? h('div', { class: 'small', text: `Backup: ${r.backup}` }) : null)), bad.map((r) => banner('bad', `${r.file}: ${r.error}`)));
}

function wClaude() {
  const out = h('div', {});
  const anyFound = S.claude.some((c) => c.state !== 'not-installed');
  return h(
    'div',
    {},
    h('h1', {}, 'Connect Claude Desktop'),
    h('p', { class: 'lead' }, 'Adds the ', h('span', { class: 'mono' }, 'forma-data'), ' server to Claude Desktop’s config. Your other MCP servers and settings are kept, and the file is backed up first.'),
    h('div', { class: 'card' }, claudeStatusList(), !anyFound ? banner('warn', 'Claude Desktop wasn’t found for this Windows user. Install it from claude.ai/download and open it once, then click Set up. You can also do this later under Claude setup.') : null, h('div', { class: 'row' }, btn('Set up Claude Desktop', async () => out.replaceChildren(await doInstallClaude()), 'primary')), out),
    h('details', { class: 'card' }, h('summary', {}, 'Using Claude Code instead?'), h('p', { class: 'small muted' }, 'Run this once in a terminal:'), S.claudeCodeCommand ? copybox(S.claudeCodeCommand) : null),
    wNav({ skip: () => ((wizardStep = 7), render()) })
  );
}

const MARKETPLACE_REPO = 'arqfernandolima-rgb/forma-data-manager';

function guideBuiltIn() {
  return banner(
    'ok',
    h('b', {}, 'Built in, nothing to install. '),
    'The forma-data server includes the dashboard guide (house style plus the data rules that keep numbers right). Claude loads it on its own when you ask for a dashboard, in Claude Desktop, Cowork and Claude Code.'
  );
}

function skillTools() {
  const editor = h('textarea', { spellcheck: 'false' });
  const editorWrap = h('details', {}, h('summary', {}, 'Customize the skill before saving (colors, KPIs, tone\u2026)'), editor);
  fdm.getSkill().then((r) => r.ok && (editor.value = skillDraft ?? r.value));
  editor.addEventListener('input', () => (skillDraft = editor.value));
  const md = () => (skillDraft != null ? skillDraft : null);
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'As a Claude plugin (updates itself)'),
      h('p', { class: 'muted small' }, 'Optional. Adds the same guide as a skill, kept up to date from GitHub. Claude doesn\u2019t let other apps add plugins or skills to your account, so this one-time step happens in Claude:'),
      h('ol', { class: 'steps' }, h('li', {}, 'In Claude, open ', h('b', {}, 'Customize \u2192 Plugins'), '.'), h('li', {}, 'Choose ', h('b', {}, 'Add \u2192 Add marketplace \u2192 Add from a repository'), ' and enter:', copybox(MARKETPLACE_REPO)), h('li', {}, 'Install the ', h('b', {}, 'forma-data'), ' plugin.'))
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'As an uploaded skill'),
      h('p', { class: 'muted small' }, 'Optional. Use this if you want to customize the guide.'),
      h('ol', { class: 'steps' }, h('li', {}, 'Click ', h('b', {}, 'Save skill ZIP'), ' (it goes to your Downloads folder).'), h('li', {}, 'In Claude, open ', h('b', {}, 'Customize \u2192 Skills'), ', click ', h('b', {}, '+ \u2192 Create skill \u2192 Upload a skill'), ', and pick the ZIP.'), h('li', { class: 'muted small' }, 'Skills need code execution turned on (Settings \u2192 Capabilities).')),
      h('div', { class: 'row' }, btn('Save skill ZIP', async () => {
        const p = await call(fdm.saveSkillZip, md());
        toast(`Saved ${p}`);
      })),
      editorWrap
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Claude Code'),
      h('p', { class: 'muted small' }, 'Optional. Copy the skill to your user skills folder (~/.claude/skills), or add the plugin from a terminal:'),
      copybox(`claude plugin marketplace add ${MARKETPLACE_REPO} && claude plugin install forma-data@forma-data`),
      h('div', { class: 'row' }, btn('Install for Claude Code', async () => {
        const p = await call(fdm.installSkillClaudeCode, md());
        toast(`Installed to ${p}`);
      }))
    )
  );
}

function wSkill() {
  return h(
    'div',
    {},
    h('h1', {}, 'Dashboards'),
    h('p', { class: 'lead' }, 'Claude builds dashboards from your Forma data using a house style and data rules (status groups, change-order chains, cost variance sign, demo-project labels, and more).'),
    guideBuiltIn(),
    h('details', { class: 'card' }, h('summary', {}, 'Also want it as a skill or plugin? (optional)'), skillTools()),
    wNav({})
  );
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
      ['Daily sync', S.settings.schedule.enabled ? `every day at ${S.settings.schedule.time}, ${S.settings.extractionMode === 'local' ? 'started from this computer' : 'prepared by Autodesk'}` : 'off'],
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

// ── sync timeline ───────────────────────────────────────────────────────────
// Live counters: elements carry data-since / data-ago / data-until (ISO times) and a 1 s ticker
// updates their text, so elapsed time moves without re-rendering the page.
function fmtSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}
function fmtMinutes(min) {
  return min == null ? null : fmtSpan(min * 60_000);
}
const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
function fmtBytes(b) {
  if (b == null) return null;
  if (b < 1048576) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(b < 104857600 ? 1 : 0)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
function updateLive(el, now = Date.now()) {
  const since = el.getAttribute('data-since');
  const ago = el.getAttribute('data-ago');
  const until = el.getAttribute('data-until');
  let t = '';
  if (since) t = fmtSpan(now - Date.parse(since));
  else if (ago) t = `${fmtSpan(now - Date.parse(ago))} ago`;
  else if (until) {
    const left = Date.parse(until) - now;
    t = left > 1500 ? `in ${fmtSpan(left)}` : 'now';
  }
  el.textContent = `${el.getAttribute('data-prefix') || ''}${t}${el.getAttribute('data-suffix') || ''}`;
}
// Filled in right away (not on the first tick), so there's never an empty gap.
const live = (attr, iso, prefix = '', suffix = '') => {
  const el = h('span', { [attr]: iso, 'data-prefix': prefix, 'data-suffix': suffix });
  if (iso) updateLive(el);
  return el;
};
function tickLive() {
  const now = Date.now();
  document.querySelectorAll('[data-since],[data-ago],[data-until]').forEach((el) => updateLive(el, now));
}
setInterval(tickLive, 1000);

function progressBar(fraction) {
  const bar = h('div', { class: 'progress' }, h('div', {}));
  bar.firstChild.style.width = `${Math.max(2, Math.round((fraction || 0) * 100))}%`;
  return bar;
}

function renderSyncTimeline(sync, running) {
  if (!sync.phase || sync.phase === 'idle') return null;
  const tl = sync.timeline || {};
  const est = sync.estimate || {};
  const failed = ['failed', 'cancelled', 'rejected'].includes(sync.phase);
  const done = sync.phase === 'done';

  // Which step is in progress (or where it stopped).
  let cur;
  if (done) cur = 6;
  else if (sync.phase === 'requesting') cur = 0;
  else if (sync.phase === 'waiting') cur = tl.jobId ? 2 : 1;
  else if (sync.phase === 'downloading') cur = 3;
  else if (sync.phase === 'building') cur = 4;
  else cur = !tl.requestedAt ? 0 : !tl.jobId ? 1 : !tl.preparedAt ? 2 : !tl.downloadedAt ? 3 : 4;

  const jobState = String(sync.job?.status || '').toLowerCase();
  const autodeskSince = tl.confirmedAt || tl.requestedAt;
  const elapsedPrep = autodeskSince ? Date.now() - Date.parse(autodeskSince) : 0;
  const slow = est.prepareMinutes && elapsedPrep > est.prepareMinutes * 60_000 * 1.5;

  const prepCurrent = h(
    'div',
    {},
    h('div', {}, jobState === 'queued' || jobState === 'pending' ? 'Waiting in Autodesk’s queue. ' : 'Autodesk is extracting your hub’s data. ', live('data-since', autodeskSince, '', ' so far.')),
    h(
      'div',
      {},
      est.prepareMinutes
        ? `Your last ${est.basedOn > 1 ? `${est.basedOn} syncs` : 'sync'} took about ${fmtMinutes(est.prepareMinutes)} at this step.`
        : 'This usually takes from a few minutes to a couple of hours, depending on hub size and how busy Data Connector is.',
      slow ? ' It’s taking longer than usual; Autodesk’s queue may be busy.' : ''
    ),
    sync.lastCheckAt ? h('div', { class: 'small' }, 'Last checked ', live('data-ago', sync.lastCheckAt), sync.nextCheckAt ? h('span', {}, ' · next check ', live('data-until', sync.nextCheckAt)) : null) : null
  );

  const dl = sync.download;
  const dlCurrent = h(
    'div',
    {},
    progressBar(sync.progress),
    h('div', {}, dl?.total ? `${fmtBytes(dl.done)} of ${fmtBytes(dl.total)}` : sync.message || 'Starting the download…', dl?.bytesPerSec ? ` · ${fmtBytes(dl.bytesPerSec)}/s` : '', dl?.secondsLeft != null ? ` · about ${fmtSpan(dl.secondsLeft * 1000)} left` : '')
  );
  const buildCurrent = h('div', {}, progressBar(sync.progress), h('div', { text: sync.message || 'Starting…' }));
  const sizeKnown = tl.downloadBytes ? fmtBytes(tl.downloadBytes) : null;

  const steps = [
    { title: 'Extraction requested', time: tl.requestedAt, doneText: tl.byAutodesk ? 'Started by Autodesk’s daily schedule.' : 'Sent to Autodesk Data Connector.', currentText: 'Sending the request to Autodesk…' },
    { title: 'Confirmed by Autodesk', time: tl.confirmedAt, doneText: tl.jobId ? `Accepted as job ${String(tl.jobId).slice(0, 8)}.` : 'Accepted.', currentText: 'Waiting for Autodesk to accept the request (usually under a minute).' },
    { title: 'Autodesk prepares your extract', time: tl.preparedAt, doneText: tl.preparedAt && autodeskSince ? `Ready after ${fmtSpan(Date.parse(tl.preparedAt) - Date.parse(autodeskSince))}.` : 'Ready.', current: prepCurrent, pendingText: est.prepareMinutes ? `Usually about ${fmtMinutes(est.prepareMinutes)}.` : 'Can take a while; it runs on Autodesk’s servers.' },
    { title: 'Download', time: tl.downloadedAt, doneText: sizeKnown ? `${sizeKnown} downloaded.` : 'Downloaded.', current: dlCurrent, pendingText: est.sizeBytes ? `About ${fmtBytes(est.sizeBytes)} last time.` : null },
    { title: 'Build the database', time: done ? sync.lastResult?.finishedAt : null, doneText: sync.lastResult?.rows ? `${Number(sync.lastResult.rows).toLocaleString()} rows in ${sync.lastResult.tables} tables.` : 'Built.', current: buildCurrent, pendingText: 'Usually about a minute.' },
    { title: 'Ready for Claude', time: done ? sync.lastResult?.finishedAt : null, doneText: sync.lastResult?.asOf ? `Claude now sees data as of ${new Date(`${sync.lastResult.asOf}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'long' })}.` : 'Done.', pendingText: 'Claude keeps using the current data until then.' },
  ];

  const list = h(
    'ol',
    { class: 'timeline' },
    steps.map((st, i) => {
      const state = i < cur ? 'done' : i === cur && !done ? (failed ? 'failed' : 'current') : 'pending';
      const detail =
        state === 'done' ? st.doneText : state === 'current' ? st.current || st.currentText : state === 'failed' ? (sync.phase === 'cancelled' ? 'Cancelled.' : sync.message) : st.pendingText;
      return h(
        'li',
        { class: `tl-step ${state}` },
        h('span', { class: 'tl-dot', 'aria-hidden': 'true' }, state === 'done' ? '✓' : state === 'failed' ? '✕' : ''),
        h('span', { class: 'tl-title' }, st.title),
        h('span', { class: 'tl-time' }, state === 'done' && st.time ? fmtClock(st.time) : ''),
        detail ? h('div', { class: 'tl-detail' }, detail) : null
      );
    })
  );

  const title = running ? 'Syncing your hub' : done ? 'Last sync finished' : sync.phase === 'cancelled' ? 'Sync cancelled' : sync.phase === 'rejected' ? 'New extract needs your review' : 'Last sync failed';
  const sub = running
    ? h('span', {}, `Started ${fmtClock(sync.startedAt)} · `, live('data-since', sync.startedAt, '', ' so far'), sync.resumed ? ' · resumed after a restart' : '')
    : done && sync.lastResult
      ? `Finished ${fmtClock(sync.lastResult.finishedAt)} · took ${fmtMinutes(sync.lastResult.minutes)}`
      : sync.startedAt
        ? `Started ${fmtClock(sync.startedAt)}`
        : '';

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, title), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, sub)),
    running && ['requesting', 'waiting'].includes(sync.phase)
      ? banner('info', 'This part runs on Autodesk’s servers and can take a while. You can close this window: Forma Data Manager keeps checking from the tray and lets you know when the new data is ready.')
      : null,
    list,
    sync.warning ? banner('warn', sync.warning) : null
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

  const changes = db?.changes;
  const changesCard = changes
    ? h(
        'div',
        { class: 'card' },
        h('div', { class: 'row' }, h('h2', {}, 'What changed'), h('span', { class: 'spacer' }), h('span', { class: 'muted small', text: FormaChanges.changeHeading(changes) })),
        h('ul', { class: 'changes' }, FormaChanges.changeLines(changes).map((l) => h('li', { text: l })))
      )
    : null;

  const syncCard = renderSyncTimeline(sync, running);

  const rejected = S.pendingRejected
    ? banner('warn', h('b', {}, 'The new extract looks incomplete. '), S.pendingRejected, h('div', { class: 'row' }, btn('Use it anyway', () => call(fdm.useRejected)), btn('Discard', () => call(fdm.discardRejected))))
    : null;

  const claudeOk = S.claude.some((c) => c.state === 'configured');
  const claudeOutdated = S.claude.some((c) => c.state === 'outdated');
  const info = h(
    'div',
    { class: 'grid' },
    h('div', { class: 'card' }, h('h2', {}, 'Schedule'), h('p', {}, S.settings.schedule.enabled ? `Every day at ${S.settings.schedule.time}` : 'Automatic sync is off'), scheduleSource(), S.cloud?.mode === 'local' || !S.cloud?.active ? h('p', { class: 'muted small' }, S.nextRun ? `Next run: ${fmtDate(S.nextRun)}` : '') : null, h('p', { class: 'muted small' }, `${S.jobsLast24h} of 24 Data Connector jobs used by this app in the last 24 hours`)),
    h('div', { class: 'card' }, h('h2', {}, 'Claude Desktop'), claudeOk ? badge('Connected', 'ok') : claudeOutdated ? badge('Needs update', 'warn') : badge('Not set up', 'info'), h('p', { class: 'muted small' }, claudeOk ? 'Ask Claude about your projects. Restart Claude Desktop after changing settings here.' : 'Connect it so Claude can query the database.'), h('div', { class: 'row' }, btn('Claude setup', () => ((page = 'claude'), render())))),
    h('div', { class: 'card' }, h('h2', {}, 'Hub'), h('p', { text: S.settings.hub?.name || '—' }), h('p', { class: 'muted small mono', text: S.settings.hub?.accountId || '' }), !S.signedIn ? btn('Sign in', async () => (await call(fdm.signIn), refresh()), 'primary') : null)
  );

  return h('div', {}, h('h1', {}, 'Status'), h('p', { class: 'lead' }, 'Your hub’s data, refreshed from Autodesk Data Connector.'), rejected, hero, changesCard, syncCard, info);
}

// ── history ─────────────────────────────────────────────────────────────────
// Rows the user opened (by start time), kept across background re-renders.
const openHistory = new Set();

/** Full-width breakdown under a history row: Added / Removed / Closed per category. */
function changeDetail(c) {
  const rows = FormaChanges.changeTable(c);
  const cell = (n) => (n ? fmtNum(n) : '—');
  return h(
    'div',
    { class: 'change-detail' },
    rows.length
      ? h('table', { class: 'mini' }, h('tr', {}, ['', 'Added', 'Removed', 'Closed'].map((t) => h('th', { class: t ? 'num' : '' }, t))), rows.map((r) => h('tr', {}, h('td', { text: r.label }), h('td', { class: 'num', text: cell(r.added) }), h('td', { class: 'num', text: cell(r.removed) }), h('td', { class: 'num', text: cell(r.closed) }))))
      : null,
    FormaChanges.changeNotes(c).map((l) => h('div', { class: 'small', text: l })),
    h('div', { class: 'muted small', text: FormaChanges.changeHeading(c) })
  );
}

function renderHistory() {
  const kinds = { success: 'ok', failed: 'bad', rejected: 'warn', cancelled: 'info' };
  const cols = ['Started', 'Trigger', 'Result', 'Data as of', 'Rows', 'Duration', 'What changed'];
  const rowsFor = (r) => {
    const problems = r.error || [...(r.warnings || []), r.viewsFailed?.length ? `Views unavailable: ${r.viewsFailed.join(', ')}` : ''].filter(Boolean).join(' ');
    const canOpen = r.status === 'success' && !!r.changes;
    const open = canOpen && openHistory.has(r.startedAt);
    const toggle = () => {
      if (open) openHistory.delete(r.startedAt);
      else openHistory.add(r.startedAt);
      render();
    };
    const summary = canOpen
      ? h('button', { class: 'hist-toggle', onclick: toggle, 'aria-expanded': String(open), title: open ? 'Hide details' : 'Show details' }, h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'), FormaChanges.changeTotals(r.changes))
      : r.status === 'success'
        ? h('span', { class: 'muted' }, '—')
        : problems;
    const main = h(
      'tr',
      { class: open ? 'open' : '' },
      h('td', { class: 'nowrap', text: fmtDate(r.startedAt) }),
      h('td', { text: r.source === 'autodesk' ? 'scheduled (Autodesk)' : r.trigger }),
      h('td', {}, badge(r.status, kinds[r.status] || 'info')),
      h('td', { class: 'nowrap', text: r.asOf || '—' }),
      h('td', { text: fmtNum(r.rows) }),
      h('td', {}, r.minutes != null ? fmtMinutes(r.minutes) : '—', r.prepareMinutes != null ? h('div', { class: 'small muted', text: `Autodesk ${fmtMinutes(r.prepareMinutes)}${r.sizeBytes ? ` · ${fmtBytes(r.sizeBytes)}` : ''}` }) : null),
      h('td', {}, summary, r.status === 'success' && problems ? h('div', { class: 'small muted', text: problems }) : null)
    );
    return open ? [main, h('tr', { class: 'detail' }, h('td', { colspan: cols.length }, changeDetail(r.changes)))] : main;
  };
  return h(
    'div',
    {},
    h('h1', {}, 'History'),
    h('p', { class: 'lead' }, 'The last syncs, newest first. Click a summary to see what changed. Full details are in the log file.'),
    h('div', { class: 'card' }, S.history.length ? h('table', { class: 'history' }, h('tr', {}, cols.map((t) => h('th', {}, t))), S.history.flatMap(rowsFor)) : h('p', { class: 'muted' }, 'No syncs yet.')),
    h('div', { class: 'row' }, btn('Open log folder', () => fdm.openPath('logs')))
  );
}

// ── claude ──────────────────────────────────────────────────────────────────
function renderClaude() {
  const out = h('div', {});
  return h(
    'div',
    {},
    h('h1', {}, 'Claude setup'),
    h('p', { class: 'lead' }, 'Register the forma-data MCP server with Claude. The dashboard guide comes built in.'),
    h('div', { class: 'card' }, h('h2', {}, 'Claude Desktop'), claudeStatusList(), h('div', { class: 'row' }, btn('Set up / update Claude Desktop', async () => out.replaceChildren(await doInstallClaude()), 'primary'), btn('Remove from Claude Desktop', async () => {
      await call(fdm.uninstallClaude);
      toast('Removed. Restart Claude Desktop.');
      refresh();
    }, 'danger')), out, h('p', { class: 'muted small' }, 'After any change, fully quit Claude Desktop (tray icon → Quit) and open it again.')),
    h('div', { class: 'card' }, h('h2', {}, 'Claude Code'), h('p', { class: 'muted small' }, 'Run once in a terminal to add the server for all your projects:'), S.claudeCodeCommand ? copybox(S.claudeCodeCommand) : h('p', { class: 'muted' }, 'Engine not found.')),
    h('h2', {}, 'Dashboards'),
    guideBuiltIn(),
    h('details', { class: 'card' }, h('summary', {}, 'Also want it as a skill or plugin? (optional)'), skillTools())
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
  const mode = modeChoice(s.extractionMode);
  const save = async () => {
    await call(fdm.updateSettings, { clientId: clientId.value, callbackPort: Number(port.value), schedule: { enabled: enabled.checked, time: time.value || '06:00' }, extractionMode: mode.value(), startAtLogin: login.checked, keepVersions: Number(keep.value), keepDownloads: keepDl.checked });
    toast('Saved');
    refresh();
  };
  return h(
    'div',
    {},
    h('h1', {}, 'Settings'),
    h('div', { class: 'card' }, h('h2', {}, 'Sync'), h('label', { class: 'check' }, enabled, h('span', {}, 'Sync every day at ', time)), mode.el, scheduleSource(), h('label', { class: 'check' }, login, h('span', {}, 'Start with Windows (in the tray)')), h('label', { class: 'field' }, h('span', {}, 'Database versions to keep (for rollback)'), keep), h('label', { class: 'check' }, keepDl, h('span', {}, 'Keep downloaded extract ZIPs (for troubleshooting; they are large)')), btn('Save', save, 'primary')),
    h('div', { class: 'card' }, h('h2', {}, 'Autodesk app and sign-in'), h('label', { class: 'field' }, h('span', {}, 'APS Client ID'), clientId), h('label', { class: 'field' }, h('span', {}, 'Callback port'), port), h('p', { class: 'small muted' }, 'Callback URL to register in your APS app:'), copybox(S.redirectUri), h('div', { class: 'row' }, btn('Save', save, 'primary'), S.signedIn ? btn('Sign out', async () => (await call(fdm.signOut), refresh()), 'danger') : btn('Sign in', async () => (await call(fdm.signIn), refresh())))),
    h('div', { class: 'card' }, h('h2', {}, 'Hub'), h('p', { text: S.settings.hub ? `${S.settings.hub.name} (${S.settings.hub.accountId})` : 'None' }), btn('Change hub', () => openWizardAt(3))),
    h('div', { class: 'card' }, h('h2', {}, 'Data folder'), h('p', { class: 'mono', text: s.dataDir || '—' }), h('div', { class: 'row' }, btn('Open', () => fdm.openPath('data')), btn('Change…', async () => {
      const picked = await call(fdm.pickDataDir);
      if (!picked) return;
      await call(fdm.setDataDir, picked);
      toast('Data folder changed. Run a sync, then restart Claude Desktop.');
      refresh();
    })), h('p', { class: 'small muted' }, 'Changing the folder starts fresh there: run a sync. Claude Desktop’s entry is pointed at the new folder automatically; restart Claude Desktop afterwards.')),
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
    h('div', { class: 'card' }, h('h2', {}, 'Links'), h('div', { class: 'row' }, link('Source code and documentation', S.repoUrl), link('Report an issue', `${S.repoUrl}/issues`), link('License (MIT)', `${S.repoUrl}/blob/main/LICENSE`))),
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

'use strict';
(() => {
  /* =====================================================================
   *  Study Tracker – renderer
   *
   *  Data model (identical on every device, so all copies can be merged):
   *    topics   [{id, name, type, priority, updatedAt, deleted}]
   *    presets  [{id, name, topic, type, priority, minutes, updatedAt, deleted}]
   *    sessions [{id, date:'YYYY-MM-DD', start:ms, seconds, topic, type,
   *               priority, comment, updatedAt, deleted}]
   *    journal  { 'YYYY-MM-DD': {text, updatedAt} }
   *    plans    { 'YYYY-MM-DD': {blocks:[{id,start,end,topic,type,priority,note}], skipped:[ids], updatedAt, deleted} }
   *    templates[{id, name, blocks, updatedAt, deleted}]
   *    settings {dailyGoalMin, dayStart, updatedAt}
   *  Every record has an id + updatedAt, and deletes are tombstones
   *  (deleted:true), so two copies can be merged safely.
   * ===================================================================== */

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const todayStr = () => ymd(new Date());
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hms = (sec) => { sec = Math.max(0, Math.floor(sec)); return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec % 3600 / 60))}:${pad(sec % 60)}`; };
  const short = (sec) => {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
    if (h > 0) return `${h}h ${pad(m)}m`;
    if (m > 0) return `${m}m`;
    return sec > 0 ? `${sec}s` : '0m';
  };
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
  const fmtLong = (s) => parseYmd(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = (s) => parseYmd(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const fmtDow = (s) => parseYmd(s).toLocaleDateString('en-IN', { weekday: 'long' });
  const live = (arr) => (arr || []).filter((x) => !x.deleted);
  const touch = (o) => { o.updatedAt = Date.now(); return o; };

  // Categories: built-in Study / Break / Sleep / Other plus your own (Workout, Meals, Class…).
  // Each has a colour and a "kind" that decides how its time is counted.
  const KINDS = { study: 'Study', break: 'Break', sleep: 'Sleep', neutral: 'Neutral' };
  const KLABEL = { study: 'Study', break: 'Break', neutral: 'Other', sleep: 'Sleep' };
  const KIND_COLOR = { study: '#2563eb', break: '#38bdf8', sleep: '#8b5cf6', neutral: '#94a3b8' };
  const BUILTIN_CATS = [
    { id: 'study', name: 'Study', color: '#2563eb', kind: 'study' },
    { id: 'break', name: 'Break', color: '#38bdf8', kind: 'break' },
    { id: 'sleep', name: 'Sleep', color: '#8b5cf6', kind: 'sleep' },
    { id: 'other', name: 'Other', color: '#94a3b8', kind: 'neutral' }
  ];
  const LOCKED = ['study', 'break', 'sleep']; // cannot be deleted or change what they count as
  const catRaw = (id) => ((data && data.categories) || []).find((x) => x.id === id);
  function cats() {
    const order = { study: 0, break: 1, sleep: 2, other: 3 };
    return live(data.categories).sort((x, y) => (order[x.id] ?? 9) - (order[y.id] ?? 9) || x.name.localeCompare(y.name));
  }
  function cat(id) { return catRaw(id) || BUILTIN_CATS.find((x) => x.id === id) || { id, name: 'Other', color: '#94a3b8', kind: 'neutral' }; }
  const kindOf = (id) => cat(id).kind;
  const catOptions = (sel) => { const l = cats(), r = catRaw(sel); if (r && r.deleted) l.push(r); return l; };
  const optHtml = (sel) => catOptions(sel).map((x) => `<option value="${esc(x.id)}" ${sel === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const isWork = (s) => { const k = kindOf(s.type); return k === 'study' || k === 'neutral'; };
  const sessionDate = (type, startMs, secs) => ymd(new Date(kindOf(type) === 'sleep' ? startMs + secs * 1000 : startMs)); // sleep counts on the day you wake up
  const PRIOS = {
    high: { label: 'High', color: '#e11d48', bg: '#fff1f2' },
    medium: { label: 'Medium', color: '#d97706', bg: '#fffbeb' },
    low: { label: 'Low', color: '#059669', bg: '#ecfdf5' }
  };
  const prioPill = (p) => `<span class="pill" style="background:${PRIOS[p].bg};color:${PRIOS[p].color}">${PRIOS[p].label}</span>`;
  const typeDot = (t) => `<span class="tdot" style="background:${cat(t).color}"></span>`;
  const defaultLabel = (type) => { const k = kindOf(type); return k === 'break' ? 'Break' : k === 'sleep' ? 'Sleep' : k === 'study' ? 'Study session' : type === 'other' ? 'Activity' : cat(type).name; };

  // ---------- storage (Electron file, or localStorage when opened in a browser) ----------
  const store = window.api || {
    async load() { try { return JSON.parse(localStorage.getItem('studytracker') || 'null'); } catch { return null; } },
    async save(d) { localStorage.setItem('studytracker', JSON.stringify(d)); return true; },
    saveSync(d) { localStorage.setItem('studytracker', JSON.stringify(d)); return true; },
    async exportData(d) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
      a.download = `study-tracker-backup-${todayStr()}.json`;
      a.click();
      return 'Downloads';
    },
    importData() {
      return new Promise((resolve) => {
        const i = document.createElement('input');
        i.type = 'file'; i.accept = '.json';
        i.onchange = async () => {
          try { resolve(JSON.parse(await i.files[0].text())); } catch { resolve({ error: 'That file is not a valid backup.' }); }
        };
        i.click();
      });
    },
    async location() { return 'Browser storage'; }
  };

  // ---------- data ----------
  function defaults() {
    const t = Date.now();
    return {
      version: 1,
      deviceId: uid(),
      topics: [],
      subjects: [],
      rewards: [],
      redemptions: [],
      pointsCfg: { updatedAt: 0, startDate: todayStr(), penalties: true, v: {}, lockUntil: 0 },
      pointsLog: [],
      loans: [],
      repayments: [],
      presets: [
        { id: 'preset-pomodoro-25', name: 'Pomodoro 25', topic: '', type: 'study', priority: 'medium', minutes: 25, updatedAt: t },
        { id: 'preset-deep-focus-50', name: 'Deep focus 50', topic: '', type: 'study', priority: 'high', minutes: 50, updatedAt: t },
        { id: 'preset-short-break-5', name: 'Short break 5', topic: '', type: 'break', priority: 'low', minutes: 5, updatedAt: t }
      ],
      sessions: [],
      journal: {},
      important: { title: 'Main topics', titleAt: 0, items: [] },
      rest: {},
      checkins: {},
      categories: BUILTIN_CATS.map((b) => ({ ...b, updatedAt: 0 })),
      plans: {},
      templates: [],
      settings: { dailyGoalMin: 240, dayStart: '05:00', gapCapMin: 120, sound: true, askFocus: true, restPerWeek: 1, blockMode: 'stopwatch', blockTing: true, updatedAt: t },
      timer: null,
      timerUpdatedAt: 0
    };
  }
  function normalize(d) {
    const base = defaults();
    d = d && typeof d === 'object' ? d : base;
    d.version = 1;
    d.deviceId = d.deviceId || base.deviceId;
    for (const k of ['topics', 'subjects', 'rewards', 'redemptions', 'pointsLog', 'loans', 'repayments', 'presets', 'sessions', 'templates']) if (!Array.isArray(d[k])) d[k] = base[k];
    if (!d.plans || typeof d.plans !== 'object' || Array.isArray(d.plans)) d.plans = {};
    if (!Array.isArray(d.categories)) d.categories = [];
    BUILTIN_CATS.forEach((b) => { if (!d.categories.some((x) => x.id === b.id)) d.categories.push({ ...b, updatedAt: 0 }); });
    d.timerUpdatedAt = d.timerUpdatedAt || 0;
    if (!d.journal || typeof d.journal !== 'object') d.journal = {};
    for (const k of ['rest', 'checkins']) if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) d[k] = {};
    if (!d.important || typeof d.important !== 'object' || Array.isArray(d.important)) d.important = {};
    if (!d.pointsCfg || typeof d.pointsCfg !== 'object' || Array.isArray(d.pointsCfg)) d.pointsCfg = { updatedAt: 0 };
    d.pointsCfg.startDate = d.pointsCfg.startDate || todayStr(); // points start counting the day this version is first opened
    if (d.pointsCfg.penalties === undefined) d.pointsCfg.penalties = true;
    if (!d.pointsCfg.v || typeof d.pointsCfg.v !== 'object') d.pointsCfg.v = {};
    d.pointsCfg.updatedAt = d.pointsCfg.updatedAt || 0;
    d.pointsCfg.lockUntil = d.pointsCfg.lockUntil || 0;
    d.pointsCfg.planBy = d.pointsCfg.planBy || '08:00';
    if (!Array.isArray(d.pointsCfg.autoLog)) d.pointsCfg.autoLog = [];
    d.important.title = d.important.title || 'Main topics';
    d.important.titleAt = d.important.titleAt || 0;
    if (!Array.isArray(d.important.items)) d.important.items = [];
    d.settings = Object.assign({ dailyGoalMin: 240, dayStart: '05:00', gapCapMin: 120, sound: true, askFocus: true, restPerWeek: 1, blockMode: 'stopwatch', blockTing: true, updatedAt: 0 }, d.settings || {});
    if (!d.timer) d.timer = null;
    return d;
  }
  function mergeById(a = [], b = []) {
    const m = new Map();
    [...a, ...b].forEach((it) => {
      if (!it || !it.id) return;
      const cur = m.get(it.id);
      if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) m.set(it.id, it);
    });
    return [...m.values()];
  }
  function mergeData(local, incoming) {
    const inc = normalize(incoming);
    const out = normalize(local);
    out.topics = mergeById(out.topics, inc.topics);
    out.subjects = mergeById(out.subjects, inc.subjects);
    out.rewards = mergeById(out.rewards, inc.rewards);
    out.redemptions = mergeById(out.redemptions, inc.redemptions);
    out.pointsLog = mergeById(out.pointsLog, inc.pointsLog);
    out.loans = mergeById(out.loans, inc.loans);
    out.repayments = mergeById(out.repayments, inc.repayments);
    { const x = out.pointsCfg, y = inc.pointsCfg, lk = Math.max(x.lockUntil || 0, y.lockUntil || 0);
      if ((y.updatedAt || 0) > (x.updatedAt || 0)) out.pointsCfg = y;
      else if ((y.updatedAt || 0) === (x.updatedAt || 0) && y.startDate < x.startDate) x.startDate = y.startDate;
      out.pointsCfg.lockUntil = lk; } // a lock set on any device holds on all of them
    const seen = new Map();
    out.topics.filter((t) => !t.deleted).sort((x, y) => (x.id < y.id ? -1 : 1)).forEach((t) => {
      const k = t.name.toLowerCase();
      if (seen.has(k)) { t.deleted = true; t.updatedAt = Math.max(t.updatedAt || 0, 1); } else seen.set(k, t);
    });
    out.presets = mergeById(out.presets, inc.presets);
    out.sessions = mergeById(out.sessions, inc.sessions);
    for (const [day, j] of Object.entries(inc.journal)) {
      if (!out.journal[day] || (j.updatedAt || 0) > (out.journal[day].updatedAt || 0)) out.journal[day] = j;
    }
    for (const [day, p] of Object.entries(inc.plans)) {
      if (!out.plans[day] || (p.updatedAt || 0) > (out.plans[day].updatedAt || 0)) out.plans[day] = p;
    }
    out.templates = mergeById(out.templates, inc.templates);
    if ((inc.important.titleAt || 0) > (out.important.titleAt || 0)) { out.important.title = inc.important.title; out.important.titleAt = inc.important.titleAt; }
    out.important.items = mergeById(out.important.items, inc.important.items);
    for (const k of ['rest', 'checkins']) {
      for (const [day, v] of Object.entries(inc[k])) {
        if (!out[k][day] || (v.updatedAt || 0) > (out[k][day].updatedAt || 0)) out[k][day] = v;
      }
    }
    out.categories = mergeById(out.categories, inc.categories);
    { // older installs seeded default presets with random ids: hide exact duplicates
      const seen = new Set();
      out.presets.forEach((p) => { if (p.deleted) return; const k = [p.name, p.type, p.topic, p.minutes].join('|'); if (seen.has(k)) { p.deleted = true; p.updatedAt = Date.now(); } else seen.add(k); });
    }
    // the running timer is shared: the most recent start/pause/stop wins
    if ((inc.timerUpdatedAt || 0) > (out.timerUpdatedAt || 0)) { out.timer = inc.timer || null; out.timerUpdatedAt = inc.timerUpdatedAt; }
    if ((inc.settings.updatedAt || 0) > (out.settings.updatedAt || 0)) out.settings = inc.settings;
    return out;
  }

  let data;
  const ui = {
    page: 'today',
    date: todayStr(),
    tt: { date: null, view: 'list', scope: 'onward', scrollNow: false },
    jr: { q: '', month: 'all' },
    donut: { mode: 'type', sel: null },
    imp: { text: false },
    lib: { org: false, sel: [] },
    rw: { open: {}, logAll: false, set: (() => { try { return localStorage.getItem('st-pt-set') === '1'; } catch (e) { return false; } })() },
    form: { type: 'study', topic: '', priority: 'medium', mode: 'stopwatch', minutes: 25 },
    prog: { mode: 'month', month: todayStr().slice(0, 7), anchor: todayStr(), from: addDays(todayStr(), -29), to: todayStr(), incOther: false, open: {} }
  };

  let saveTimer;
  function persist(immediate) {
    clearTimeout(saveTimer);
    if (immediate) store.save(data);
    else saveTimer = setTimeout(() => store.save(data), 300);
    scheduleSync();
  }

  // =====================================================================
  //  SYNC – a private GitHub Gist in the user's own account holds one JSON
  //  copy of the data. Every device merges with it (newest edit wins).
  // =====================================================================
  const SYNC_KEY = 'studytracker-sync';
  const GIST_FILE = 'studytracker-data.json';
  const sync = { token: '', gistId: '', last: 0, status: '', busy: false, again: false };
  try { Object.assign(sync, JSON.parse(localStorage.getItem(SYNC_KEY) || '{}'), { busy: false, again: false, status: '' }); } catch { /* ignore */ }
  const saveSyncCfg = () => { try { localStorage.setItem(SYNC_KEY, JSON.stringify({ token: sync.token, gistId: sync.gistId, last: sync.last })); } catch { /* ignore */ } };
  const syncText = () => sync.status || (sync.last ? 'Last synced ' + new Date(sync.last).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'Not synced yet');
  function setSyncStatus(s) { sync.status = s; const el = $('#sync-status-text'); if (el) el.textContent = syncText(); }

  async function gh(path, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + sync.token };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch('https://api.github.com' + path, Object.assign({}, opts, { headers }));
    if (!r.ok) {
      const e = new Error(r.status === 401 ? 'GitHub rejected the token' : r.status === 403 ? 'GitHub refused (rate limit or token permissions)' : 'GitHub error ' + r.status);
      e.status = r.status; throw e;
    }
    return r.json();
  }
  async function findGist() {
    for (let page = 1; page <= 5; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      const hit = list.find((g) => g.files && g.files[GIST_FILE]);
      if (hit) return hit.id;
      if (list.length < 100) break;
    }
    return '';
  }
  async function readGist(id) {
    const g = await gh('/gists/' + id);
    const f = g.files && g.files[GIST_FILE];
    if (!f) return null;
    const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    try { return JSON.parse(text); } catch { return null; }
  }
  const syncPayload = (d) => JSON.stringify({ version: 1, topics: d.topics, subjects: d.subjects, rewards: d.rewards, redemptions: d.redemptions, pointsCfg: d.pointsCfg, pointsLog: d.pointsLog, loans: d.loans, repayments: d.repayments, presets: d.presets, sessions: d.sessions, journal: d.journal, important: d.important, rest: d.rest, checkins: d.checkins, plans: d.plans, templates: d.templates, categories: d.categories, timer: d.timer || null, timerUpdatedAt: d.timerUpdatedAt || 0, settings: d.settings });

  async function runSync() {
    if (!sync.token) return;
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true; setSyncStatus('Syncing…');
    try {
      if (!sync.gistId) sync.gistId = await findGist();
      const remote = sync.gistId ? await readGist(sync.gistId) : null;
      const before = syncPayload(data);
      if (remote) data = mergeData(data, remote);
      const merged = syncPayload(data);
      const changedHere = merged !== before;
      const remoteText = remote ? syncPayload(normalize(JSON.parse(JSON.stringify(remote)))) : '';
      if (!sync.gistId) {
        const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Study Tracker data (do not edit)', public: false, files: { [GIST_FILE]: { content: merged } } }) });
        sync.gistId = g.id;
      } else if (merged !== remoteText) {
        await gh('/gists/' + sync.gistId, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: merged } } }) });
      }
      sync.last = Date.now(); saveSyncCfg(); store.save(data);
      setSyncStatus('');
      if (changedHere) {
        const busyInput = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') || $('#modal-root').innerHTML;
        if (!busyInput) render();
      }
    } catch (e) {
      if (e.status === 401) { sync.token = ''; saveSyncCfg(); setSyncStatus('GitHub rejected the token – please reconnect'); if (ui.page === 'library') render(); }
      else setSyncStatus(e instanceof TypeError ? 'Offline – will sync when back online' : 'Sync failed: ' + e.message);
    } finally {
      sync.busy = false;
      if (sync.again) { sync.again = false; scheduleSync(); }
    }
  }
  let syncTimer;
  function scheduleSync() {
    if (!sync.token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, 4000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) runSync(); });
  window.addEventListener('online', () => runSync());
  setInterval(() => { if (!document.hidden) runSync(); }, 45000);

  function syncCard() {
    if (!sync.token) {
      return `<div class="card">
        <h2>Sync phone &amp; PC</h2>
        <p class="note">Keeps the same data on all your devices, stored as a <b>private</b> file in your own GitHub account. One-time setup:</p>
        <ol class="note steps">
          <li><a href="https://github.com/settings/tokens/new?scopes=gist&description=Study%20Tracker" target="_blank" rel="noopener">Open this link</a>, set Expiration to <b>No expiration</b>, leave only <b>gist</b> ticked, and press <b>Generate token</b>.</li>
          <li>Copy the token (starts with <code>ghp_</code>) and paste it below.</li>
          <li>On your other device, paste the <b>same token</b>.</li>
        </ol>
        <div class="field"><label>GitHub token</label><input type="password" id="s-token" placeholder="ghp_…" autocomplete="off"></div>
        <button class="btn primary" data-action="sync-connect">Connect &amp; sync</button>
      </div>`;
    }
    return `<div class="card">
      <h2>Sync phone &amp; PC <small>connected</small></h2>
      <div class="sync-status"><span class="dot"></span><span id="sync-status-text">${esc(syncText())}</span></div>
      <div class="row"><button class="btn primary" data-action="sync-now">Sync now</button><button class="btn danger" data-action="sync-off">Disconnect</button></div>
      <p class="note" style="margin-top:12px">Syncs automatically a few seconds after each change, and whenever you come back to the app. Disconnecting keeps all data on this device.</p>
    </div>`;
  }
  window.addEventListener('beforeunload', () => { try { store.saveSync(data); } catch { /* ignore */ } });

  // ---------- toast / modal ----------
  let toastT, toastUndo = null;
  function toast(msg, undo) {
    const t = $('#toast');
    toastUndo = undo || null;
    t.innerHTML = esc(msg) + (undo ? ' <button class="toast-undo" data-action="toast-undo">Undo</button>' : '');
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; toastUndo = null; }, undo ? 8000 : 2600);
  }
  function openModal(title, body, onSave, saveLabel = 'Save') {
    $('#modal-root').innerHTML = `
      <div class="overlay" data-action="modal-bg">
        <div class="modal" role="dialog" aria-label="${esc(title)}">
          <h3>${esc(title)}</h3>
          <div id="modal-body">${body}</div>
          <div class="foot">
            <button class="btn" data-action="modal-close">Cancel</button>
            <button class="btn primary" id="modal-save">${esc(saveLabel)}</button>
          </div>
        </div>
      </div>`;
    $('#modal-save').onclick = () => { if (onSave() !== false) closeModal(); };
    const first = $('#modal-body input, #modal-body select');
    if (first) first.focus();
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && $('#modal-save') && e.target.tagName === 'INPUT') $('#modal-save').click();
    if (e.key === 'Enter' && e.target.id === 'qa') { e.preventDefault(); actions['qa-add'](); }
    if (e.key === 'Enter' && e.target.id === 'imp-new') { e.preventDefault(); actions['imp-add'](); }
  });

  // ---------- timer ----------
  const elapsedMs = (t) => t.accumulatedMs + (t.startedAt ? Date.now() - t.startedAt : 0);

  function startTimer(spec) {
    const topic = (spec.topic || '').trim();
    data.timer = {
      id: uid(), topic, type: spec.type, priority: spec.priority,
      mode: spec.mode, targetSec: spec.mode === 'countdown' ? Math.round(spec.minutes * 60) : 0,
      accumulatedMs: 0, startedAt: Date.now(), startWall: Date.now(), comment: '', alerted: false,
      blockId: spec.blockId || null, planDate: spec.planDate || null, planSec: spec.mode === 'stopwatch' ? Math.round(spec.planSec || 0) : 0
    };
    data.timerUpdatedAt = Date.now();
    persist(true);
    ui.page = 'today'; ui.date = todayStr();
    render();
  }
  function pauseTimer() {
    const t = data.timer; if (!t || !t.startedAt) return;
    t.accumulatedMs = elapsedMs(t); t.startedAt = null; data.timerUpdatedAt = Date.now();
    persist(true); render();
  }
  function resumeTimer() {
    const t = data.timer; if (!t || t.startedAt) return;
    t.startedAt = Date.now(); data.timerUpdatedAt = Date.now();
    persist(true); render();
  }
  function stopTimer(save) {
    const t = data.timer; if (!t) return;
    const secs = Math.round(elapsedMs(t) / 1000);
    let ask = null;
    if (save && t.blockId && secs >= 60) { // stopped early on a timetable block: was the topic finished?
      const pl = resolvePlan(t.planDate), bb = pl.blocks.find((x) => x.id === t.blockId);
      if (bb && kindOf(bb.type) === 'study' && !pl.skipped.includes(bb.id) && !(pl.completed || []).includes(bb.id)) {
        const prior = live(data.sessions).filter((x) => x.planDate === t.planDate && x.blockId === t.blockId).reduce((n, x) => n + x.seconds, 0);
        const total = prior + secs, dur = blockDur(bb) * 60, floor = ptv().earlyFloor / 100;
        if (total < dur * 0.9 && total >= dur * floor) ask = { date: t.planDate, b: bb, total, dur };
      }
    }
    data.timer = null; data.timerUpdatedAt = Date.now();
    if (save && secs >= 1) {
      const name = t.topic || defaultLabel(t.type);
      const sid = t.id ? 'tm-' + t.id : uid(); // same id on every device, so stopping on two devices cannot double-count
      data.sessions = data.sessions.filter((x) => x.id !== sid);
      data.sessions.push(touch({
        id: sid, date: sessionDate(t.type, t.startWall, secs), start: t.startWall, seconds: secs,
        topic: name, type: t.type, priority: t.priority, comment: (t.comment || '').trim(),
        ...(t.blockId ? { blockId: t.blockId, planDate: t.planDate } : {})
      }));
      ensureTopic(t.topic, t.type, t.priority);
      ui.date = sessionDate(t.type, t.startWall, secs);
      toast(`Saved ${short(secs)} of ${name}`);
      const after = () => { if (secs >= 60 && isWork({ type: t.type }) && data.settings.askFocus !== false) setTimeout(() => focusPrompt(sid), 0); };
      if (ask) setTimeout(() => completePrompt(ask.date, ask.b, ask.total, ask.dur, after), 0); else after();
    } else if (save) {
      toast('Too short to save (under 1 second)');
    }
    persist(true); render();
  }
  function ensureTopic(name, type, priority) {
    name = (name || '').trim();
    if (!name || kindOf(type) === 'break' || kindOf(type) === 'sleep') return;
    const ex = live(data.topics).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!ex) data.topics.push(touch({ id: uid(), name, type, priority }));
  }

  // A soft bell: a few sine partials with a quick attack and a long, quiet decay.
  let audioCtx = null;
  function getAudio() {
    try {
      if (!audioCtx) { const C = window.AudioContext || window.webkitAudioContext; if (C) audioCtx = new C(); }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* audio not available */ }
    return audioCtx;
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { getAudio(); }, { passive: true }));
  function ting() {
    const ctx = getAudio();
    try { if (navigator.vibrate) navigator.vibrate([120, 70, 120]); } catch { /* ignore */ }
    if (!ctx) return;
    const bell = (when, vol) => {
      [[1046.5, 1], [2093, 0.32], [3136, 0.1]].forEach(([f, g]) => {
        const o = ctx.createOscillator(), a = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        a.gain.setValueAtTime(0.0001, when);
        a.gain.exponentialRampToValueAtTime(vol * g, when + 0.012);
        a.gain.exponentialRampToValueAtTime(0.0001, when + 1.6);
        o.connect(a); a.connect(ctx.destination);
        o.start(when); o.stop(when + 1.7);
      });
    };
    const t0 = ctx.currentTime + 0.03;
    bell(t0, 0.28); bell(t0 + 0.8, 0.15);
  }

  let lastLive = 0;
  function tick() {
    const t = data && data.timer;
    const mini = $('#mini');
    const nowMs = Date.now();
    if ((ui.page === 'timetable' || ui.page === 'today') && nowMs - lastLive > 30000) {
      lastLive = nowMs;
      const busy = drag || $('#modal-root').innerHTML || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
      if (!busy) { render(); return; }
    }
    if (!t) { mini.hidden = true; return; }
    const el = elapsedMs(t) / 1000;
    const shown = t.mode === 'countdown' ? Math.max(0, t.targetSec - el) : el;
    const over = t.mode === 'countdown' && el >= t.targetSec;
    const pOver = t.mode === 'stopwatch' && t.planSec > 0 && el >= t.planSec;

    if ((over || pOver) && !t.alerted && t.startedAt) {
      t.alerted = true; persist(true);
      if (data.settings.sound !== false && (over || data.settings.blockTing !== false)) ting();
      const label = t.topic || defaultLabel(t.type);
      toast(over ? `Time is up: ${label}` : `Planned time reached: ${label}. Carry on or stop when you are done`);
      try { if ('Notification' in window) { Notification.requestPermission().then((p) => { if (p === 'granted') new Notification('Time is up', { body: label }); }); } } catch { /* ignore */ }
      render();
      return;
    }

    mini.hidden = ui.page === 'today';
    mini.innerHTML = `<div class="m-top"><span class="pulse ${t.startedAt ? '' : 'paused'}"></span>${t.startedAt ? 'Running' : 'Paused'}</div>
      <div class="m-clock">${hms(shown)}</div><div class="m-topic">${esc(t.topic || defaultLabel(t.type))}</div>`;

    const clock = $('#clock');
    if (clock) {
      clock.textContent = hms(over ? el - t.targetSec : shown);
      clock.classList.toggle('over', over);
      const rem = $('#remain');
      if (rem) rem.textContent = t.mode === 'countdown' ? (over ? 'Target reached – overtime' : `of ${short(t.targetSec)} target`) : t.planSec > 0 ? (pOver ? `Stopwatch · ${short(Math.round(el - t.planSec))} past the plan` : `Stopwatch · of ${short(t.planSec)} planned`) : 'Stopwatch';
      const bar = $('#tbar');
      if (bar) bar.style.width = (t.mode === 'countdown' ? Math.min(100, el / t.targetSec * 100) : t.planSec > 0 ? Math.min(100, el / t.planSec * 100) : 0) + '%';
    }
    document.title = `${hms(shown)} · ${t.topic || defaultLabel(t.type)}`;
  }

  // ---------- derived data ----------
  const sessionsOn = (d) => live(data.sessions).filter((s) => s.date === d).sort((a, b) => a.start - b.start);
  function totals(list) {
    const t = { study: 0, break: 0, sleep: 0, neutral: 0 };
    list.forEach((s) => { t[kindOf(s.type)] += s.seconds; });
    return t;
  }
  function streak() {
    const days = new Set(live(data.sessions).filter((s) => kindOf(s.type) === 'study').map((s) => s.date));
    let d = todayStr(), n = 0;
    if (!days.has(d)) d = addDays(d, -1);
    for (let i = 0; i < 4000; i++) {
      if (days.has(d)) n++;
      else if (!isRest(d)) break; // a rest day neither adds to nor breaks the streak
      d = addDays(d, -1);
    }
    return n;
  }
  function topicTotal(name) {
    return live(data.sessions).filter((s) => s.topic.toLowerCase() === name.toLowerCase()).reduce((a, s) => a + s.seconds, 0);
  }

  // =====================================================================
  //  GAPS: time between logged entries counts as break automatically
  // =====================================================================
  const gapCapMin = () => data.settings.gapCapMin || 120;
  function dayStats(d) {
    const list = sessionsOn(d), tot = totals(list), isToday = d === todayStr(), now = Date.now();
    const iv = list.map((s) => ({ s: s.start, e: s.start + s.seconds * 1000, kind: kindOf(s.type) }));
    if (isToday && data.timer) iv.push({ s: data.timer.startWall, e: data.timer.startWall + elapsedMs(data.timer), kind: kindOf(data.timer.type) }); // paused time is not studying
    const sleeps = iv.filter((x) => x.kind === 'sleep').sort((x, y) => (y.e - y.s) - (x.e - x.s));
    const wake = sleeps.length ? sleeps[0].e : null;
    const occ = iv.filter((x) => x.kind !== 'sleep' || (wake !== null && x.s >= wake - 60000 && x !== sleeps[0])).sort((x, y) => x.s - y.s);
    const gaps = [];
    let cursor = wake !== null ? wake : (occ.length ? occ[0].s : null);
    if (cursor !== null) {
      const push = (s, e) => { if (e - s >= 60000) gaps.push({ s, e, sec: Math.round((e - s) / 1000), kind: (e - s) / 1000 <= gapCapMin() * 60 ? 'break' : 'untracked' }); };
      occ.forEach((o) => { if (o.s > cursor) push(cursor, o.s); cursor = Math.max(cursor, o.e); });
      if (isToday && now > cursor) push(cursor, now);
    }
    const gapBreak = gaps.filter((g) => g.kind === 'break').reduce((n, g) => n + g.sec, 0);
    const untracked = gaps.filter((g) => g.kind === 'untracked').reduce((n, g) => n + g.sec, 0);
    return { tot, gaps, gapBreak, untracked };
  }
  function sleepLine(d, ds) {
    const s = ds.tot.sleep;
    return `<div class="sleepline"><span class="tdot" style="background:${cat('sleep').color}"></span>
        <span>${s ? `Slept <b>${short(s)}</b> ${d === todayStr() ? 'last night' : 'that night'}` : 'No sleep logged'}</span>
        <button class="linkbtn" data-action="sleep-log">Log sleep</button></div>
      ${ds.untracked ? `<div class="note" style="margin-top:8px">Untracked: <b>${short(ds.untracked)}</b>. Gaps over ${fmtDur(gapCapMin())} are not counted as break.</div>` : ''}`;
  }

  // =====================================================================
  //  STARTING A TIMER WHILE ONE IS RUNNING
  // =====================================================================
  function choiceModal(title, bodyHtml, buttons) {
    $('#modal-root').innerHTML = `
      <div class="overlay" data-action="modal-bg">
        <div class="modal" role="dialog" aria-label="${esc(title)}">
          <h3>${esc(title)}</h3>
          <div>${bodyHtml}</div>
          <div class="foot wrap">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-ch="${i}">${esc(b.label)}</button>`).join('')}</div>
        </div>
      </div>`;
    $$('[data-ch]').forEach((el) => { el.onclick = () => { closeModal(); const f = buttons[+el.dataset.ch].fn; if (f) f(); }; });
  }
  function requestStart(spec) {
    const t = data.timer;
    if (!t) { startTimer(spec); return; }
    const secs = Math.round(elapsedMs(t) / 1000), sleep = kindOf(t.type) === 'sleep';
    choiceModal('A timer is already running', `
      <p style="line-height:1.55;margin-bottom:6px"><b>${esc(t.topic || defaultLabel(t.type))}</b> <span class="note">(${esc(cat(t.type).name)})</span> has been running for <b>${short(secs)}</b>.</p>
      <p class="note" style="margin-bottom:16px">${sleep ? 'Save it as sleep and start the new timer?' : 'Stop and save it before starting the new timer?'}</p>`, [
      { label: 'Cancel' },
      { label: 'Discard it', cls: 'danger', fn: () => { stopTimer(false); startTimer(spec); } },
      { label: 'Stop & save, then start', cls: 'primary', fn: () => { stopTimer(true); startTimer(spec); } }
    ]);
  }

  // =====================================================================
  //  SLEEP (manual log) and CATEGORIES
  // =====================================================================
  function slInstant(n) {
    const d = $('#sl-d' + n).value, t = $('#sl-t' + n).value;
    if (!d || !t) return NaN;
    const [h, m] = t.split(':').map(Number), x = parseYmd(d); x.setHours(h, m, 0, 0);
    return x.getTime();
  }
  function updateSleepSum() {
    const el = $('#sl-sum'); if (!el) return;
    const a = slInstant(1), b = slInstant(2);
    el.textContent = b > a ? `Sleep: ${short((b - a) / 1000)}` : '';
  }
  function sleepModal() {
    const today = todayStr(), y = addDays(today, -1);
    openModal('Log sleep', `
      <div class="row">
        <div class="field grow"><label>Went to sleep</label><input type="date" id="sl-d1" data-bind="sl-calc" value="${y}"></div>
        <div class="field grow"><label>Time</label><input type="time" id="sl-t1" data-bind="sl-calc" value="23:00"></div>
      </div>
      <div class="row">
        <div class="field grow"><label>Woke up</label><input type="date" id="sl-d2" data-bind="sl-calc" value="${today}"></div>
        <div class="field grow"><label>Time</label><input type="time" id="sl-t2" data-bind="sl-calc" value="06:30"></div>
      </div>
      <div class="note" id="sl-sum" style="margin-bottom:10px"></div>
      <p class="note">Sleep is counted on the day you wake up and is kept out of your study and break totals.</p>`, () => {
      const a = slInstant(1), b = slInstant(2);
      if (!(b > a)) { toast('Wake-up must be after bedtime'); return false; }
      if (b - a < 600000) { toast('Sleep must be at least 10 minutes'); return false; }
      if (b - a > 20 * 3600000) { toast('That is over 20 hours – check the dates'); return false; }
      data.sessions.push(touch({ id: uid(), date: ymd(new Date(b)), start: a, seconds: Math.round((b - a) / 1000), topic: 'Sleep', type: 'sleep', priority: 'low', comment: '' }));
      ui.date = ymd(new Date(b)); ui.page = 'today';
      persist(true); render(); toast(`Logged ${short((b - a) / 1000)} of sleep`);
    }, 'Save sleep');
    updateSleepSum();
  }

  function categoriesCard() {
    return `<div class="card">
      <h2>Categories <button class="btn sm primary" data-action="cat-add">+ New category</button></h2>
      ${cats().map((x) => `
        <div class="list-row">
          <div class="grow"><div class="nm"><span class="tdot" style="background:${x.color}"></span>${esc(x.name)}</div>
            <div class="meta">Counts as ${KINDS[x.kind].toLowerCase()}${LOCKED.includes(x.id) ? ' · built in' : ''}</div></div>
          <button class="btn sm" data-action="cat-edit" data-id="${x.id}">Edit</button>
          ${LOCKED.includes(x.id) ? '' : `<button class="btn sm danger" data-action="cat-del" data-id="${x.id}">Delete</button>`}
        </div>`).join('')}
      <p class="note" style="margin-top:10px"><b>Study</b> counts towards goals and streaks, <b>Break</b> is rest, <b>Sleep</b> is tracked separately, and <b>Neutral</b> is anything else (workout, meals, class…).</p>
    </div>`;
  }
  function catModal(existing) {
    const x = existing || { name: '', color: '#14b8a6', kind: 'neutral' };
    const locked = !!existing && LOCKED.includes(existing.id);
    openModal(existing ? 'Edit category' : 'New category', `
      <div class="field"><label>Name</label><input type="text" id="c-name" value="${esc(x.name)}" placeholder="e.g. Workout, Meals, Class"></div>
      <div class="row">
        <div class="field grow"><label>Colour</label><input type="color" id="c-color" value="${esc(x.color)}"></div>
        <div class="field grow"><label>Counts as</label><select id="c-kind" ${locked ? 'disabled' : ''}>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <p class="note">Study counts towards your daily goal and streak. Break is rest. Sleep is tracked separately. Neutral is everything else.</p>`, () => {
      const name = $('#c-name').value.trim();
      if (!name) { toast('Give the category a name'); return false; }
      if (cats().some((y) => y.name.toLowerCase() === name.toLowerCase() && (!existing || y.id !== existing.id))) { toast('A category with that name already exists'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, { name, color: $('#c-color').value || x.color, kind: locked ? existing.kind : $('#c-kind').value });
      touch(rec);
      if (!existing) data.categories.push(rec);
      persist(true); render();
    });
  }

  // =====================================================================
  //  v4: undo, focus rating, rest days, check-in, quick add, install help
  // =====================================================================
  const boughtRest = (d) => ((data && data.redemptions) || []).some((r) => !r.deleted && r.special === 'rest' && r.date === d);
  const isRest = (d) => !!(data.rest && data.rest[d] && data.rest[d].on) || boughtRest(d);
  const boughtPass = (d) => ((data && data.redemptions) || []).some((r) => !r.deleted && r.special === 'pass' && r.date === d);
  const goalWaived = (d) => isRest(d) || boughtPass(d);
  const weekStart = (d) => addDays(d, -((parseYmd(d).getDay() + 6) % 7));
  const MOODS = [['😞', 'Rough'], ['🙁', 'Low'], ['😐', 'Okay'], ['🙂', 'Good'], ['😄', 'Great']];
  const FOCUS_WORDS = ['Scattered', 'Distracted', 'Okay', 'Focused', 'Deep focus'];

  function softDelete(rec, msg, after) {
    rec.deleted = true; touch(rec);
    if (after) after();
    persist(true); render();
    toast(msg, () => { rec.deleted = false; touch(rec); persist(true); render(); });
  }

  function focusPrompt(id) {
    const s = data.sessions.find((x) => x.id === id);
    if (!s || s.deleted || $('#modal-root').innerHTML) return;
    choiceModal('How focused were you?', `
      <p class="note" style="margin-bottom:12px"><b>${esc(s.topic)}</b> · ${short(s.seconds)}</p>
      <div class="rate big">${[1, 2, 3, 4, 5].map((n) => `<button data-action="set-focus" data-id="${id}" data-v="${n}"><b>${n}</b><span>${FOCUS_WORDS[n - 1]}</span></button>`).join('')}</div>`,
      [{ label: 'Skip' }]);
  }

  function restLine(d) {
    if (!isRest(d)) return '';
    return `<div class="restline"><span class="pill rest">Rest day</span><span class="note">${boughtRest(d) ? 'Bought with points. ' : ''}Your streak is safe.</span></div>`;
  }

  function checkinCard(d) {
    const ci = data.checkins[d] || {}, isToday = d === todayStr();
    const nudge = isToday && new Date().getHours() >= 19 && !ci.mood && !ci.focus;
    const row = (k, items) => items.map(([lab, sub], i) => `<button class="${ci[k] === i + 1 ? 'on' : ''}" data-action="ci-set" data-k="${k}" data-v="${i + 1}" title="${esc(sub)}">${lab}</button>`).join('');
    return `<div class="card ${nudge ? 'nudge' : ''}">
      <h2>Evening check-in <small>${nudge ? 'How did today go?' : isToday ? 'rate your day' : fmtShort(d)}</small></h2>
      <div class="field"><label>Mood</label><div class="rate">${row('mood', MOODS)}</div></div>
      <div class="field" style="margin-bottom:0"><label>Focus today</label><div class="rate">${row('focus', FOCUS_WORDS.map((w, i) => [String(i + 1), w]))}</div></div>
      ${ci.mood || ci.focus ? `<p class="note" style="margin-top:10px">${ci.mood ? MOODS[ci.mood - 1][1] : ''}${ci.mood && ci.focus ? ' · ' : ''}${ci.focus ? FOCUS_WORDS[ci.focus - 1] : ''}. Tap again to clear.</p>` : ''}
    </div>`;
  }

  // ---- quick add: "Chemistry 11:00-12:30", "Physics 2h", "break: tea 15m", "Maths 1h30m at 3pm"
  function parseQuickEntry(input, date) {
    let s = ' ' + String(input || '').trim() + ' ';
    let priority = null, type = null;
    const pm = s.match(/\s!(high|medium|low|h|m|l)\b/i);
    if (pm) { const k = pm[1][0].toLowerCase(); priority = k === 'h' ? 'high' : k === 'l' ? 'low' : 'medium'; s = s.replace(pm[0], ' '); }
    const names = cats().map((x) => x.name).sort((x, y) => y.length - x.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const tm = names.length ? s.trim().match(new RegExp('^(' + names.join('|') + ')\\s*[:\\-]\\s*', 'i')) : null;
    if (tm) { type = cats().find((x) => x.name.toLowerCase() === tm[1].toLowerCase()).id; s = ' ' + s.trim().slice(tm[0].length) + ' '; }
    const to24 = (hh, mm, mer) => { let h = +hh; const m = +(mm || 0); if (mer) { mer = mer.toLowerCase(); h = h % 12 + (mer === 'pm' ? 12 : 0); } return { h, m, mer: !!mer }; };
    let startMin = null, endMin = null, secs = 0, error = '';
    const rg = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|till|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?(?![\d:])/i);
    if (rg && (rg[2] || rg[5] || rg[3] || rg[6])) {
      let x = to24(rg[1], rg[2], rg[3]); const y = to24(rg[4], rg[5], rg[6]);
      if (!x.mer && y.mer) {
        const mer = rg[6].toLowerCase(); x = to24(rg[1], rg[2], mer);
        if (x.h * 60 + x.m >= y.h * 60 + y.m) x = to24(rg[1], rg[2], mer === 'pm' ? 'am' : 'pm');
      }
      if (x.h > 23 || y.h > 23 || x.m > 59 || y.m > 59) error = 'That time is not valid';
      startMin = x.h * 60 + x.m; endMin = y.h * 60 + y.m;
      if (!x.mer && !y.mer && endMin <= startMin && y.h < 12 && endMin + 720 - startMin <= 360) endMin += 720; // "10:00-1:00" means 1 pm
      s = s.replace(rg[0], ' ');
    }
    if (startMin === null) {
      let hrs = 0, mins = 0, found = false;
      const dh = s.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?![a-z])/i);
      if (dh) { hrs = parseFloat(dh[1]); s = s.replace(dh[0], ' '); found = true; }
      const dm = s.match(/(\d+)\s*(?:m|min|mins|minute|minutes)(?![a-z])/i);
      if (dm) { mins = parseInt(dm[1], 10); s = s.replace(dm[0], ' '); found = true; }
      if (found) secs = Math.round(hrs * 3600 + mins * 60);
      const at = s.match(/\bat\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i);
      if (at) { const x = to24(at[1], at[2], at[3]); if (x.h > 23 || x.m > 59) error = 'That time is not valid'; startMin = x.h * 60 + x.m; s = s.replace(at[0], ' '); }
    }
    const topic = s.replace(/\s+/g, ' ').replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
    type = type || 'study';
    const k = kindOf(type);
    if (!priority) {
      const ex = live(data.topics).find((x) => x.name.toLowerCase() === topic.toLowerCase());
      priority = (k === 'break' || k === 'sleep') ? 'low' : ex ? ex.priority : 'medium';
    }
    const out = { topic, type, priority, complete: false, error };
    if (error) return out;
    const base = parseYmd(date);
    const mk = (min) => { const x = new Date(base); x.setHours(0, 0, 0, 0); x.setMinutes(min); return x.getTime(); };
    if (startMin !== null && endMin !== null) {
      out.start = mk(startMin); out.seconds = (endMin - startMin) * 60;
      if (out.seconds <= 0) out.error = 'The end time must be after the start time'; else out.complete = true;
    } else if (startMin !== null && secs) { out.start = mk(startMin); out.seconds = secs; out.complete = true; }
    else if (secs) {
      out.seconds = secs;
      if (date === todayStr()) { out.start = Math.round((Date.now() - secs * 1000) / 60000) * 60000; out.complete = true; } // it just ended
    } else if (startMin !== null) out.start = mk(startMin);
    return out;
  }
  function quickAddBar() {
    return `<div class="qa">
      <input type="text" id="qa" autocomplete="off" placeholder="Quick add for ${ui.date === todayStr() ? 'today' : fmtShort(ui.date)}: Chemistry 11:00-12:30 · Physics 2h · break: tea 15m">
      <button class="btn primary" data-action="qa-add">Add</button>
    </div>`;
  }

  // ---- install help
  const isStandalone = () => !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
  window.addEventListener('appinstalled', () => { deferredInstall = null; if (data) render(); });
  const installDismissed = () => { try { return localStorage.getItem('studytracker-install-dismissed') === '1'; } catch { return false; } };
  function installBanner() {
    if (isStandalone() || installDismissed()) return '';
    if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) return '';
    return `<div class="install">
      <div class="grow"><b>Install Study Tracker</b>
        <div class="note">Opens like an app with no browser bars, and keeps your data from being cleared.</div></div>
      <button class="btn primary sm" data-action="install-now">Install</button>
      <button class="btn sm" data-action="install-dismiss">Not now</button>
    </div>`;
  }
  function installModal() {
    const ios = '<li>Open this page in <b>Safari</b> (not inside another app).</li><li>Tap the <b>Share</b> button (the square with an arrow).</li><li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>';
    const and = '<li>Open this page in <b>Chrome</b>.</li><li>Tap the <b>⋮</b> menu at the top right.</li><li>Tap <b>Install app</b> (or <b>Add to Home screen</b>), then confirm.</li>';
    const pc = '<li>In Chrome or Edge, click the <b>install icon</b> at the right end of the address bar, or open the menu and choose <b>Install Study Tracker</b>.</li>';
    const secs = [['iPhone / iPad', ios], ['Android', and], ['Computer', pc]];
    const first = isIOS() ? 0 : /android/i.test(navigator.userAgent) ? 1 : 2;
    const ordered = [secs[first], ...secs.filter((_, i) => i !== first)];
    choiceModal('Install as an app', `
      <p class="note" style="margin-bottom:12px">It then opens full screen from your home screen, like any other app. Your data stays in sync.</p>
      ${ordered.map(([t, l], i) => `<div class="inst-sec ${i === 0 ? 'first' : ''}"><b>${t}</b><ol>${l}</ol></div>`).join('')}`,
      [{ label: 'Got it', cls: 'primary' }]);
  }
  function installCard() {
    if (isStandalone()) return '<div class="card"><h2>Installed</h2><p class="note">You are using Study Tracker as an installed app.</p></div>';
    return `<div class="card"><h2>Install as an app</h2>
      <p class="note" style="margin-bottom:12px">Add Study Tracker to your phone's home screen or your computer, so it opens full screen like a normal app.</p>
      <button class="btn primary" data-action="install-now">Show me how</button></div>`;
  }

  // ---- weekly review
  function weekStats(from, to) {
    const goal = data.settings.dailyGoalMin * 60, today = todayStr();
    const all = live(data.sessions).filter((s) => s.date >= from && s.date <= to);
    const perDay = {}, sum = { study: 0, break: 0, neutral: 0, sleep: 0 };
    let goalDays = 0, activeDays = 0, restDays = 0, daysElapsed = 0, best = { d: null, sec: 0 }, sleepNights = 0;
    const moods = [], dayFocus = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(from, i), ds = dayStats(d);
      perDay[d] = { study: ds.tot.study, break: ds.tot.break + ds.gapBreak, neutral: ds.tot.neutral, sleep: ds.tot.sleep };
      Object.keys(sum).forEach((k) => { sum[k] += perDay[d][k]; });
      if (d <= today) daysElapsed++;
      if (goal && d <= today && ds.tot.study >= goal) goalDays++;
      if (ds.tot.study > 0) activeDays++;
      if (ds.tot.sleep > 0) sleepNights++;
      if (isRest(d)) restDays++;
      if (ds.tot.study > best.sec) best = { d, sec: ds.tot.study };
      const ci = data.checkins[d]; if (ci && ci.mood) moods.push(ci.mood); if (ci && ci.focus) dayFocus.push(ci.focus);
    }
    const avg = (l) => (l.length ? l.reduce((n, x) => n + x, 0) / l.length : 0);
    const rated = all.filter((s) => s.focus && isWork(s));
    const byTopic = new Map();
    rated.forEach((s) => { const k = s.topic.toLowerCase(), e = byTopic.get(k) || { name: s.topic, sum: 0, n: 0, sec: 0 }; e.sum += s.focus; e.n++; e.sec += s.seconds; byTopic.set(k, e); });
    const focusTop = [...byTopic.values()].filter((e) => e.sec >= 1800).map((e) => ({ ...e, avg: e.sum / e.n })).sort((x, y) => y.avg - x.avg || y.sec - x.sec)[0] || null;
    const longest = all.filter(isWork).sort((x, y) => y.seconds - x.seconds)[0] || null;
    return { all, perDay, sum, goalDays, activeDays, restDays, daysElapsed, best, sleepNights, avgMood: avg(moods), nMood: moods.length, avgDayFocus: avg(dayFocus), avgSession: avg(rated.map((s) => s.focus)), nRated: rated.length, focusTop, longest };
  }
  // The weekly review lives inside Progress (Week mode)
  function weekReview(from) {
    const to = addDays(from, 6), thisWeek = from === weekStart(todayStr());
    const w = weekStats(from, to), p = weekStats(addDays(from, -7), addDays(from, -1));
    const goal = data.settings.dailyGoalMin * 60, diff = w.sum.study - p.sum.study;
    const parts = [];
    parts.push(w.sum.study
      ? `You studied <b>${short(w.sum.study)}</b> ${thisWeek ? 'so far this week' : 'this week'}${p.sum.study ? (diff >= 0 ? `, <b>${short(diff)} more</b> than the week before` : `, <b>${short(-diff)} less</b> than the week before`) : ''}.`
      : 'No study was logged this week.');
    if (goal && w.daysElapsed) parts.push(`You reached your daily goal on <b>${w.goalDays}</b> of ${w.daysElapsed} ${w.daysElapsed === 1 ? 'day' : 'days'}.`);
    if (w.best.sec) parts.push(`Your best day was <b>${fmtDow(w.best.d)}</b> with ${short(w.best.sec)}.`);
    if (w.restDays) parts.push(`${w.restDays} rest ${w.restDays === 1 ? 'day' : 'days'} taken.`);
    const mood = (v) => MOODS[Math.min(4, Math.max(0, Math.round(v) - 1))][0];
    const dayRows = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(from, i), ci = data.checkins[d] || {}, jt = ((data.journal[d] && data.journal[d].text) || '').trim();
      return `<div class="rvrow ${d > todayStr() ? 'future' : ''}" data-action="jr-open" data-date="${d}">
        <div class="rd"><b>${parseYmd(d).toLocaleDateString('en-IN', { weekday: 'short' })}</b><span class="note">${parseYmd(d).getDate()}</span></div>
        <div class="rs">${w.perDay[d].study ? short(w.perDay[d].study) : '–'}</div>
        <div class="rm">${ci.mood ? MOODS[ci.mood - 1][0] : ''}${ci.focus ? `<span class="ftag">F${ci.focus}</span>` : ''}${isRest(d) ? '<span class="pill rest">Rest</span>' : ''}</div>
        <div class="rj note">${jt ? esc(jt.length > 150 ? jt.slice(0, 150) + '…' : jt) : '<i>no journal entry</i>'}</div>
      </div>`;
    }).join('');
    const hi = [];
    if (w.longest) hi.push(`<div class="hl"><span class="k">Longest session</span><b>${esc(w.longest.topic)}</b> · ${short(w.longest.seconds)}</div>`);
    if (w.focusTop) hi.push(`<div class="hl"><span class="k">Most focused topic</span><b>${esc(w.focusTop.name)}</b> · ${w.focusTop.avg.toFixed(1)} / 5</div>`);
    if (w.best.sec) hi.push(`<div class="hl"><span class="k">Best day</span><b>${fmtDow(w.best.d)}</b> · ${short(w.best.sec)}</div>`);
    { const sg = live(data.subjects).length ? subjectGroups(w.all, false).filter((g) => g.id !== '_none')[0] : null; if (sg) hi.push(`<div class="hl"><span class="k">Most studied subject</span><b>${esc(sg.name)}</b> · ${short(sg.sec)}</div>`); }
    return {
      w, p,
      summary: `<div class="card rv-sum"><p>${parts.join(' ')}</p></div>`,
      delta: p.sum.study ? (diff >= 0 ? '+' : '−') + short(Math.abs(diff)) + ' vs last week' : 'no data last week',
      extraTiles: `
          <div class="tile"><div class="k">Goal days</div><div class="v">${w.goalDays}<span style="font-size:14px;color:var(--muted)"> / ${w.daysElapsed}</span></div><div class="s">goal ${short(goal)} a day</div></div>
          <div class="tile"><div class="k">Mood</div><div class="v">${w.nMood ? mood(w.avgMood) : '–'}</div><div class="s">${w.nMood ? w.avgMood.toFixed(1) + ' / 5 · ' + w.nMood + (w.nMood === 1 ? ' check-in' : ' check-ins') : 'no check-ins'}</div></div>`,
      highlights: hi.length ? `<div class="card"><h2>Highlights</h2><div class="hl-row">${hi.join('')}</div></div>` : '',
      days: `<div class="card"><h2>Day by day <small>tap a day to open it</small></h2><div class="rv-days">${dayRows}</div></div>`
    };
  }

  // =====================================================================
  //  v5: donut chart + goal ring (Today), actual timeline
  // =====================================================================
  const DONUT_COLORS = ['#2563eb', '#0ea5e9', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#64748b'];
  function donutSlices(list, ds, mode) {
    const sum = (arr) => arr.reduce((n, s) => n + s.seconds, 0);
    if (mode === 'type') {
      const m = {};
      list.filter((s) => kindOf(s.type) !== 'sleep').forEach((s) => { m[s.type] = (m[s.type] || 0) + s.seconds; });
      if (ds.gapBreak) m.break = (m.break || 0) + ds.gapBreak;
      return Object.entries(m).filter(([, v]) => v > 0)
        .map(([id, v]) => ({ name: cat(id).name + (id === 'break' && ds.gapBreak ? ' (incl. gaps)' : ''), sec: v, color: cat(id).color }))
        .sort((x, y) => y.sec - x.sec);
    }
    const work = list.filter(isWork);
    if (mode === 'subject') return subjectGroups(list, false).map((g) => ({ name: g.name, sec: g.sec, color: g.color }));
    if (mode === 'prio') return Object.entries(PRIOS).map(([k, v]) => ({ name: v.label, sec: sum(work.filter((s) => s.priority === k)), color: v.color })).filter((x) => x.sec > 0);
    const map = new Map();
    work.forEach((s) => { const k = s.topic.toLowerCase(), e = map.get(k) || { name: s.topic, sec: 0 }; e.sec += s.seconds; map.set(k, e); });
    const rows = [...map.values()].sort((x, y) => y.sec - x.sec);
    const top = rows.slice(0, 6).map((e, i) => ({ ...e, color: DONUT_COLORS[i] }));
    const rest = rows.slice(6).reduce((n, e) => n + e.sec, 0);
    if (rest) top.push({ name: 'Others', sec: rest, color: '#cbd5e1' });
    return top;
  }
  function donutCard(list, ds) {
    const mode = ui.donut.mode, slices = donutSlices(list, ds, mode);
    const total = slices.reduce((n, s) => n + s.sec, 0);
    const sel = ui.donut.sel !== null && slices[ui.donut.sel] ? ui.donut.sel : null;
    const R = 60, C = 2 * Math.PI * R;
    let off = 0;
    const arcs = slices.map((s, i) => {
      const len = s.sec / total * C, draw = Math.max(0.5, len - (slices.length > 1 ? 2 : 0));
      const el = `<circle class="dn ${sel !== null && sel !== i ? 'dim' : ''}" data-action="donut-pick" data-i="${i}" cx="80" cy="80" r="${R}" fill="none" stroke="${s.color}" stroke-width="20" stroke-dasharray="${draw} ${C - draw}" stroke-dashoffset="${-off}" transform="rotate(-90 80 80)"><title>${esc(s.name)} · ${short(s.sec)}</title></circle>`;
      off += len; return el;
    }).join('');
    const caption = mode === 'type' ? 'tracked' : mode === 'subject' ? 'study' : 'study + other';
    const centre = sel !== null
      ? `<b>${short(slices[sel].sec)}</b><span>${esc(slices[sel].name)}</span><span>${Math.round(slices[sel].sec / total * 100)}%</span>`
      : `<b>${total ? short(total) : '–'}</b><span>${total ? caption : 'nothing yet'}</span>`;
    const legend = slices.length ? slices.map((s, i) => `
        <div class="dl-row ${sel !== null && sel !== i ? 'dim' : ''}" data-action="donut-pick" data-i="${i}">
          <span class="tdot" style="background:${s.color}"></span><span class="nm">${esc(s.name)}</span><span class="vp"><b>${short(s.sec)}</b><i>${Math.round(s.sec / total * 100)}%</i></span>
        </div>`).join('') : '<div class="note">Log some time and your split shows up here.</div>';
    return `
      <div class="seg donut-filter">
        ${[['type', 'Type'], ...(live(data.subjects).length ? [['subject', 'Subject']] : []), ['topic', 'Topic'], ['prio', 'Importance']].map(([k, l]) => `<button class="${mode === k ? 'on' : ''}" data-action="donut-mode" data-v="${k}">${l}</button>`).join('')}
      </div>
      <div class="donut-wrap">
        <div class="donut"><svg viewBox="0 0 160 160" role="img" aria-label="Time split"><circle cx="80" cy="80" r="${R}" fill="none" stroke="#eef2f7" stroke-width="20"/>${arcs}</svg><div class="dc">${centre}</div></div>
        <div class="dl">${legend}</div>
      </div>`;
  }
  function goalBox(study, goal) {
    if (!goal) return '';
    const pct = Math.min(100, study / goal * 100), R = 30, C = 2 * Math.PI * R;
    return `<div class="goalbox">
      <svg viewBox="0 0 76 76" width="76" height="76" role="img" aria-label="Daily goal progress"><circle cx="38" cy="38" r="${R}" fill="none" stroke="#e8effd" stroke-width="8"/><circle cx="38" cy="38" r="${R}" fill="none" stroke="${pct >= 100 ? '#16a34a' : '#2563eb'}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C * pct / 100} ${C}" transform="rotate(-90 38 38)"/><text x="38" y="43" text-anchor="middle" font-size="15" font-weight="700" fill="#0f172a">${Math.round(pct)}%</text></svg>
      <div><div class="lbl">Daily study goal</div><div class="gv">${short(study)}</div><div class="note">of ${short(goal)}${pct >= 100 ? ' · goal reached' : ''}</div></div>
    </div>`;
  }

  // ---- actual timeline: everything you logged (all categories, sleep, gaps counted as break, the running timer)
  const hmOf = (ms) => { const x = new Date(ms); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
  function actualRaw(W0) {
    const W1 = W0 + 86400000, out = [];
    live(data.sessions).forEach((s) => {
      const st = s.start, en = s.start + s.seconds * 1000;
      if (en > W0 && st < W1) out.push({ id: s.id, topic: s.topic, type: s.type, st, en, linked: !!s.blockId, focus: s.focus, full: s.seconds, run: false });
    });
    const t = data.timer;
    if (t) { const st = t.startWall, en = t.startWall + elapsedMs(t); if (en > W0 && st < W1) out.push({ id: 'timer', topic: t.topic || defaultLabel(t.type), type: t.type, st, en, linked: !!t.blockId, full: Math.round(elapsedMs(t) / 1000), run: true }); }
    return out.sort((x, y) => x.st - y.st || y.en - x.en);
  }
  function actualBlocksHtml(raw, W0, from, tlh) {
    const W1 = W0 + 86400000, now = Date.now(), MIN_VIS = Math.ceil(20 / tlh * 60), cap = gapCapMin() * 60000;
    const clip = (o) => { const s = (Math.max(o.st, W0) - W0) / 60000, e = (Math.min(o.en, W1) - W0) / 60000; return { ...o, s, e, ev: Math.max(e, s + MIN_VIS) }; };
    const gaps = []; let cur = null;
    raw.forEach((o) => { if (cur !== null && o.st - cur >= 60000 && o.st - cur <= cap) gaps.push({ st: cur, en: o.st }); cur = cur === null ? o.en : Math.max(cur, o.en); });
    if (cur !== null && now > cur && now - cur <= cap && now > W0 && now < W1) gaps.push({ st: cur, en: now }); // time since the last entry counts as break too
    const items = raw.map(clip);
    let cluster = [], cEnd = -1, laneEnds = [];
    const flush = () => { const n = Math.max(1, ...cluster.map((i) => i.lane + 1)); cluster.forEach((i) => { i.n = n; }); cluster = []; };
    items.forEach((it) => {
      if (it.s >= cEnd) { flush(); laneEnds = []; cEnd = it.ev; } else cEnd = Math.max(cEnd, it.ev);
      let l = laneEnds.findIndex((e) => e <= it.s);
      if (l < 0) { l = laneEnds.length; laneEnds.push(it.ev); } else laneEnds[l] = it.ev;
      it.lane = l; cluster.push(it);
    });
    flush();
    const gapHtml = gaps.map((g) => { const s = clip(g); return `<div class="ab gap" title="Gap, counted as break · ${hmOf(g.st)}–${hmOf(g.en)}" style="top:${(s.s - from) / 60 * tlh}px;height:${Math.max(2, (s.e - s.s) / 60 * tlh)}px"></div>`; }).join('');
    const blocks = items.map((o) => {
      const label = esc(o.topic || defaultLabel(o.type)), c = cat(o.type);
      const dur = o.run ? 'running' : short(o.full);
      const action = o.run ? 'data-action="nav" data-page="today"' : `data-action="entry-edit" data-id="${o.id}"`;
      return `<div class="ab ${o.run ? 'run' : ''}" ${action} title="${label} · ${hmOf(o.st)}–${hmOf(o.en)} · ${dur}"
        style="--c:${c.color};top:${(o.s - from) / 60 * tlh}px;height:${Math.max(18, (o.e - o.s) / 60 * tlh)}px;left:calc(${o.lane / o.n * 100}% + 2px);width:calc(${100 / o.n}% - 4px)">
        <b>${o.linked ? '⇄ ' : ''}${label}</b><span>${o.st < W0 ? '…' : ''}${hmOf(o.st)}–${hmOf(o.en)}${o.en > W1 ? '…' : ''} · ${dur}${o.focus ? ' · ★' + o.focus : ''}</span></div>`;
    }).join('');
    return gapHtml + blocks;
  }
  function dayTimelineCard(d) {
    const W0 = parseYmd(d).getTime(), isToday = d === todayStr(), tlh = 40;
    const raw = actualRaw(W0);
    const head = `<h2>Your day <small>${isToday ? 'actual · today' : 'actual · ' + fmtShort(d)}</small></h2>`;
    if (!raw.length) return `<div class="card">${head}<div class="note">Everything you log shows up here, hour by hour, including sleep and breaks.</div></div>`;
    const minS = Math.max(0, Math.min(...raw.map((o) => (Math.max(o.st, W0) - W0) / 60000)));
    let maxE = Math.min(1440, Math.max(...raw.map((o) => (Math.min(o.en, W0 + 86400000) - W0) / 60000)));
    if (isToday) maxE = Math.max(maxE, Math.min(1440, (Date.now() - W0) / 60000));
    const from = Math.floor(minS / 60) * 60, to = Math.min(1440, Math.ceil((maxE + 15) / 60) * 60);
    let hours = '';
    for (let i = 0; i <= (to - from) / 60; i++) hours += `<div class="tl-hour" style="top:${i * tlh}px"><span>${pad((from / 60 + i) % 24)}:00</span></div>`;
    let now = '';
    if (isToday) { const m = (Date.now() - W0) / 60000; if (m >= from && m <= to) now = `<div class="tl-now" style="top:${(m - from) / 60 * tlh}px"></div>`; }
    return `<div class="card">${head}<div class="tl compact actual" style="height:${Math.max(120, (to - from) / 60 * tlh)}px">${hours}<div class="tl-lane actual">${actualBlocksHtml(raw, W0, from, tlh)}</div>${now}</div></div>`;
  }

  // =====================================================================
  //  v7: SUBJECTS – group topics (Reasoning, Quant, Hindi…). A topic has at
  //  most one subject; deleting a subject leaves its topics without one.
  // =====================================================================
  function subjectGroups(list, incOther) {
    const tmap = new Map(live(data.topics).map((t) => [t.name.toLowerCase(), t]));
    const smap = new Map(live(data.subjects).map((s) => [s.id, s]));
    const groups = new Map();
    list.filter((s) => (incOther ? isWork(s) : kindOf(s.type) === 'study')).forEach((s) => {
      const t = tmap.get(s.topic.toLowerCase()), sub = t && t.subjectId ? smap.get(t.subjectId) : null;
      const key = sub ? sub.id : '_none';
      const g = groups.get(key) || { id: key, name: sub ? sub.name : 'No subject', color: sub ? sub.color : '#cbd5e1', sec: 0, topics: new Map() };
      const k = s.topic.toLowerCase(), e = g.topics.get(k) || { name: s.topic, sec: 0 };
      g.sec += s.seconds; e.sec += s.seconds; g.topics.set(k, e); groups.set(key, g);
    });
    return [...groups.values()].map((g) => ({ ...g, topics: [...g.topics.values()].sort((x, y) => y.sec - x.sec) }))
      .sort((x, y) => (x.id === '_none') - (y.id === '_none') || y.sec - x.sec);
  }
  function subjectCard(all) {
    const inc = ui.prog.incOther, subs = live(data.subjects);
    const toggle = `<div class="seg sm"><button class="${!inc ? 'on' : ''}" data-action="subj-inc" data-v="0">Study</button><button class="${inc ? 'on' : ''}" data-action="subj-inc" data-v="1">+ Other</button></div>`;
    if (!subs.length) {
      return `<div class="card"><h2>By topic ${toggle}</h2>${topicBreakdown(inc ? all : all.filter((s) => kindOf(s.type) === 'study'))}
        <p class="note" style="margin-top:10px">Too many topics? <button class="linkbtn" data-action="nav" data-page="library">Group them into subjects</button></p></div>`;
    }
    const groups = subjectGroups(all, inc);
    if (!groups.length) return `<div class="card"><h2>By subject ${toggle}</h2><div class="empty"><b>No study data in this range</b>Log some time and it will show up here.</div></div>`;
    const max = groups[0].sec || 1;
    const rows = groups.map((g) => {
      const open = !!ui.prog.open[g.id];
      return `<div class="sg ${open ? 'open' : ''}">
        <div class="hrow sg-head" data-action="subj-toggle" data-id="${g.id}">
          <div class="nm"><span class="caret">›</span><span class="tdot" style="background:${g.color}"></span><span class="t">${esc(g.name)}</span><span class="note" style="margin-left:6px;font-weight:500">${g.topics.length}</span></div>
          <div class="bar"><i style="width:${g.sec / max * 100}%;background:${g.color}"></i></div>
          <div class="val">${short(g.sec)}</div></div>
        ${open ? `<div class="sg-body">${g.topics.map((t) => `
          <div class="hrow sub"><div class="nm" title="${esc(t.name)}">${esc(t.name)}</div><div class="bar"><i style="width:${t.sec / g.sec * 100}%;background:${g.color};opacity:.55"></i></div><div class="val">${short(t.sec)}</div></div>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="card"><h2>By subject ${toggle}</h2>${rows}<p class="note" style="margin-top:8px">Tap a subject to see its topics.</p></div>`;
  }

  function subjectsCard() {
    const subs = live(data.subjects).sort((x, y) => x.name.localeCompare(y.name));
    const count = (id) => live(data.topics).filter((t) => t.subjectId === id).length;
    return `<div class="card">
      <h2>Subjects <button class="btn sm primary" data-action="subj-add">+ New subject</button></h2>
      ${subs.length ? subs.map((s) => `
        <div class="list-row">
          <div class="grow"><div class="nm"><span class="tdot" style="background:${s.color}"></span>${esc(s.name)}</div>
            <div class="meta">${count(s.id)} ${count(s.id) === 1 ? 'topic' : 'topics'}</div></div>
          <button class="btn sm" data-action="subj-edit" data-id="${s.id}">Edit</button>
          <button class="btn sm danger" data-action="subj-del" data-id="${s.id}">Delete</button>
        </div>`).join('')
      : `<div class="empty"><b>No subjects yet</b>Group your topics under main subjects so Progress stays tidy.
          <div style="margin-top:12px"><button class="btn sm" data-action="subj-suggest">Add Reasoning, Quant, Hindi, Accountancy &amp; Computer, Banking Awareness</button></div></div>`}
      <p class="note" style="margin-top:10px">Deleting a subject keeps its topics; they just have no subject.</p>
    </div>`;
  }

  function topicsCard() {
    const topics = live(data.topics).sort((x, y) => x.name.localeCompare(y.name));
    const subs = live(data.subjects).sort((x, y) => x.name.localeCompare(y.name));
    const subIds = new Set(subs.map((s) => s.id));
    const org = ui.lib.org, sel = new Set(ui.lib.sel);
    const opts = (cur) => `<option value="">No subject</option>${subs.map((s) => `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
    const row = (t) => `
      <div class="list-row">
        ${org ? `<input type="checkbox" class="org-ck" data-action="org-pick" data-id="${t.id}" ${sel.has(t.id) ? 'checked' : ''} aria-label="Select ${esc(t.name)}">` : ''}
        <div class="grow"><div class="nm">${typeDot(t.type)}${esc(t.name)}</div>
          <div class="meta">${esc(cat(t.type).name)} · ${short(topicTotal(t.name))} logged in total</div></div>
        ${prioPill(t.priority)}
        ${subs.length && !org ? `<select class="subj-sel" data-change="topic-subject" data-id="${t.id}" aria-label="Subject">${opts(subIds.has(t.subjectId) ? t.subjectId : '')}</select>` : ''}
        ${org ? '' : `<button class="btn sm" data-action="topic-edit" data-id="${t.id}">Edit</button>
        <button class="btn sm danger" data-action="topic-del" data-id="${t.id}">Delete</button>`}
      </div>`;
    let body;
    if (!topics.length) body = '<div class="empty"><b>No saved topics yet</b>Add one here, or just start a timer – new topics are saved automatically.</div>';
    else if (!subs.length) body = topics.map(row).join('');
    else {
      const groups = [...subs.map((s) => ({ name: s.name, color: s.color, list: topics.filter((t) => t.subjectId === s.id) })),
        { name: 'No subject', color: '#cbd5e1', list: topics.filter((t) => !subIds.has(t.subjectId)) }].filter((g) => g.list.length);
      body = groups.map((g) => `<div class="grp-head"><span class="tdot" style="background:${g.color}"></span>${esc(g.name)}<small>${g.list.length} ${g.list.length === 1 ? 'topic' : 'topics'} · ${short(g.list.reduce((n, t) => n + topicTotal(t.name), 0))}</small></div>${g.list.map(row).join('')}`).join('');
    }
    const bar = org ? `<div class="org-bar"><span>${sel.size} selected</span>
        <select id="org-target">${opts('')}</select>
        <button class="btn sm primary" data-action="org-apply">Move</button>
        <button class="btn sm" data-action="org-toggle">Done</button></div>` : '';
    return `<div class="card">
      <h2>Topics <span class="row tight">${subs.length && topics.length ? `<button class="btn sm ${org ? 'on' : ''}" data-action="org-toggle">${org ? 'Done' : 'Organise'}</button>` : ''}<button class="btn sm primary" data-action="topic-add">+ New topic</button></span></h2>
      ${bar}${body}
    </div>`;
  }

  function subjectModal(existing) {
    const x = existing || { name: '', color: DONUT_COLORS[live(data.subjects).length % DONUT_COLORS.length] };
    openModal(existing ? 'Edit subject' : 'New subject', `
      <div class="field"><label>Name</label><input type="text" id="sj-name" value="${esc(x.name)}" placeholder="e.g. Reasoning"></div>
      <div class="field"><label>Colour</label><input type="color" id="sj-color" value="${esc(x.color)}"></div>`, () => {
      const name = $('#sj-name').value.trim();
      if (!name) { toast('Give the subject a name'); return false; }
      if (live(data.subjects).some((s) => s.name.toLowerCase() === name.toLowerCase() && (!existing || s.id !== existing.id))) { toast('A subject with that name already exists'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, { name, color: $('#sj-color').value || x.color });
      touch(rec);
      if (!existing) data.subjects.push(rec);
      persist(true); render();
    });
  }

  // =====================================================================
  //  TODAY PAGE
  // =====================================================================
  function pageToday() {
    const d = ui.date, isToday = d === todayStr();
    const list = sessionsOn(d);
    const ds = dayStats(d), tot = ds.tot;
    const goal = data.settings.dailyGoalMin * 60;
    const pct = goal ? Math.min(100, tot.study / goal * 100) : 0;
    const journal = (data.journal[d] && data.journal[d].text) || '';

    return `
      <div class="page-head">
        <div>
          <h1>${fmtDow(d)}${isToday ? '<span class="today-pill">TODAY</span>' : ''}</h1>
          <p class="sub">${fmtLong(d)}</p>
        </div>
        <div class="datenav">
          <button class="btn icon" data-action="date-prev" title="Previous day" aria-label="Previous day">${chev('left')}</button>
          <input type="date" data-change="date-pick" value="${d}">
          <button class="btn icon" data-action="date-next" title="Next day" aria-label="Next day">${chev('right')}</button>
          ${isToday ? '' : '<button class="btn" data-action="date-today">Today</button>'}
        </div>
      </div>
      ${installBanner()}
      <div class="grid">
        <div class="stack">
          <div class="card">${timerCard()}</div>
          ${upNextCard()}
          ${dayTimelineCard(d)}
        </div>
        <div class="stack">
          <div class="card">
            <h2>Summary <small>${list.length} ${list.length === 1 ? 'entry' : 'entries'}</small></h2>
            ${donutCard(list, ds)}
            ${goalBox(tot.study, goal)}
            ${sleepLine(d, ds)}
            ${restLine(d)}
          </div>
          <div class="card">
            <h2>Journal <button class="linkbtn" data-action="nav" data-page="journal">All entries →</button></h2>
            <textarea data-bind="journal" placeholder="How did the day go? What clicked, what to revisit…">${esc(journal)}</textarea>
            <p class="note" style="margin-top:8px">Saved automatically. Every day's entry is kept on the <b>Journal</b> page.</p>
          </div>
          ${checkinCard(d)}
        </div>
      </div>
      <div class="card" style="margin-top:20px">
        <h2>Activity log <button class="btn sm primary" data-action="entry-add">+ Add entry</button></h2>
        ${quickAddBar()}
        ${logTable(list, ds)}
      </div>`;
  }

  function timerCard() {
    const t = data.timer;
    if (t) {
      const label = t.topic || defaultLabel(t.type);
      return `
        <div class="timer-run">
          <div class="what">${esc(label)}</div>
          <div class="badges">
            <span class="pill" style="background:#eff6ff;color:${cat(t.type).color}">${esc(cat(t.type).name)}</span>
            ${prioPill(t.priority)}
            ${t.blockId ? '<span class="pill" style="background:#eff6ff;color:#1d4ed8">From timetable</span>' : ''}
          </div>
          <div class="clock ${t.startedAt ? '' : 'paused'}" id="clock">00:00:00</div>
          <div class="remain" id="remain"></div>
          <div class="bar"><i id="tbar" style="width:0%"></i></div>
          <div class="timer-actions">
            ${t.startedAt
              ? '<button class="btn big" data-action="pause">Pause</button>'
              : '<button class="btn big primary" data-action="resume">Resume</button>'}
            ${t.mode === 'countdown' ? '<button class="btn big" data-action="extend">+10 min</button>' : ''}
            <button class="btn big primary" data-action="stop">${kindOf(t.type) === 'sleep' ? 'Woke up &amp; save' : 'Stop &amp; save'}</button>
            <button class="btn big danger" data-action="discard">Discard</button>
          </div>
          <input type="text" data-bind="run-comment" placeholder="Add a comment (optional)" value="${esc(t.comment)}">
        </div>`;
    }

    const f = ui.form, fk = kindOf(f.type);
    const topics = live(data.topics).filter((x) => x.type === f.type);
    const presets = live(data.presets);
    return `
      <h2>Start a timer</h2>
      <div class="field">
        <label>Activity</label>
        <div class="seg">
          ${cats().map((x) => `<button class="${f.type === x.id ? 'on' : ''}" data-action="set-type" data-v="${esc(x.id)}"><span class="dot" style="background:${x.color}"></span>${esc(x.name)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>${fk === 'break' || fk === 'sleep' ? 'Label (optional)' : 'Topic'}</label>
        <input type="text" id="f-topic" list="topic-list" data-bind="f-topic" data-change="f-topic-change" autocomplete="off"
          placeholder="${fk === 'break' ? 'e.g. Tea, walk, lunch' : fk === 'sleep' ? 'e.g. Night sleep, nap' : 'Type a topic or pick a saved one'}" value="${esc(f.topic)}">
        <datalist id="topic-list">${topics.map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist>
      </div>
      <div class="field">
        <label>Importance</label>
        <div class="seg">
          ${Object.entries(PRIOS).map(([k, v]) => `<button class="${f.priority === k ? 'on' : ''}" data-action="set-prio" data-v="${k}"><span class="dot" style="background:${v.color}"></span>${v.label}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Timer</label>
        <div class="row">
          <div class="seg">
            <button class="${f.mode === 'stopwatch' ? 'on' : ''}" data-action="set-mode" data-v="stopwatch">Stopwatch</button>
            <button class="${f.mode === 'countdown' ? 'on' : ''}" data-action="set-mode" data-v="countdown">Countdown</button>
          </div>
          ${f.mode === 'countdown' ? `<div class="row tight"><input type="number" min="1" max="600" style="width:84px" data-bind="f-minutes" value="${f.minutes}"><span class="note">minutes</span></div>` : ''}
        </div>
      </div>
      ${presets.length ? `
      <div class="field">
        <label>Presets</label>
        <div class="chips">${presets.map((p) => `<button class="chip" data-action="use-preset" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      </div>` : ''}
      <button class="btn primary big" data-action="start">Start</button>
      <div class="row tight" style="margin-top:14px">
        <button class="btn" data-action="go-sleep">Going to sleep</button>
        <button class="btn" data-action="sleep-log">Log sleep</button>
      </div>`;
  }

  function logTable(list, ds) {
    const gaps = ds ? ds.gaps : [];
    if (!list.length && !gaps.length) return `<div class="empty"><b>Nothing logged yet</b>Start the timer above, or add an entry manually.</div>`;
    const rows = [...list.map((s) => ({ t: s.start, s })), ...gaps.map((g) => ({ t: g.s, g }))].sort((x, y) => x.t - y.t);
    let n = 0;
    const body = rows.map((r) => {
      if (r.g) {
        const g = r.g, auto = g.kind === 'break';
        return `
            <tr class="gap-row">
              <td class="num"></td>
              <td><div class="topic-cell"><span class="tdot" style="background:${auto ? KIND_COLOR.break : '#cbd5e1'}"></span>${auto ? 'Gap, counted as break' : 'Untracked'} <span class="note" style="margin-left:6px">${fmtTime(g.s)}–${fmtTime(g.e)}</span></div></td>
              <td>${fmtTime(g.s)}</td>
              <td></td>
              <td class="dur">${hms(g.sec)}</td>
              <td class="cmt"></td>
              <td class="act">
                ${auto ? '' : `<button class="btn sm" data-action="gap-break" data-s="${g.s}" data-e="${g.e}">Count as break</button>`}
                <button class="btn sm" data-action="gap-label" data-s="${g.s}" data-e="${g.e}">Label</button>
              </td>
            </tr>`;
      }
      const s = r.s;
      return `
            <tr>
              <td class="num">${++n}</td>
              <td><div class="topic-cell">${typeDot(s.type)}${esc(s.topic)}${s.focus ? `<span class="ftag" title="Focus ${s.focus} of 5">★${s.focus}</span>` : ''}</div></td>
              <td>${fmtTime(s.start)}</td>
              <td>${prioPill(s.priority)}</td>
              <td class="dur">${hms(s.seconds)}</td>
              <td class="cmt" title="${esc(s.comment)}">${esc(s.comment)}</td>
              <td class="act">
                <button class="btn sm" data-action="entry-edit" data-id="${s.id}">Edit</button>
                <button class="btn sm danger" data-action="entry-del" data-id="${s.id}">Delete</button>
              </td>
            </tr>`;
    }).join('');
    return `
      <div class="tbl-scroll"><table class="tbl">
        <thead><tr><th>#</th><th>Topic</th><th>Time</th><th>Priority</th><th>Duration</th><th>Comment</th><th></th></tr></thead>
        <tbody>${body}
        </tbody>
      </table></div>`;
  }

  function chev(dir) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}"/></svg>`;
  }

  // ---------- entry modal (add / edit) ----------
  function entryModal(existing, pre) {
    const s = existing || Object.assign({
      type: 'study', topic: '', priority: 'medium', seconds: 1800, comment: '',
      start: (() => { const n = new Date(); const base = parseYmd(ui.date); base.setHours(n.getHours(), n.getMinutes(), 0, 0); return base.getTime(); })()
    }, pre || {});
    const startD = new Date(s.start);
    const body = `
      <div class="field"><label>Activity</label>
        <select id="m-type">${optHtml(s.type)}</select></div>
      <div class="field"><label>Topic</label>
        <input type="text" id="m-topic" list="m-topics" value="${esc(s.topic || '')}" placeholder="Topic or label" autocomplete="off">
        <datalist id="m-topics">${live(data.topics).map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div>
      <div class="field"><label>Importance</label>
        <select id="m-prio">${Object.entries(PRIOS).map(([k, v]) => `<option value="${k}" ${s.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="row">
        <div class="field grow"><label>Date</label><input type="date" id="m-date" data-bind="m-calc" value="${ymd(startD)}"></div>
        <div class="field grow"><label>Start time</label><input type="time" id="m-time" data-bind="m-calc" value="${pad(startD.getHours())}:${pad(startD.getMinutes())}"></div>
      </div>
      <div class="row">
        <div class="field grow"><label>Hours</label><input type="number" id="m-h" data-bind="m-calc" min="0" max="23" value="${Math.floor(s.seconds / 3600)}"></div>
        <div class="field grow"><label>Minutes</label><input type="number" id="m-min" data-bind="m-calc" min="0" max="59" value="${Math.floor(s.seconds % 3600 / 60)}"></div>
      </div>
      <div class="row tight" style="margin:-4px 0 6px">
        <button class="btn sm" type="button" data-action="m-finished" title="Sets the start time to the current time minus the duration above">Set start = now − duration</button>
        <button class="btn sm" type="button" data-action="m-startnow">Set start = now</button>
      </div>
      <div class="note" id="m-end" style="margin-bottom:14px"></div>
      <div class="field"><label>Comment</label><input type="text" id="m-comment" value="${esc(s.comment)}" placeholder="Optional"></div>
      <div class="field"><label>Focus (optional)</label><select id="m-focus"><option value="">Not rated</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${s.focus === n ? 'selected' : ''}>${n} · ${FOCUS_WORDS[n - 1]}</option>`).join('')}</select></div>
      ${existing && existing.blockId ? linkNote(existing) : ''}
      ${existing ? `<button class="btn danger sm" data-action="entry-del-modal" data-id="${existing.id}">Delete this entry</button>` : ''}`;
    openModal(existing ? 'Edit entry' : 'Add entry', body, () => {
      const type = $('#m-type').value;
      const secs = (parseInt($('#m-h').value, 10) || 0) * 3600 + (parseInt($('#m-min').value, 10) || 0) * 60;
      if (secs < 60) { toast('Enter a duration of at least 1 minute'); return false; }
      const date = $('#m-date').value || ui.date;
      const [hh, mm] = ($('#m-time').value || '00:00').split(':').map(Number);
      const day = parseYmd(date); day.setHours(hh, mm, 0, 0);
      const topic = $('#m-topic').value.trim() || defaultLabel(type);
      const prio = $('#m-prio').value;
      const rec = existing || { id: uid() };
      Object.assign(rec, { date: sessionDate(type, day.getTime(), secs), start: day.getTime(), seconds: secs, topic, type, priority: prio, comment: $('#m-comment').value.trim() });
      { const fv = parseInt($('#m-focus').value, 10); if (fv >= 1 && fv <= 5) rec.focus = fv; else delete rec.focus; }
      touch(rec);
      if (!existing) { data.sessions.push(rec); offerBlockMatch(rec); }
      if ($('#m-topic').value.trim()) ensureTopic($('#m-topic').value, type, prio);
      ui.date = rec.date;
      persist(true); render();
    });
    updateEnd();
  }

  // =====================================================================
  //  PROGRESS PAGE
  // =====================================================================
  function rangeOf() {
    const p = ui.prog;
    if (p.mode === 'week') {
      const a = parseYmd(p.anchor), dow = (a.getDay() + 6) % 7; // Monday = 0
      const from = addDays(p.anchor, -dow), to = addDays(from, 6);
      return { from, to, label: `${fmtShort(from)} – ${fmtShort(to)}` };
    }
    if (p.mode === 'month') {
      const [y, m] = p.month.split('-').map(Number);
      const from = `${y}-${pad(m)}-01`, to = ymd(new Date(y, m, 0));
      return { from, to, label: new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) };
    }
    let from = p.from, to = p.to;
    if (from > to) [from, to] = [to, from];
    return { from, to, label: `${fmtShort(from)} – ${fmtShort(to)}` };
  }
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000) + 1;

  function pageProgress() {
    const p = ui.prog, r = rangeOf();
    const wr = p.mode === 'week' ? weekReview(r.from) : null;
    const all = live(data.sessions).filter((s) => s.date >= r.from && s.date <= r.to);
    const tot = totals(all);
    const nDays = daysBetween(r.from, r.to);
    const today = todayStr();
    const elapsedDays = Math.max(1, Math.min(nDays, daysBetween(r.from, r.to < today ? r.to : today)));
    const perDay = {};
    all.forEach((s) => { (perDay[s.date] = perDay[s.date] || { study: 0, break: 0, neutral: 0, sleep: 0 })[kindOf(s.type)] += s.seconds; });
    let gapSum = 0;
    Object.keys(perDay).forEach((d) => { const g = dayStats(d).gapBreak; perDay[d].break += g; gapSum += g; });
    tot.break += gapSum; // time between entries counts as break
    const sleepNights = Object.values(perDay).filter((x) => x.sleep > 0).length;
    const rated = all.filter((s) => s.focus && isWork(s)), avgFocus = rated.length ? rated.reduce((n, s) => n + s.focus, 0) / rated.length : 0;
    const activeDays = Object.values(perDay).filter((x) => x.study > 0).length;
    let best = null;
    Object.entries(perDay).forEach(([d, x]) => { if (!best || x.study > best.sec) best = { d, sec: x.study }; });

    const controls = `
      <div class="controls">
        <div class="seg">
          ${['week', 'month', 'custom'].map((m) => `<button class="${p.mode === m ? 'on' : ''}" data-action="prog-mode" data-v="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}
        </div>
        ${p.mode === 'custom' ? `
          <input type="date" data-change="prog-from" value="${p.from}"><span class="note">to</span><input type="date" data-change="prog-to" value="${p.to}">`
        : `
          <button class="btn icon" data-action="prog-prev" aria-label="Previous">${chev('left')}</button>
          <div class="range-label">${r.label}</div>
          <button class="btn icon" data-action="prog-next" aria-label="Next">${chev('right')}</button>
          ${p.mode === 'month' ? `<input type="month" data-change="prog-month" value="${p.month}">` : `<input type="date" data-change="prog-anchor" value="${p.anchor}">`}
          <button class="btn" data-action="prog-now">${p.mode === 'month' ? 'This month' : 'This week'}</button>`}
      </div>`;

    return `
      <div class="page-head"><div><h1>Progress</h1><p class="sub">${r.label} · ${nDays} ${nDays === 1 ? 'day' : 'days'}</p></div></div>
      ${controls}
      <div class="stack">
        ${wr ? wr.summary : ''}
        <div class="tiles six">
          <div class="tile"><div class="k">Total study</div><div class="v">${short(tot.study)}</div><div class="s">${wr ? wr.delta : (tot.study / 3600).toFixed(1) + ' hours'}</div></div>
          <div class="tile"><div class="k">Daily average</div><div class="v">${short(tot.study / elapsedDays)}</div><div class="s">over ${elapsedDays} ${elapsedDays === 1 ? 'day' : 'days'}</div></div>
          <div class="tile"><div class="k">Active days</div><div class="v">${activeDays}<span style="font-size:14px;color:var(--muted)"> / ${nDays}</span></div><div class="s">days with study</div></div>
          <div class="tile"><div class="k">Best day</div><div class="v">${best && best.sec ? short(best.sec) : '–'}</div><div class="s">${best && best.sec ? fmtShort(best.d) : 'no data yet'}</div></div>
          <div class="tile"><div class="k">Breaks</div><div class="v">${short(tot.break)}</div><div class="s">${tot.study ? Math.round(tot.break / tot.study * 100) + '% of study' : '–'}</div></div>
          ${adhTile(r)}
          <div class="tile"><div class="k">Avg sleep</div><div class="v">${sleepNights ? short(tot.sleep / sleepNights) : '–'}</div><div class="s">${sleepNights ? 'over ' + sleepNights + (sleepNights === 1 ? ' night' : ' nights') : 'no sleep logged'}</div></div>
          ${wr ? wr.extraTiles : ''}
          ${rated.length ? `<div class="tile"><div class="k">Avg focus</div><div class="v">${avgFocus.toFixed(1)}<span style="font-size:14px;color:var(--muted)"> / 5</span></div><div class="s">${rated.length} rated</div></div>` : ''}
          <div class="tile"><div class="k">Streak</div><div class="v">${streak()}<span style="font-size:14px;color:var(--muted)"> ${streak() === 1 ? 'day' : 'days'}</span></div><div class="s">current</div></div>
        </div>

        <div class="card">
          <h2>${nDays > 62 ? 'Weekly' : 'Daily'} time <small>hours</small></h2>
          <div class="chart-wrap">${barChart(r, perDay, nDays)}</div>
          <div class="legend">${['study', 'break', 'neutral'].map((k) => `<span><span class="tdot" style="background:${KIND_COLOR[k]}"></span>${KLABEL[k]}</span>`).join('')}</div>
        </div>

        ${tot.sleep && nDays <= 62 ? `<div class="card"><h2>Sleep <small>hours per night</small></h2><div class="chart-wrap">${barChart(r, perDay, nDays, ['sleep'])}</div></div>` : ''}

        ${p.mode === 'month' ? `<div class="card"><h2>Calendar <small>darker = more study · click a day to open it</small></h2>${heatmap(r, perDay)}</div>` : ''}

        <div class="two">
          ${subjectCard(all)}
          <div class="card"><h2>By importance <small>study + other</small></h2>${prioBreakdown(all)}<div style="height:18px"></div><h2>Time split</h2>${splitBar(tot)}</div>
        </div>
        ${wr ? wr.highlights + wr.days : ''}
      </div>`;
  }

  function barChart(r, perDay, nDays, keys = ['study', 'break', 'neutral']) {
    const buckets = [];
    const zero = () => Object.fromEntries(keys.map((k) => [k, 0]));
    if (nDays <= 62) {
      for (let i = 0; i < nDays; i++) {
        const d = addDays(r.from, i), x = perDay[d] || {};
        const b = { label: String(parseYmd(d).getDate()), tip: fmtShort(d), ...zero() };
        keys.forEach((k) => { b[k] = x[k] || 0; });
        buckets.push(b);
      }
    } else {
      let cur = r.from;
      while (cur <= r.to) {
        const end = addDays(cur, 6) > r.to ? r.to : addDays(cur, 6);
        const b = { label: fmtShort(cur), tip: `${fmtShort(cur)} – ${fmtShort(end)}`, ...zero() };
        for (let d = cur; d <= end; d = addDays(d, 1)) { const x = perDay[d]; if (x) keys.forEach((k) => { b[k] += x[k] || 0; }); }
        buckets.push(b); cur = addDays(end, 1);
      }
    }
    const narrow = window.innerWidth <= 760;
    const W = narrow ? 400 : 820, H = narrow ? 230 : 250, L = narrow ? 40 : 46, R = 6, T = 12, B = 28;
    const iw = W - L - R, ih = H - T - B;
    const sumOf = (b) => keys.reduce((n, k) => n + b[k], 0);
    const maxH = Math.max(...buckets.map((b) => sumOf(b) / 3600), 0);
    const top = Math.max(1, Math.ceil(maxH));
    const slot = iw / buckets.length, bw = Math.min(36, Math.max(3, slot * 0.64));
    const y = (h) => T + ih - (h / top) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = top * i / 4, yy = y(v);
      g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#e2e8f0" stroke-width="1"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#94a3b8">${+v.toFixed(2)}h</text>`;
    }
    const every = Math.ceil(buckets.length / (narrow ? 8 : 16));
    buckets.forEach((b, i) => {
      const x = L + slot * i + (slot - bw) / 2;
      let acc = 0;
      const tip = `${b.tip}\n` + keys.map((k) => `${KLABEL[k]} ${short(b[k])}`).join(' · ');
      keys.forEach((k, ki) => {
        const h = b[k] / 3600;
        if (h <= 0) return;
        const y1 = y(acc + h), y0 = y(acc);
        g += `<rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1)}" fill="${KIND_COLOR[k]}" rx="${ki === 0 ? 3 : 0}"><title>${esc(tip)}</title></rect>`;
        acc += h;
      });
      if (!acc) g += `<rect x="${x}" y="${y(0) - 2}" width="${bw}" height="2" fill="#e2e8f0"><title>${esc(b.tip)}: nothing logged</title></rect>`;
      if (i % every === 0) g += `<text x="${x + bw / 2}" y="${H - 9}" text-anchor="middle" font-size="11" fill="#64748b">${esc(b.label)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Time per ${nDays > 62 ? 'week' : 'day'}">${g}</svg>`;
  }

  function heatmap(r, perDay) {
    const goal = data.settings.dailyGoalMin * 60 || 4 * 3600;
    const first = parseYmd(r.from), lead = (first.getDay() + 6) % 7;
    const today = todayStr();
    let h = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('');
    h += '<div class="blank"></div>'.repeat(lead);
    const n = daysBetween(r.from, r.to);
    for (let i = 0; i < n; i++) {
      const d = addDays(r.from, i), sec = (perDay[d] || {}).study || 0, ratio = sec / goal;
      const lvl = sec <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.6 ? 2 : ratio < 1 ? 3 : 4;
      h += `<div class="day l${lvl} ${d > today ? 'future' : ''} ${d === today ? 'is-today' : ''} ${isRest(d) ? 'rest' : ''}" data-action="goto-day" data-date="${d}" title="${fmtLong(d)}: ${short(sec)} study${isRest(d) ? ' (rest day)' : ''}">
        <span class="n">${parseYmd(d).getDate()}</span><span class="t">${sec ? short(sec) : isRest(d) ? 'Rest' : ''}</span></div>`;
    }
    const sw = ['#f1f5f9', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8'].map((c) => `<i style="background:${c}"></i>`).join('');
    return `<div class="cal">${h}</div><div class="cal-legend">Less ${sw} More <span style="margin-left:8px">(goal = ${short(goal)})</span> <span style="margin-left:8px"><i class="rest-sw"></i> rest day</span></div>`;
  }

  function topicBreakdown(list) {
    const map = new Map();
    list.filter(isWork).forEach((s) => {
      const k = s.topic.toLowerCase();
      const e = map.get(k) || { name: s.topic, sec: 0, priority: s.priority, last: 0 };
      e.sec += s.seconds;
      if (s.start >= e.last) { e.last = s.start; e.priority = s.priority; }
      map.set(k, e);
    });
    const rows = [...map.values()].sort((a, b) => b.sec - a.sec).slice(0, 10);
    if (!rows.length) return '<div class="empty"><b>No study data in this range</b>Log some time and it will show up here.</div>';
    const max = rows[0].sec;
    return rows.map((e) => `
      <div class="hrow"><div class="nm" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="bar"><i style="width:${e.sec / max * 100}%"></i></div>
        <div class="val">${short(e.sec)}</div></div>`).join('');
  }
  function prioBreakdown(list) {
    const t = { high: 0, medium: 0, low: 0 };
    list.filter(isWork).forEach((s) => { t[s.priority] += s.seconds; });
    const max = Math.max(...Object.values(t), 1);
    return Object.entries(PRIOS).map(([k, v]) => `
      <div class="hrow"><div class="nm">${prioPill(k)}</div>
        <div class="bar"><i style="width:${t[k] / max * 100}%;background:${v.color}"></i></div>
        <div class="val">${short(t[k])}</div></div>`).join('');
  }
  function splitBar(tot) {
    const ks = ['study', 'break', 'neutral'], sum = ks.reduce((n, k) => n + tot[k], 0);
    if (!sum) return '<div class="note">Nothing logged in this range.</div>';
    return `<div class="stackbar">${ks.map((k) => `<i style="width:${tot[k] / sum * 100}%;background:${KIND_COLOR[k]}" title="${KLABEL[k]} ${short(tot[k])}"></i>`).join('')}</div>
      <div class="legend">${ks.map((k) => `<span><span class="tdot" style="background:${KIND_COLOR[k]}"></span>${KLABEL[k]} ${Math.round(tot[k] / sum * 100)}%</span>`).join('')}</div>`;
  }

  // =====================================================================
  //  TOPICS & PRESETS PAGE
  // =====================================================================
  function pageLibrary() {
    const topics = live(data.topics).sort((a, b) => a.name.localeCompare(b.name));
    const presets = live(data.presets);
    return `
      <div class="page-head"><div><h1>Topics &amp; Presets</h1><p class="sub">Save what you study and how you like to time it</p></div></div>
      <div class="grid">
        <div class="stack">
          ${subjectsCard()}
          ${topicsCard()}
          ${categoriesCard()}
        </div>
        <div class="stack">
          <div class="card">
            <h2>Presets <button class="btn sm primary" data-action="preset-add">+ New preset</button></h2>
            ${presets.length ? presets.map((p) => `
              <div class="list-row">
                <div class="grow"><div class="nm">${typeDot(p.type)}${esc(p.name)}</div>
                  <div class="meta">${prioPill(p.priority)} ${p.minutes ? p.minutes + ' min' : 'Stopwatch'}${p.topic ? ' · ' + esc(p.topic) : ''}</div></div>
                <button class="btn sm primary" data-action="preset-start" data-id="${p.id}">Start</button>
                <button class="btn sm" data-action="preset-edit" data-id="${p.id}">Edit</button>
                <button class="btn sm danger" data-action="preset-del" data-id="${p.id}">Delete</button>
              </div>`).join('') : '<div class="empty"><b>No presets</b>A preset remembers a topic, importance and duration.</div>'}
          </div>
          ${syncCard()}
          ${installCard()}
          <div class="card">
            <h2>Settings &amp; backup</h2>
            <div class="field"><label>Daily study goal (minutes)</label>
              <input type="number" min="0" max="1440" step="15" data-change="goal" value="${data.settings.dailyGoalMin}"></div>
            <div class="field"><label>Longest gap counted as break (minutes)</label>
              <input type="number" min="10" max="720" step="10" data-change="gap-cap" value="${gapCapMin()}"></div>
            <div class="field"><label class="chk"><input type="checkbox" data-change="ask-focus" ${data.settings.askFocus !== false ? 'checked' : ''}> Ask for a focus rating when I stop a timer</label></div>
            <div class="field"><label class="chk"><input type="checkbox" data-change="sound" ${data.settings.sound !== false ? 'checked' : ''}> Play a soft bell when a countdown ends</label>
              <div><button class="btn sm" data-action="sound-test">Play sound</button></div></div>
            <div class="field"><label>Start timetable blocks as</label>
              <select data-change="block-mode"><option value="stopwatch" ${data.settings.blockMode !== 'countdown' ? 'selected' : ''}>Stopwatch (counts up, never stops on its own)</option><option value="countdown" ${data.settings.blockMode === 'countdown' ? 'selected' : ''}>Countdown to the block's end</option></select></div>
            <div class="field"><label class="chk"><input type="checkbox" data-change="block-ting" ${data.settings.blockTing !== false ? 'checked' : ''}> Soft bell when a stopwatch block reaches its planned time</label></div>
            <div class="row">
              <button class="btn" data-action="export">Export backup</button>
              <button class="btn" data-action="import">Import &amp; merge</button>
            </div>
            <p class="note" style="margin-top:12px">Backups are plain JSON. Importing <b>merges</b> by record, so nothing is overwritten blindly – the same file format is used for syncing between devices.</p>
            <p class="note" id="loc" style="margin-top:8px"></p>
          </div>
        </div>
      </div>`;
  }

  function topicModal(existing) {
    const t = existing || { name: '', type: 'study', priority: 'medium' };
    openModal(existing ? 'Edit topic' : 'New topic', `
      <div class="field"><label>Name</label><input type="text" id="t-name" value="${esc(t.name)}" placeholder="e.g. Organic Chemistry"></div>
      <div class="field"><label>Type</label><select id="t-type">${cats().filter((x) => x.kind === 'study' || x.kind === 'neutral').map((x) => `<option value="${esc(x.id)}" ${t.type === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      ${live(data.subjects).length ? `<div class="field"><label>Subject</label><select id="t-subj"><option value="">No subject</option>${live(data.subjects).sort((x, y) => x.name.localeCompare(y.name)).map((s) => `<option value="${s.id}" ${t.subjectId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Default importance</label><select id="t-prio">${Object.entries(PRIOS).map(([k, v]) => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>`,
    () => {
      const name = $('#t-name').value.trim();
      if (!name) { toast('Give the topic a name'); return false; }
      const dup = live(data.topics).find((x) => x.name.toLowerCase() === name.toLowerCase() && (!existing || x.id !== existing.id));
      if (dup) { toast('A topic with that name already exists'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, { name, type: $('#t-type').value, priority: $('#t-prio').value });
      { const sj = $('#t-subj'); if (sj) { if (sj.value) rec.subjectId = sj.value; else delete rec.subjectId; } }
      touch(rec);
      if (!existing) data.topics.push(rec);
      persist(true); render();
    });
  }

  function presetModal(existing) {
    const p = existing || { name: '', topic: '', type: 'study', priority: 'medium', minutes: 25 };
    openModal(existing ? 'Edit preset' : 'New preset', `
      <div class="field"><label>Preset name</label><input type="text" id="p-name" value="${esc(p.name)}" placeholder="e.g. Physics deep focus"></div>
      <div class="field"><label>Activity</label><select id="p-type">${optHtml(p.type)}</select></div>
      <div class="field"><label>Topic (optional)</label><input type="text" id="p-topic" list="p-topics" value="${esc(p.topic)}" autocomplete="off">
        <datalist id="p-topics">${live(data.topics).map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div>
      <div class="row">
        <div class="field grow"><label>Importance</label><select id="p-prio">${Object.entries(PRIOS).map(([k, v]) => `<option value="${k}" ${p.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
        <div class="field grow"><label>Minutes (0 = stopwatch)</label><input type="number" id="p-min" min="0" max="600" value="${p.minutes}"></div>
      </div>`,
    () => {
      const name = $('#p-name').value.trim();
      if (!name) { toast('Give the preset a name'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, {
        name, type: $('#p-type').value, topic: $('#p-topic').value.trim(), priority: $('#p-prio').value,
        minutes: Math.max(0, parseInt($('#p-min').value, 10) || 0)
      });
      touch(rec);
      if (!existing) data.presets.push(rec);
      persist(true); render();
    });
  }

  // =====================================================================
  //  TIMETABLE
  //  A plan is a list of blocks. Each day can have its own plan; a day with
  //  no plan of its own repeats the most recent earlier plan. The "day"
  //  starts at settings.dayStart (default 05:00), so late-night blocks such
  //  as 00:20–01:20 belong to the evening before.
  // =====================================================================
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const fromMin = (n) => { n = ((Math.round(n) % 1440) + 1440) % 1440; return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`; };
  const anchorMin = () => toMin((data.settings && data.settings.dayStart) || '05:00');
  const offMin = (t) => (toMin(t) - anchorMin() + 1440) % 1440;
  const blockDur = (b) => (toMin(b.end) - toMin(b.start) + 1440) % 1440;
  const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + pad(m % 60) + 'm' : ''}` : `${m}m`);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function anchorMs(date) { const d = parseYmd(date); const m = anchorMin(); d.setHours(Math.floor(m / 60), m % 60, 0, 0); return d.getTime(); }
  function blockTimes(date, b) { const s = anchorMs(date) + offMin(b.start) * 60000; return { startMs: s, endMs: s + blockDur(b) * 60000 }; }
  const sortBlocks = (arr) => [...arr].sort((x, y) => offMin(x.start) - offMin(y.start) || blockDur(y) - blockDur(x));
  function activePlanDate() { const t = todayStr(); return Date.now() < anchorMs(t) ? addDays(t, -1) : t; }
  const ttDate = () => ui.tt.date || (ui.tt.date = activePlanDate());

  const ownPlan = (date) => { const p = data.plans[date]; return p && !p.deleted ? p : null; };
  function resolvePlan(date) {
    const own = ownPlan(date);
    if (own) return { blocks: own.blocks || [], skipped: own.skipped || [], completed: own.completed || [], own: true, from: date };
    let best = null;
    for (const k of Object.keys(data.plans)) {
      const p = data.plans[k];
      if (!p || p.deleted || k >= date) continue;
      if (!best || k > best) best = k;
    }
    if (best) return { blocks: data.plans[best].blocks || [], skipped: [], completed: [], own: false, from: best };
    return { blocks: [], skipped: [], completed: [], own: false, from: null };
  }
  // Apply a change to a day's plan. Scope 'onward' (default): following days
  // keep repeating this plan. Scope 'day': tomorrow is pinned to the old plan.
  function savePlan(date, mutate) {
    const cur = resolvePlan(date);
    const next = { blocks: clone(cur.blocks), skipped: [...cur.skipped], completed: [...(cur.completed || [])] };
    mutate(next);
    if (ui.tt.scope === 'day') {
      const nd = addDays(date, 1);
      if (!ownPlan(nd)) data.plans[nd] = { blocks: clone(cur.blocks), skipped: [], updatedAt: Date.now() };
    }
    data.plans[date] = { blocks: next.blocks, skipped: next.skipped.filter((id) => next.blocks.some((b) => b.id === id)), completed: next.completed.filter((id) => next.blocks.some((b) => b.id === id)), updatedAt: Date.now(), createdAt: (ownPlan(date) || {}).createdAt || Date.now() };
    persist(true); render();
  }

  function blockActual(date, id) {
    let n = live(data.sessions).filter((s) => s.planDate === date && s.blockId === id).reduce((x, s) => x + s.seconds, 0);
    const t = data.timer;
    if (t && t.blockId === id && t.planDate === date) n += Math.round(elapsedMs(t) / 1000); // the running timer fills its block live
    return n;
  }
  function blockStatus(date, b, plan) {
    const dur = blockDur(b) * 60, act = blockActual(date, b.id), { startMs, endMs } = blockTimes(date, b), now = Date.now();
    if (plan.skipped.includes(b.id)) return { key: 'skipped', label: 'Skipped', act };
    if (data.timer && data.timer.blockId === b.id && data.timer.planDate === date) return { key: 'now', label: 'In progress', act };
    if (act >= dur * 0.9) return { key: 'done', label: 'Done', act };
    if ((plan.completed || []).includes(b.id) && act > 0) return { key: 'done', label: 'Done early', act, early: true };
    if (act > 0) return { key: 'partial', label: 'Partial', act };
    if (now > endMs) return { key: 'missed', label: 'Missed', act };
    if (now >= startMs) return { key: 'now', label: 'Now', act };
    return { key: 'upcoming', label: 'Upcoming', act };
  }
  const spill = (st) => `<span class="spill s-${st.key}">${st.label}</span>`;
  function coveredMin(blocks) {
    const iv = blocks.map((b) => [offMin(b.start), Math.min(1440, offMin(b.start) + blockDur(b))]).sort((x, y) => x[0] - y[0]);
    let tot = 0, cs = -1, ce = -1;
    iv.forEach(([s, e]) => { if (s > ce) { if (ce > cs) tot += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e); });
    if (ce > cs) tot += ce - cs;
    return tot;
  }

  // "14:00 to 15:00 Ratio v5", "22:00-23:00 break: Dinner !low" (one per line)
  function parseQuickLines(text) {
    const out = [], bad = [];
    String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
      const m = line.match(/^(\d{1,2})[:.](\d{2})\s*(?:to|till|until|-|–|—)\s*(\d{1,2})[:.](\d{2})\s*(.*)$/i);
      if (!m) { bad.push(line); return; }
      const h1 = +m[1], m1 = +m[2], h2 = +m[3], m2 = +m[4];
      if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) { bad.push(line); return; }
      let rest = m[5].trim(), type = 'study', priority = 'medium';
      const names = cats().map((x) => x.name).sort((x, y) => y.length - x.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const pm = rest.match(/!(high|medium|low|h|m|l)\b/i);
      if (pm) { const k = pm[1].toLowerCase()[0]; priority = k === 'h' ? 'high' : k === 'l' ? 'low' : 'medium'; rest = rest.replace(pm[0], '').trim(); }
      const tm = names.length ? rest.match(new RegExp('^(' + names.join('|') + ')\\s*[:\\-]\\s*', 'i')) : null;
      if (tm) { type = (cats().find((x) => x.name.toLowerCase() === tm[1].toLowerCase()) || { id: 'study' }).id; rest = rest.slice(tm[0].length).trim(); }
      if ((kindOf(type) === 'break' || kindOf(type) === 'sleep') && !pm) priority = 'low';
      const start = `${pad(h1)}:${pad(m1)}`, end = `${pad(h2)}:${pad(m2)}`;
      if (start === end) { bad.push(line); return; }
      out.push({ id: uid(), start, end, topic: rest, type, priority, note: '' });
    });
    return { out, bad };
  }

  function pageTimetable() {
    const date = ttDate(), plan = resolvePlan(date), blocks = sortBlocks(plan.blocks);
    const active = date === activePlanDate();
    const sts = blocks.map((b) => blockStatus(date, b, plan));
    let pStudy = 0, pBreak = 0, doneStudy = 0;
    blocks.forEach((b) => {
      const d = blockDur(b) * 60;
      const bk = kindOf(b.type);
      if (bk === 'study') { pStudy += d; doneStudy += Math.min(d, blockActual(date, b.id)); } else if (bk === 'break') pBreak += d;
    });
    const nDone = sts.filter((s) => s.key === 'done').length;
    const earlier = Object.keys(data.plans).some((k) => k < date && !data.plans[k].deleted);
    const note = plan.own
      ? `Custom plan for this day.${earlier ? ' <button class="linkbtn" data-action="tt-reset">Go back to the previous plan</button>' : ''}`
      : plan.from ? `Repeating the plan from <b>${fmtShort(plan.from)}</b>. Change anything below to customise this day.` : 'No plan yet. Add your first block below.';
    const templates = live(data.templates);
    const v = ui.tt.view;

    const rows = blocks.map((b, i) => {
      const st = sts[i], dur = blockDur(b), canStart = active && st.key !== 'skipped';
      return `
        <div class="blk st-${st.key}">
          <div class="btime">${b.start} – ${b.end}<small>${fmtDur(dur)}</small></div>
          <div class="bmain">
            <div class="btopic">${typeDot(b.type)}${esc(b.topic || defaultLabel(b.type))}</div>
            <div class="bmeta">${prioPill(b.priority)} ${spill(st)} <span>Planned ${fmtDur(dur)}${st.act ? ' · Did ' + short(st.act) : ''}</span></div>
            ${b.note ? `<div class="note" style="margin-top:4px">${esc(b.note)}</div>` : ''}
          </div>
          <div class="bact">
            ${canStart ? `<button class="btn sm primary" data-action="tt-start" data-date="${date}" data-id="${b.id}">${st.act && st.key !== 'done' ? 'Resume' : 'Start'}</button>` : ''}
            ${canStart && st.key !== 'done' ? `<button class="btn sm" data-action="tt-start-alt" data-mode="${data.settings.blockMode === 'countdown' ? 'stopwatch' : 'countdown'}" data-date="${date}" data-id="${b.id}" title="Start this block the other way, just this once">${data.settings.blockMode === 'countdown' ? 'Stopwatch' : 'Countdown'}</button>` : ''}
            ${st.early ? `<button class="btn sm" data-action="tt-reopen" data-date="${date}" data-id="${b.id}">Reopen</button>` : ''}
            <button class="btn sm" data-action="tt-edit" data-id="${b.id}">Edit</button>
            <button class="btn sm" data-action="tt-skip" data-id="${b.id}">${st.key === 'skipped' ? 'Unskip' : 'Skip'}</button>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="page-head">
        <div><h1>Timetable${active ? '<span class="today-pill">TODAY</span>' : ''}</h1><p class="sub">${fmtDow(date)}, ${fmtLong(date)}</p></div>
        <div class="datenav">
          <button class="btn icon" data-action="tt-prev" aria-label="Previous day">${chev('left')}</button>
          <input type="date" data-change="tt-date" value="${date}">
          <button class="btn icon" data-action="tt-next" aria-label="Next day">${chev('right')}</button>
          ${active ? '' : '<button class="btn" data-action="tt-today">Today</button>'}
        </div>
      </div>
      <p class="note tt-note">${note}</p>
      <div class="controls">
        <div class="seg">
          <button class="${v === 'list' ? 'on' : ''}" data-action="tt-view" data-v="list">List</button>
          <button class="${v === 'timeline' ? 'on' : ''}" data-action="tt-view" data-v="timeline">Timeline</button>
        </div>
        <div class="seg" title="Choose whether your edits also change the days after this one">
          <button class="${ui.tt.scope === 'onward' ? 'on' : ''}" data-action="tt-scope" data-v="onward">Edit this day &amp; after</button>
          <button class="${ui.tt.scope === 'day' ? 'on' : ''}" data-action="tt-scope" data-v="day">This day only</button>
        </div>
        <label class="inline-lbl">Day starts <input type="time" data-change="tt-anchor" value="${data.settings.dayStart || '05:00'}" style="width:auto"></label>
      </div>
      <div class="grid">
        <div class="stack">
          <div class="card">
            <h2>Add blocks <small>one per line</small></h2>
            <textarea id="tt-quick" class="tt-quick" placeholder="14:00 to 15:00 Ratio v5&#10;22:00-23:00 break: Dinner !low"></textarea>
            <div class="row" style="margin-top:10px">
              <button class="btn primary" data-action="tt-quick-add">Add</button>
              <button class="btn" data-action="tt-add">Add with form</button>
              <span class="note">Start a line with a category name, like <b>break:</b> or <b>sleep:</b>; add <b>!high</b> or <b>!low</b> for importance.</span>
            </div>
          </div>
          <div class="card">
            <h2>${v === 'list' ? 'Plan' : 'Day timeline'} <small>${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}</small></h2>
            ${!blocks.length ? '<div class="empty"><b>No blocks yet</b>Type lines like <i>14:00 to 15:00 Ratio v5</i> above.</div>' : v === 'list' ? rows : timelineHtml(date, blocks, plan)}
          </div>
        </div>
        <div class="stack">
          ${importantCard()}
          <div class="card">
            <h2>Day summary</h2>
            <div class="tiles">
              <div class="tile"><div class="k">${typeDot('study')}Study</div><div class="v">${short(pStudy)}</div></div>
              <div class="tile"><div class="k">${typeDot('break')}Breaks</div><div class="v">${short(pBreak)}</div></div>
              <div class="tile"><div class="k">Unplanned</div><div class="v">${fmtDur(1440 - coveredMin(blocks))}</div></div>
            </div>
            <div class="goal">
              <div class="gl"><span>Planned study completed</span><span>${short(doneStudy)} / ${short(pStudy)}</span></div>
              <div class="bar"><i style="width:${pStudy ? Math.min(100, doneStudy / pStudy * 100) : 0}%"></i></div>
            </div>
            <p class="note" style="margin-top:10px">${nDone} of ${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'} done</p>
          </div>
          <div class="card">
            <h2>Templates &amp; copy</h2>
            <div class="field"><label>Save this day's plan as a template</label>
              <div class="row tight"><input type="text" id="tpl-name" class="grow" placeholder="e.g. Weekday, Sunday"><button class="btn sm primary" data-action="tpl-save">Save</button></div></div>
            ${templates.length ? templates.map((t) => `
              <div class="list-row">
                <div class="grow"><div class="nm">${esc(t.name)}</div><div class="meta">${t.blocks.length} blocks</div></div>
                <button class="btn sm" data-action="tpl-apply" data-id="${t.id}">Apply</button>
                <button class="btn sm danger" data-action="tpl-del" data-id="${t.id}">Delete</button>
              </div>`).join('') : '<p class="note" style="margin-bottom:12px">No templates yet.</p>'}
            <div class="field" style="margin-top:14px"><label>Copy the plan from another day</label>
              <div class="row tight"><input type="date" id="copy-from" class="grow" value="${addDays(date, -1)}"><button class="btn sm" data-action="tt-copy">Copy</button></div></div>
            <button class="btn sm danger" data-action="tt-clear">Clear this day's plan</button>
          </div>
        </div>
      </div>`;
  }

  // ---- "Important topics" note, shown beside the timetable
  const impItems = () => live(data.important.items).sort((x, y) => (x.order || 0) - (y.order || 0));
  function importantCard() {
    const items = impItems();
    const body = ui.imp.text
      ? `<textarea id="imp-text" rows="10" placeholder="One topic per line">${esc(items.map((i) => i.text).join('\n'))}</textarea>
         <div class="imp-add"><button class="btn sm primary" data-action="imp-text-done">Save list</button><button class="btn sm" data-action="imp-text-cancel">Cancel</button></div>`
      : `<ul class="imp-list">${items.map((i) => `
           <li class="${i.done ? 'done' : ''}">
             <input type="checkbox" data-change="imp-done" data-id="${i.id}" ${i.done ? 'checked' : ''} aria-label="Covered">
             <input class="imp-item" data-bind="imp-item" data-id="${i.id}" value="${esc(i.text)}" aria-label="Topic">
             <button class="imp-x" data-action="imp-del" data-id="${i.id}" aria-label="Remove topic">×</button>
           </li>`).join('')}</ul>
         ${items.length ? '' : '<p class="note imp-empty">Keep the topics you must not forget here: weak areas, formulas to revise, subjects to finish this week.</p>'}
         <div class="imp-add"><input id="imp-new" type="text" placeholder="Add a topic…" autocomplete="off"><button class="btn sm primary" data-action="imp-add">Add</button></div>
         <div class="imp-foot"><button class="linkbtn" data-action="imp-text">Edit as text / paste a list</button>${items.some((i) => i.done) ? '<button class="linkbtn" data-action="imp-clear">Remove ticked</button>' : ''}</div>`;
    return `<div class="card imp">
      <div class="imp-bar"><span></span></div>
      <input class="imp-title" data-bind="imp-title" value="${esc(data.important.title)}" aria-label="Note title">
      ${body}
    </div>`;
  }

  const TL_H = 56; // pixels per hour on the timeline
  function timelineHtml(date, blocks, plan) {
    const MIN_VIS = Math.ceil(24 / TL_H * 60); // shortest drawn block (~24 min tall) so labels stay readable
    const items = blocks.map((b) => { const s = offMin(b.start), e = s + blockDur(b); return { b, s, e, ev: Math.max(e, s + MIN_VIS) }; }).sort((x, y) => x.s - y.s || y.e - x.e);
    const total = Math.max(1440, ...items.map((i) => i.e));
    let cluster = [], cEnd = -1, laneEnds = [];
    const flush = () => { const n = Math.max(1, ...cluster.map((i) => i.lane + 1)); cluster.forEach((i) => { i.n = n; }); cluster = []; };
    items.forEach((it) => {
      if (it.s >= cEnd) { flush(); laneEnds = []; cEnd = it.ev; } else cEnd = Math.max(cEnd, it.ev);
      let l = laneEnds.findIndex((e) => e <= it.s);
      if (l < 0) { l = laneEnds.length; laneEnds.push(it.ev); } else laneEnds[l] = it.ev;
      it.lane = l; cluster.push(it);
    });
    flush();
    let hoursHtml = '';
    for (let i = 0; i <= Math.ceil(total / 60); i++) hoursHtml += `<div class="tl-hour" style="top:${i * TL_H}px"><span>${fromMin(anchorMin() + i * 60)}</span></div>`;
    const blk = items.map(({ b, s, e, lane, n }) => {
      const st = blockStatus(date, b, plan);
      return `<div class="tb st-${st.key}" data-action="tt-edit" data-id="${b.id}" title="${esc(b.topic || defaultLabel(b.type))} · ${st.label}"
        style="--c:${cat(b.type).color};top:${s / 60 * TL_H}px;height:${Math.max(22, (e - s) / 60 * TL_H)}px;left:calc(${lane / n * 100}% + 2px);width:calc(${100 / n}% - 4px)">
        <b>${esc(b.topic || defaultLabel(b.type))}</b><span>${b.start}–${b.end}</span><div class="tb-rs"></div></div>`;
    }).join('');
    let now = '';
    if (date === activePlanDate()) {
      const m = (Date.now() - anchorMs(date)) / 60000;
      if (m >= 0 && m <= total) now = `<div class="tl-now" style="top:${m / 60 * TL_H}px"></div>`;
    }
    return `<p class="note" style="margin-bottom:10px">Drag a block to move it, drag its bottom edge to resize, or tap it to edit.</p>
      <div class="tl" style="height:${total / 60 * TL_H}px">${hoursHtml}<div class="tl-lane">${blk}${now}</div></div>`;
  }

  // drag to move / resize on the timeline (mouse & pen; touch can resize, tap to edit)
  let drag = null, justDragged = false;
  document.addEventListener('pointerdown', (e) => {
    if (ui.page !== 'timetable') return;
    const tb = e.target.closest('.tb'); if (!tb) return;
    const rs = !!e.target.closest('.tb-rs');
    if (!rs && e.pointerType === 'touch') return;
    const date = ttDate(), b = resolvePlan(date).blocks.find((x) => x.id === tb.dataset.id); if (!b) return;
    drag = { id: b.id, date, rs, y0: e.clientY, s0: offMin(b.start), d0: blockDur(b), el: tb, moved: false, ns: offMin(b.start), nd: blockDur(b) };
    try { tb.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    const mins = Math.round(dy / TL_H * 60 / 5) * 5;
    if (drag.rs) { drag.nd = Math.min(1440, Math.max(5, drag.d0 + mins)); drag.ns = drag.s0; drag.el.style.height = Math.max(22, drag.nd / 60 * TL_H) + 'px'; }
    else { drag.ns = Math.min(1435, Math.max(0, drag.s0 + mins)); drag.nd = drag.d0; drag.el.style.top = drag.ns / 60 * TL_H + 'px'; }
    const lab = drag.el.querySelector('span');
    if (lab) lab.textContent = `${fromMin(anchorMin() + drag.ns)}–${fromMin(anchorMin() + drag.ns + drag.nd)}`;
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) return;
    justDragged = true; setTimeout(() => { justDragged = false; }, 120);
    savePlan(d.date, (next) => {
      const b = next.blocks.find((x) => x.id === d.id);
      if (b) { b.start = fromMin(anchorMin() + d.ns); b.end = fromMin(anchorMin() + d.ns + d.nd); }
    });
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'tt-quick') { e.preventDefault(); actions['tt-quick-add'](); }
  });
  // keep statuses ("Upcoming" -> "Now" -> "Missed") fresh while the page is open
  setInterval(() => {
    if (ui.page !== 'timetable' || drag || document.hidden) return;
    const ae = (document.activeElement || {}).tagName || '';
    if (/INPUT|TEXTAREA|SELECT/.test(ae) || $('#modal-root').innerHTML) return;
    render();
  }, 30000);

  function blockModal(date, existing) {
    const now = new Date(), r5 = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
    const b = existing || { start: date === activePlanDate() ? fromMin(r5) : fromMin(anchorMin()), end: '', topic: '', type: 'study', priority: 'medium', note: '' };
    if (!b.end) b.end = fromMin(toMin(b.start) + 60);
    openModal(existing ? 'Edit block' : 'Add block', `
      <div class="field"><label>Topic / activity</label>
        <input type="text" id="b-topic" list="b-topics" value="${esc(b.topic)}" placeholder="e.g. Ratio v5, Workout, Dinner" autocomplete="off">
        <datalist id="b-topics">${live(data.topics).map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div>
      <div class="row">
        <div class="field grow"><label>Type</label><select id="b-type">${optHtml(b.type)}</select></div>
        <div class="field grow"><label>Importance</label><select id="b-prio">${Object.entries(PRIOS).map(([k, v]) => `<option value="${k}" ${b.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div class="field grow"><label>From</label><input type="time" id="b-start" data-bind="b-calc" value="${b.start}"></div>
        <div class="field grow"><label>To</label><input type="time" id="b-end" data-bind="b-calc" value="${b.end}"></div>
      </div>
      <div class="note" id="b-dur" style="margin:-6px 0 14px"></div>
      <div class="field"><label>Note (optional)</label><input type="text" id="b-note" value="${esc(b.note || '')}"></div>
      ${existing ? `<button class="btn danger sm" data-action="tt-del-modal" data-id="${existing.id}">Delete this block</button>` : ''}`,
    () => {
      const start = $('#b-start').value, end = $('#b-end').value;
      if (!start || !end) { toast('Set both times'); return false; }
      if (start === end) { toast('Start and end cannot be the same'); return false; }
      const rec = { id: existing ? existing.id : uid(), start, end, topic: $('#b-topic').value.trim(), type: $('#b-type').value, priority: $('#b-prio').value, note: $('#b-note').value.trim() };
      if (rec.topic) ensureTopic(rec.topic, rec.type, rec.priority);
      savePlan(date, (next) => {
        const i = existing ? next.blocks.findIndex((x) => x.id === existing.id) : -1;
        if (i >= 0) next.blocks[i] = rec; else next.blocks.push(rec);
      });
    });
    updateBlockDur();
  }
  function updateBlockDur() {
    const el = $('#b-dur'); if (!el) return;
    const s = $('#b-start').value, e = $('#b-end').value;
    if (!s || !e || s === e) { el.textContent = ''; return; }
    const d = blockDur({ start: s, end: e });
    el.textContent = `Duration ${fmtDur(d)}${toMin(e) < toMin(s) ? ' (ends after midnight)' : ''}`;
  }

  // ---------- link between activity-log entries and timetable blocks ----------
  function linkNote(s) {
    const b = resolvePlan(s.planDate).blocks.find((x) => x.id === s.blockId);
    const label = b ? `${b.start}–${b.end} ${esc(b.topic || defaultLabel(b.type))}` : 'a block that is no longer in the plan';
    return `<div class="note" style="margin-bottom:10px">Counts towards timetable block: <b>${label}</b> <button class="linkbtn" data-action="entry-unlink" data-id="${s.id}">Unlink</button></div>`;
  }
  // after adding an entry by hand: if it overlaps a planned block, ask before linking
  function offerBlockMatch(rec) {
    const end = rec.start + rec.seconds * 1000;
    let best = null;
    const sd = ymd(new Date(rec.start));
    [addDays(sd, -1), sd].forEach((pd) => {
      const plan = resolvePlan(pd);
      plan.blocks.forEach((b) => {
        if (b.type !== rec.type || plan.skipped.includes(b.id)) return;
        if (blockActual(pd, b.id) >= blockDur(b) * 60 * 0.9) return;
        const { startMs, endMs } = blockTimes(pd, b);
        const ov = Math.min(end, endMs) - Math.max(rec.start, startMs);
        if (ov <= 0) return;
        if (Math.max(ov / (rec.seconds * 1000), ov / (endMs - startMs)) >= 0.5 && (!best || ov > best.ov)) best = { pd, b, ov };
      });
    });
    if (!best) return;
    const label = `${best.b.start}–${best.b.end} ${best.b.topic || defaultLabel(best.b.type)}`;
    if (confirm(`This entry overlaps your planned block "${label}".\n\nCount it towards that block?`)) { rec.blockId = best.b.id; rec.planDate = best.pd; touch(rec); }
  }
  function updateEnd() {
    const el = $('#m-end'); if (!el) return;
    const d = $('#m-date').value, t = $('#m-time').value;
    const secs = (parseInt($('#m-h').value, 10) || 0) * 3600 + (parseInt($('#m-min').value, 10) || 0) * 60;
    if (!d || !t || secs <= 0) { el.textContent = ''; return; }
    const [hh, mm] = t.split(':').map(Number), s = parseYmd(d); s.setHours(hh, mm, 0, 0);
    el.textContent = `Runs ${fmtTime(s.getTime())} → ${fmtTime(s.getTime() + secs * 1000)}`;
  }
  function setStartFields(ms) {
    const d = new Date(Math.round(ms / 60000) * 60000);
    $('#m-date').value = ymd(d); $('#m-time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    updateEnd();
  }

  function markBlockDone(date, id, on) {
    const cur = resolvePlan(date), own = ownPlan(date);
    const rec = { blocks: clone(cur.blocks), skipped: [...cur.skipped], completed: [...(cur.completed || [])], updatedAt: Date.now() };
    if (own && own.createdAt) rec.createdAt = own.createdAt;
    rec.completed = on ? [...new Set([...rec.completed, id])] : rec.completed.filter((x) => x !== id);
    data.plans[date] = rec; persist(true); render();
  }
  function completePrompt(date, b, total, dur, after) {
    choiceModal('Is this topic complete?', `
      <p style="line-height:1.55;margin-bottom:6px"><b>${esc(b.topic || defaultLabel(b.type))}</b></p>
      <p class="note" style="margin-bottom:16px">You studied ${short(total)} of the ${short(dur)} you planned. If the topic is finished, the block counts as done.</p>`, [
      { label: 'Not yet', fn: after },
      { label: 'Yes, complete', cls: 'primary', fn: () => { markBlockDone(date, b.id, true); toast('Block marked done', () => markBlockDone(date, b.id, false)); after(); } }
    ]);
  }
  function startFromBlock(date, id, forceMode) {
    const b = resolvePlan(date).blocks.find((x) => x.id === id); if (!b) return;
    const rem = blockDur(b) * 60 - blockActual(date, id);
    const minutes = rem <= 0 ? blockDur(b) : Math.max(1, Math.ceil(rem / 60));
    const mode = forceMode || (data.settings.blockMode === 'countdown' ? 'countdown' : 'stopwatch');
    requestStart({ type: b.type, topic: b.topic, priority: b.priority, mode, minutes, planSec: mode === 'stopwatch' && rem > 0 ? rem : 0, blockId: b.id, planDate: date });
  }

  // "Now / Up next" card on the Today page
  function upNextCard() {
    if (ui.date !== todayStr()) return '';
    const pd = activePlanDate(), plan = resolvePlan(pd);
    if (!plan.blocks.length) return '';
    const now = Date.now();
    const list = sortBlocks(plan.blocks).map((b) => ({ b, ...blockTimes(pd, b), st: blockStatus(pd, b, plan) }));
    const cur = list.find((x) => x.startMs <= now && now < x.endMs && !['done', 'skipped'].includes(x.st.key));
    const nxt = list.find((x) => x.startMs > now && x.st.key !== 'skipped');
    const it = cur || nxt;
    const head = `<h2>${it ? (cur ? 'Now in your timetable' : 'Up next') : 'Timetable'} <button class="linkbtn" data-action="nav" data-page="timetable">Open timetable →</button></h2>`;
    if (!it) return `<div class="card">${head}<p class="note">Every planned block for today is finished or skipped.</p></div>`;
    const b = it.b, dur = blockDur(b);
    return `<div class="card">${head}
      <div class="blk" style="padding:0">
        <div class="btime">${b.start} – ${b.end}<small>${fmtDur(dur)}</small></div>
        <div class="bmain"><div class="btopic">${typeDot(b.type)}${esc(b.topic || defaultLabel(b.type))}</div>
          <div class="bmeta">${prioPill(b.priority)} ${spill(it.st)}</div></div>
        <div class="bact"><button class="btn sm primary" data-action="tt-start" data-date="${pd}" data-id="${b.id}">${it.st.act ? 'Resume' : 'Start'}</button></div>
      </div></div>`;
  }

  // Progress page: how much of the planned study time was actually done
  function adhTile(r) {
    const today = todayStr(), now = Date.now(), last = r.to < today ? r.to : today;
    let planned = 0, done = 0, n = 0, nDone = 0;
    for (let d = r.from; d <= last; d = addDays(d, 1)) {
      const plan = resolvePlan(d);
      plan.blocks.forEach((b) => {
        if (kindOf(b.type) !== 'study' || plan.skipped.includes(b.id)) return;
        if (blockTimes(d, b).endMs > now) return;
        const dur = blockDur(b) * 60, act = blockActual(d, b.id);
        planned += dur; n++; done += Math.min(dur, act); if (act >= dur * 0.9 || (act > 0 && (plan.completed || []).includes(b.id))) nDone++;
      });
    }
    const pct = planned ? Math.round(done / planned * 100) : null;
    return `<div class="tile"><div class="k">Plan adherence</div><div class="v">${pct === null ? '–' : pct + '%'}</div><div class="s">${pct === null ? 'no planned study yet' : nDone + ' of ' + n + ' study blocks'}</div></div>`;
  }

  // =====================================================================
  //  JOURNAL PAGE
  // =====================================================================
  const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };
  function hl(text, q) {
    if (!q) return esc(text);
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let out = '', last = 0, m;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }
  const journalAll = () => Object.entries(data.journal).filter(([, j]) => j && String(j.text || '').trim()).map(([d, j]) => ({ d, text: j.text })).sort((x, y) => (x.d < y.d ? 1 : -1));
  function journalView() {
    const q = ui.jr.q.trim(), ql = q.toLowerCase(), all = journalAll();
    const list = all.filter((e) => (ui.jr.month === 'all' || e.d.startsWith(ui.jr.month)) && (!q || e.text.toLowerCase().includes(ql) || fmtLong(e.d).toLowerCase().includes(ql)));
    const words = list.reduce((n, e) => n + (e.text.trim().match(/\S+/g) || []).length, 0);
    const count = `${list.length} ${list.length === 1 ? 'entry' : 'entries'}${q || ui.jr.month !== 'all' ? ' found' : ''} · ${words} words`;
    const html = list.length ? list.map((e) => {
      const study = totals(sessionsOn(e.d)).study, long = e.text.length > 320 || e.text.split('\n').length > 6;
      return `<div class="card jr-entry">
        <div class="jr-head">
          <div><div class="jr-date">${fmtDow(e.d)}, ${fmtLong(e.d)}</div><div class="note">${study ? 'Studied ' + short(study) : 'No study logged'}</div></div>
          <div class="row tight"><button class="btn sm" data-action="jr-open" data-date="${e.d}">Open day</button><button class="btn sm" data-action="jr-edit" data-date="${e.d}">Edit</button></div>
        </div>
        <div class="jr-text ${long ? 'clamp' : ''}">${hl(e.text, q)}</div>
        ${long ? '<button class="linkbtn" data-action="jr-more">Read more</button>' : ''}
      </div>`;
    }).join('') : `<div class="card"><div class="empty"><b>${all.length ? 'No entries match' : 'No journal entries yet'}</b>${all.length ? 'Try a different word or month.' : 'Write in the Journal box on the Today page, or press New entry.'}</div></div>`;
    return { html, count };
  }
  function pageJournal() {
    const months = [...new Set(journalAll().map((e) => e.d.slice(0, 7)))];
    const v = journalView();
    return `
      <div class="page-head">
        <div><h1>Journal</h1><p class="sub" id="jr-count">${v.count}</p></div>
        <button class="btn primary" data-action="jr-new">+ New entry</button>
      </div>
      <div class="controls">
        <input type="text" id="jr-q" data-bind="jr-q" placeholder="Search your journal…" value="${esc(ui.jr.q)}" style="max-width:340px">
        <select data-change="jr-month" style="width:auto"><option value="all">All months</option>${months.map((m) => `<option value="${m}" ${ui.jr.month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>
      </div>
      <div id="jr-list" class="stack">${v.html}</div>`;
  }
  function journalModal(date) {
    const isNew = !date, d = date || todayStr(), cur = (data.journal[d] && data.journal[d].text) || '';
    openModal(isNew ? 'New journal entry' : 'Journal · ' + fmtLong(d), `
      <div class="field"><label>Date</label><input type="date" id="j-date" value="${d}" ${isNew ? '' : 'disabled'}></div>
      <div class="field"><label>Entry</label><textarea id="j-text" style="min-height:230px" placeholder="How did the day go? What clicked, what to revisit…">${esc(cur)}</textarea></div>
      ${!isNew ? `<button class="btn danger sm" data-action="jr-del" data-date="${d}">Delete this entry</button>` : ''}`,
    () => {
      const dd = $('#j-date').value, text = $('#j-text').value;
      if (!dd) { toast('Pick a date'); return false; }
      if (isNew && data.journal[dd] && String(data.journal[dd].text || '').trim()) { toast('That day already has an entry. Open it with Edit.'); return false; }
      if (!text.trim() && !data.journal[dd]) { toast('Write something first'); return false; }
      data.journal[dd] = { text, updatedAt: Date.now() };
      persist(true); render();
    });
    const t = $('#j-text'); if (t) t.focus();
  }

  // =====================================================================
  //  REWARDS TAB: points are calculated from your existing data (sessions,
  //  timetable, check-ins, journal, sleep). Only rewards, redeemed items and
  //  the point settings are stored.
  // =====================================================================
  const PT_DEFAULTS = { study30: 10, workout30: 10, workoutMax: 3, goal: 50, stretchMin: 540, stretch: 100, plan: 15, loanFee: 25, loanMax: 1500, loanShare: 50, planWindow: 60, earlyFloor: 50, blockH: 30, blockM: 20, blockL: 10, focus: 5, checkin: 5, journal: 5, sleep: 5, streak3: 20, streak7: 50, streak30: 150, allSubjects: 50, missGoal: 20, missBlock: 10, cap: 30 };
  const PT_LABELS = [
    ['study30', 'Study, per 30 minutes (paid per minute)'], ['workout30', 'Workout, per 30 minutes (paid per minute)'], ['workoutMax', 'Workout: most 30-minute blocks counted per day'], ['goal', 'Daily goal reached'], ['stretchMin', 'Stretch goal (minutes of study)'], ['stretch', 'Stretch goal reached (bonus on top)'], ['plan', 'Planned the day early'], ['planWindow', 'Plan within this many minutes of waking'], ['earlyFloor', 'Finish a block early: minimum % of the planned time'], ['loanFee', 'Loan fee (%, charged up front)'], ['loanMax', 'Loan: maximum amount'], ['loanShare', 'Loan auto-repay share of daily earnings (%)'],
    ['blockH', 'Study block done: high'], ['blockM', 'Study block done: medium'], ['blockL', 'Study block done: low'],
    ['focus', 'Focused session (rated 4–5, 30+ min)'], ['checkin', 'Evening check-in'], ['journal', 'Journal entry'], ['sleep', 'Sleep logged'],
    ['streak3', '3-day streak'], ['streak7', '7-day streak'], ['streak30', '30-day streak'], ['allSubjects', 'Every subject studied in a week'],
    ['missGoal', 'Missed goal: maximum penalty'], ['missBlock', 'Missed study block'], ['cap', 'Daily penalty cap']
  ];
  const LEVELS = [['Beginner', 0], ['Learner', 200], ['Focused', 600], ['Scholar', 1500], ['Master', 3500], ['Legend', 8000]];
  const ptv = () => Object.assign({}, PT_DEFAULTS, data.pointsCfg.v);
  const LOCK_DAYS = 7;
  const ptLocked = () => (data.pointsCfg.lockUntil || 0) > Date.now();
  const lockWhen = () => { const d = new Date(data.pointsCfg.lockUntil); return `${fmtLong(ymd(d))}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };
  const lockMsg = () => `Locked until ${lockWhen()}. Points and prices cannot be changed yet`;
  function ptLog(text) { const at = Date.now(); data.pointsLog.push({ id: uid(), at, text, updatedAt: at }); }
  const sgn = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');

  const isWorkout = (s) => /workout|exercise|gym|yoga|fitness/i.test(cat(s.type).name + ' ' + s.topic);
  function computePoints() {
    const cfg = data.pointsCfg, v = ptv(), today = todayStr(), now = Date.now();
    const start = cfg.startDate || today, goal = data.settings.dailyGoalMin * 60;
    const by = {}, actual = {};
    live(data.sessions).forEach((s) => {
      (by[s.date] = by[s.date] || []).push(s);
      if (s.blockId) { const k = s.planDate + '|' + s.blockId; actual[k] = (actual[k] || 0) + s.seconds; }
    });
    const tm = data.timer, tmElapsed = tm ? Math.round(elapsedMs(tm) / 1000) : 0;
    const studyDays = new Set(live(data.sessions).filter((s) => kindOf(s.type) === 'study').map((s) => s.date));
    const tmap = new Map(live(data.topics).map((t) => [t.name.toLowerCase(), t]));
    const subs = live(data.subjects).filter((s) => live(data.topics).some((t) => t.subjectId === s.id));
    const reds = live(data.redemptions);
    const loanBy = {}; live(data.loans).forEach((l) => { (loanBy[l.date] = loanBy[l.date] || []).push(l); });
    const repBy = {}; live(data.repayments).forEach((r) => { (repBy[r.date] = repBy[r.date] || []).push(r); });
    const autoLog = [...(cfg.autoLog || [])].sort((x, y) => (x.d < y.d ? -1 : 1));
    const autoOn = (d) => { let on = true; autoLog.forEach((e) => { if (e.d <= d) on = e.on; }); return on; };
    const share = Math.min(100, Math.max(0, v.loanShare)) / 100;
    const redBy = {}; reds.forEach((r) => { (redBy[r.date] = redBy[r.date] || []).push(r); });
    let first = start;
    studyDays.forEach((d) => { if (d < first) first = d; });
    const days = {};
    let L = 0, A = 0, streakLen = 0, spent = 0, pending = 0, debt = 0, borrowed = 0, repaidAll = 0;
    for (let d = first, guard = 0; d <= today && guard < 4000; d = addDays(d, 1), guard++) {
      const isToday = d === today, finished = !isToday;
      const list = by[d] || [];
      let study = list.filter((s) => kindOf(s.type) === 'study').reduce((n, s) => n + s.seconds, 0);
      if (isToday && tm && kindOf(tm.type) === 'study') study += tmElapsed;
      const studied = study > 0;
      streakLen = studied ? streakLen + 1 : (isRest(d) || isToday) ? streakLen : 0;
      (redBy[d] || []).forEach((r) => { spent += r.cost; });
      if (d < start) { continue; }
      (loanBy[d] || []).forEach((l) => { A += l.principal; debt += l.principal + l.fee; borrowed += l.principal + l.fee; }); // a loan adds spendable points only, never score
      const items = [];
      const add = (label, pts, kind) => { if (pts) items.push({ label, pts, kind }); };
      add(`Study ${short(study)}`, Math.round(study / 60 * v.study30 / 30), 'earn'); // every minute counts
      if (goal > 0 && study >= goal) add('Daily goal reached', v.goal, 'earn');
      if (goal > 0 && v.stretchMin * 60 > goal && study >= v.stretchMin * 60) add('Stretch goal reached', v.stretch, 'earn');
      { // planning bonus: within the window after you wake (longest sleep of the day); falls back to the fixed time if no sleep is logged
        const sl = list.filter((s) => kindOf(s.type) === 'sleep').sort((x, y) => y.seconds - x.seconds)[0];
        const by = String(cfg.planBy || '08:00').split(':'), cut = parseYmd(d); cut.setHours(+by[0] || 8, +by[1] || 0, 0, 0);
        const limit = sl ? sl.start + sl.seconds * 1000 + v.planWindow * 60000 : cut.getTime();
        const own = data.plans[d];
        const planned = own && !own.deleted && own.createdAt && (own.blocks || []).length && own.createdAt <= limit;
        const session = list.some((s) => kindOf(s.type) !== 'sleep' && /plan/i.test(s.topic) && s.start <= limit) || (isToday && tm && /plan/i.test(tm.topic || '') && tm.startWall <= limit);
        if (planned || session) add('Planned the day early', v.plan, 'earn');
      }
      let wsec = list.filter((s) => kindOf(s.type) !== 'study' && kindOf(s.type) !== 'sleep' && isWorkout(s)).reduce((n, s) => n + s.seconds, 0);
      if (isToday && tm && kindOf(tm.type) !== 'study' && kindOf(tm.type) !== 'sleep' && isWorkout(tm)) wsec += tmElapsed;
      const wmin = Math.min(wsec / 60, v.workoutMax * 30), wpts = Math.round(wmin * v.workout30 / 30);
      if (wpts) add(`Workout ${short(wsec)}`, wpts, 'earn');
      // timetable blocks
      const plan = resolvePlan(d);
      let doneH = 0, doneM = 0, doneL = 0, missed = 0;
      plan.blocks.forEach((b) => {
        if (kindOf(b.type) !== 'study' || plan.skipped.includes(b.id)) return;
        const dur = blockDur(b) * 60;
        let act = actual[d + '|' + b.id] || 0;
        if (isToday && tm && tm.blockId === b.id && tm.planDate === d) act += tmElapsed;
        if (dur > 0 && (act >= dur * 0.9 || (act > 0 && (plan.completed || []).includes(b.id)))) { if (b.priority === 'high') doneH++; else if (b.priority === 'low') doneL++; else doneM++; }
        else if (act === 0 && blockTimes(d, b).endMs < now) missed++;
      });
      const nd = doneH + doneM + doneL;
      if (nd) add(`${nd} study ${nd === 1 ? 'block' : 'blocks'} done`, doneH * v.blockH + doneM * v.blockM + doneL * v.blockL, 'earn');
      const nf = list.filter((s) => kindOf(s.type) === 'study' && s.focus >= 4 && s.seconds >= 1800).length;
      if (nf) add(`${nf} focused ${nf === 1 ? 'session' : 'sessions'}`, nf * v.focus, 'earn');
      const ci = data.checkins[d];
      if (ci && (ci.mood || ci.focus)) add('Evening check-in', v.checkin, 'earn');
      if (((data.journal[d] && data.journal[d].text) || '').trim()) add('Journal entry', v.journal, 'earn');
      if (list.some((s) => kindOf(s.type) === 'sleep')) add('Sleep logged', v.sleep, 'earn');
      if (studied && (streakLen === 3 || streakLen === 7 || streakLen === 30)) add(`${streakLen}-day streak`, v['streak' + streakLen], 'earn');
      if (finished && parseYmd(d).getDay() === 0 && subs.length) {
        const covered = new Set();
        for (let i = 0; i < 7; i++) (by[addDays(d, -i)] || []).forEach((s) => {
          if (kindOf(s.type) !== 'study') return;
          const t = tmap.get(s.topic.toLowerCase()); if (t && t.subjectId) covered.add(t.subjectId);
        });
        if (subs.every((s) => covered.has(s.id))) add('Every subject studied this week', v.allSubjects, 'earn');
      }
      const earned = items.reduce((n, i) => n + i.pts, 0);
      // penalties (only for finished days; rest days are protected). Today shows what would apply if it ended now.
      const pens = [];
      if (cfg.penalties && !isRest(d)) {
        if (goal > 0 && study < goal && !boughtPass(d)) { const p = Math.round(v.missGoal * (1 - study / goal)); if (p) pens.push({ label: 'Missed daily goal', pts: -p }); }
        if (missed) pens.push({ label: `${missed} missed ${missed === 1 ? 'block' : 'blocks'}`, pts: -missed * v.missBlock });
      }
      const rawPen = pens.reduce((n, p) => n + p.pts, 0), pen = Math.max(rawPen, -v.cap);
      let penItems = pens.map((p) => ({ ...p, kind: 'pen' }));
      if (pen !== rawPen) penItems.push({ label: 'Daily penalty cap applied', pts: pen - rawPen, kind: 'cap' });
      if (finished) {
        const total = earned + pen;
        days[d] = { items: [...items, ...penItems], earned, pen, total, finished: true };
        L = Math.max(0, L + total); A = Math.max(0, A + total);
      } else {
        days[d] = { items, earned, pen: 0, total: earned, finished: false, pendingItems: penItems, pendingPen: pen };
        L = Math.max(0, L + earned); A = Math.max(0, A + earned);
        pending = pen;
      }
      if (debt > 0 && autoOn(d)) {
        const base = Math.max(0, finished ? days[d].total : days[d].earned), pay = Math.min(debt, A, Math.round(base * share));
        if (pay > 0) { A -= pay; debt -= pay; repaidAll += pay; days[d].repaid = pay; }
      }
      (redBy[d] || []).forEach((r) => { A = Math.max(0, A - r.cost); });
      (repBy[d] || []).forEach((r) => { const pay = Math.min(r.amount, A, debt); if (pay > 0) { A -= pay; debt -= pay; repaidAll += pay; } });
    }
    // redemptions made before the start date still count as spent (rare)
    return { days, L, A, debt, borrowed, repaidAll, spent, pending, start, today, studyToday: (() => { let s = (by[today] || []).filter((x) => kindOf(x.type) === 'study').reduce((n, x) => n + x.seconds, 0); if (tm && kindOf(tm.type) === 'study') s += tmElapsed; return s; })() };
  }
  function levelOf(L) {
    let i = 0;
    LEVELS.forEach(([, min], k) => { if (L >= min) i = k; });
    const cur = LEVELS[i], next = LEVELS[i + 1] || null;
    return { name: cur[0], idx: i, from: cur[1], next, pct: next ? Math.min(100, (L - cur[1]) / (next[1] - cur[1]) * 100) : 100 };
  }

  // ---- rewards
  const LIMITS = { none: 'No limit', twice: 'Twice a day', day: 'Once a day', week: 'Once a week', month: 'Once a month' };
  const redsOf = (r) => live(data.redemptions).filter((x) => x.rewardId === r.id);
  function rewardPrice(r) {
    const today = todayStr(), recent = redsOf(r).filter((x) => x.date >= addDays(today, -6)).length;
    return Math.max(1, Math.round(r.cost * Math.pow(1 + (r.rise || 0) / 100, recent)));
  }
  function rewardState(r, pts) {
    const price = rewardPrice(r), today = todayStr(), mine = redsOf(r), goal = data.settings.dailyGoalMin * 60;
    const lim = r.limit || 'none';
    if (r.special === 'rest' && isRest(today)) return { price, ok: false, why: 'Today is already a rest day' };
    const inDay = mine.filter((x) => x.date === today).length;
    const inWeek = mine.filter((x) => weekStart(x.date) === weekStart(today)).length;
    const inMonth = mine.filter((x) => x.date.slice(0, 7) === today.slice(0, 7)).length;
    if (lim === 'twice' && inDay >= 2) return { price, ok: false, why: 'Limit reached today (twice a day)' };
    if (lim === 'day' && inDay >= 1) return { price, ok: false, why: 'Limit reached today (once a day)' };
    if (lim === 'week' && inWeek >= 1) return { price, ok: false, why: 'Limit reached this week (once a week)' };
    if (lim === 'month' && inMonth >= 1) return { price, ok: false, why: 'Limit reached this month (once a month)' };
    if (r.special === 'pass' && boughtPass(today)) return { price, ok: false, why: 'Goal pass already used today' };
    if (r.special === 'pass' && isRest(today)) return { price, ok: false, why: 'Today is already a rest day' };
    if (r.needsGoal && goal > 0 && pts.studyToday < goal && !goalWaived(today)) return { price, ok: false, why: `Reach today's goal first (${short(Math.max(0, goal - pts.studyToday))} to go)` };
    if (pts.debt > 0 && !r.allowDebt && !r.special) return { price, ok: false, why: `Repay your loan first (you owe ${pts.debt}). Only small rewards are open while in debt` };
    if (pts.A < price) return { price, ok: false, why: `${price - pts.A} more points needed` };
    return { price, ok: true, why: '' };
  }
  const SUGGESTED_REWARDS = [
    ['Rest day (streak safe, no penalties)', 1200, 'week', false, 'rest'],
    ['Goal pass (skip today’s goal)', 300, 'week', false, 'pass'],
    ['Chai or snack', 60, 'twice', false, '', true], ['Favourite song break', 60, 'twice', false, '', true], ['20 minutes of social media', 80, 'twice', true, '', true],
    ['30-minute sleep-in', 150, 'week', true], ['1 hour of gaming or a show', 200, 'day', true], ['Order a favourite meal', 250, 'week', true],
    ['New book or stationery', 600, 'month', false], ['Movie', 700, 'week', true], ['Dinner out', 900, 'week', true],
    ['Half-day off', 3000, 'month', false], ['Day trip (big goal)', 4000, 'month', false]
  ];
  function rewardModal(existing) {
    const r = existing || { name: '', cost: 100, limit: 'none', needsGoal: false, rise: 0 };
    openModal(existing ? 'Edit reward' : 'New reward', `
      <div class="field"><label>Reward</label><input type="text" id="rw-name" value="${esc(r.name)}" placeholder="e.g. Movie night"></div>
      <div class="row">
        <div class="field grow"><label>Cost (points)</label><input type="number" id="rw-cost" min="1" step="10" value="${r.cost}"></div>
        <div class="field grow"><label>Limit</label><select id="rw-limit">${Object.entries(LIMITS).map(([k, l]) => `<option value="${k}" ${(r.limit || 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div class="field grow"><label>Type</label><select id="rw-special"><option value="" ${!r.special ? 'selected' : ''}>Normal reward</option><option value="rest" ${r.special === 'rest' ? 'selected' : ''}>Rest day (protects today)</option><option value="pass" ${r.special === 'pass' ? 'selected' : ''}>Goal pass (skips today’s goal)</option></select></div>
        <div class="field grow"><label>Unlock</label><select id="rw-goal"><option value="0" ${!r.needsGoal ? 'selected' : ''}>Any time</option><option value="1" ${r.needsGoal ? 'selected' : ''}>Only after today's goal</option></select></div>
        <div class="field grow"><label>Price rise per use (%)</label><input type="number" id="rw-rise" min="0" max="200" step="5" value="${r.rise || 0}"></div>
      </div>
      <div class="field"><label>While you owe a loan</label><select id="rw-debt"><option value="0" ${!r.allowDebt ? 'selected' : ''}>Blocked until the loan is repaid</option><option value="1" ${r.allowDebt ? 'selected' : ''}>Still allowed (small rewards)</option></select></div>
      <p class="note">The price rise applies for each time you redeemed it in the last 7 days, so a snack cannot become an everyday habit.</p>`, () => {
      const name = $('#rw-name').value.trim(), cost = parseInt($('#rw-cost').value, 10);
      if (!name) { toast('Give the reward a name'); return false; }
      if (!(cost >= 1)) { toast('Enter a cost of at least 1 point'); return false; }
      const rec = existing || { id: uid() };
      const nv = { name, cost, limit: $('#rw-limit').value, needsGoal: $('#rw-goal').value === '1', rise: Math.max(0, parseFloat($('#rw-rise').value) || 0), special: $('#rw-special').value, allowDebt: $('#rw-debt').value === '1' };
      const old = existing ? { cost: rec.cost, limit: rec.limit || 'none', needsGoal: !!rec.needsGoal, rise: rec.rise || 0, special: rec.special || '', allowDebt: !!rec.allowDebt } : null;
      if (existing && ptLocked()) Object.assign(nv, old); // cost and rules stay as they were while locked
      Object.assign(rec, { name: nv.name, cost: nv.cost, limit: nv.limit, needsGoal: nv.needsGoal, rise: nv.rise, allowDebt: nv.allowDebt });
      if (nv.special) rec.special = nv.special; else delete rec.special;
      if (!existing) ptLog(`Added reward "${nv.name}" (${nv.cost} points)`);
      else {
        const ch = [];
        if (old.cost !== nv.cost) ch.push(`cost ${old.cost} → ${nv.cost}`);
        if (old.limit !== nv.limit) ch.push(`limit ${LIMITS[old.limit]} → ${LIMITS[nv.limit]}`);
        if (old.needsGoal !== nv.needsGoal) ch.push(nv.needsGoal ? 'now needs the daily goal' : 'no longer needs the daily goal');
        if (old.allowDebt !== nv.allowDebt) ch.push(nv.allowDebt ? 'now allowed while in debt' : 'now blocked while in debt');
        if (old.rise !== nv.rise) ch.push(`price rise ${old.rise}% → ${nv.rise}%`);
        if (old.special !== nv.special) ch.push(nv.special ? `type set to ${nv.special === 'rest' ? 'rest day' : 'goal pass'}` : 'now a normal reward');
        if (ch.length) ptLog(`Reward "${nv.name}": ${ch.join(', ')}`);
      }
      touch(rec);
      if (!existing) data.rewards.push(rec);
      persist(true); render();
    });
    if (existing && ptLocked()) {
      ['#rw-cost', '#rw-limit', '#rw-goal', '#rw-rise', '#rw-special', '#rw-debt'].forEach((s) => { const e = $(s); if (e) e.disabled = true; });
      $('#modal-body').insertAdjacentHTML('beforeend', `<p class="note">Cost and rules are locked until ${esc(lockWhen())}. You can still rename it.</p>`);
    }
  }

  function ptChart(pts) {
    const today = todayStr(), n = 14, vals = [];
    for (let i = n - 1; i >= 0; i--) { const d = addDays(today, -i), x = pts.days[d]; vals.push({ d, total: x ? x.total : 0, has: !!x }); }
    const narrow = window.innerWidth <= 760, W = narrow ? 400 : 820, H = 200, L = 44, R = 6, T = 14, B = 26;
    const mx = Math.max(10, ...vals.map((x) => x.total)), mn = Math.min(0, ...vals.map((x) => x.total));
    const span = mx - mn, ih = H - T - B, y = (v) => T + (mx - v) / span * ih, slot = (W - L - R) / n, bw = Math.min(30, slot * 0.62);
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = mn + span * i / 4, yy = y(v); g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#94a3b8">${Math.round(v)}</text>`; }
    g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#94a3b8"/>`;
    vals.forEach((x, i) => {
      const cx = L + slot * i + (slot - bw) / 2, y0 = y(0), y1 = y(x.total);
      if (x.has && x.total !== 0) g += `<rect x="${cx}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1.5, Math.abs(y1 - y0))}" rx="3" fill="${x.total >= 0 ? '#2563eb' : '#e11d48'}"><title>${fmtShort(x.d)}: ${sgn(x.total)} points</title></rect>`;
      if (i % (narrow ? 2 : 1) === 0) g += `<text x="${cx + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#64748b">${parseYmd(x.d).getDate()}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Points per day">${g}</svg>`;
  }
  const itemRows = (items) => items.map((i) => `<div class="pt-row ${i.kind}"><span>${esc(i.label)}</span><b>${sgn(i.pts)}</b></div>`).join('');

  function pageRewards() {
    const pts = computePoints(), v = ptv(), today = pts.today, lv = levelOf(pts.L), cfg = data.pointsCfg;
    const td = pts.days[today];
    const rewards = live(data.rewards).sort((x, y) => x.cost - y.cost);
    const wk = (from) => { let s = 0; for (let i = 0; i < 7; i++) { const x = pts.days[addDays(from, i)]; if (x) s += x.total; } return s; };
    const thisWk = weekStart(today), lastWk = addDays(thisWk, -7);
    const recent = Array.from({ length: 14 }, (_, i) => addDays(today, -(i + 1))).filter((d) => pts.days[d]);
    const hist = live(data.redemptions).sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : (y.updatedAt || 0) - (x.updatedAt || 0))).slice(0, 10);

    const header = `
      <div class="card pt-hero">
        <div class="pt-big"><div class="lbl">Available points</div><div class="num">${pts.A.toLocaleString('en-IN')}</div>
          <div class="note">Lifetime score ${pts.L.toLocaleString('en-IN')} · spent ${pts.spent.toLocaleString('en-IN')} on rewards</div>
          ${pts.debt > 0 ? `<div class="pt-debt">You owe ${pts.debt.toLocaleString('en-IN')} points on a loan</div>` : ''}</div>
        <div class="pt-level">
          <div class="lvname"><span class="lbl">Level</span><b>${lv.name}</b></div>
          <div class="bar"><i style="width:${lv.pct}%"></i></div>
          <div class="note">${lv.next ? `${(lv.next[1] - pts.L).toLocaleString('en-IN')} points to ${lv.next[0]}` : 'Top level reached'}</div>
          <div class="lv-chips">${LEVELS.map(([n, m], i) => `<span class="${i === lv.idx ? 'on' : i < lv.idx ? 'past' : ''}" title="${m} points">${n}</span>`).join('')}</div>
        </div>
      </div>`;

    const todayCard = `
      <div class="card"><h2>Today <small>${fmtShort(today)}</small></h2>
        ${goalWaived(today) ? `<div class="pt-pending" style="margin:0 0 10px"><div class="note">${boughtPass(today) ? 'Goal pass active' : 'Rest day'}: today's goal is waived, so goal-gated rewards are unlocked.</div></div>` : ''}
        ${!td ? `<div class="note">Points start counting on <b>${fmtShort(pts.start)}</b>. You can change this in the settings below.</div>`
          : `${td.items.length ? itemRows(td.items) : '<div class="note">Nothing earned yet. Start a timer to get going.</div>'}${td.repaid ? `<div class="pt-row loan"><span>Auto-repaid to your loan</span><b>−${td.repaid}</b></div>` : ''}
             <div class="pt-row tot"><span>Earned today</span><b>${sgn(td.earned)}</b></div>
             ${td.pendingItems && td.pendingItems.length ? `<div class="pt-pending"><div class="lbl">If the day ended now</div>${itemRows(td.pendingItems)}<div class="note">Penalties are only applied when the day ends. Reach your goal and complete your blocks to avoid them.</div></div>` : ''}`}
      </div>`;

    const chart = `
      <div class="card"><h2>Last 14 days <small>points per day</small></h2>
        <div class="chart-wrap">${ptChart(pts)}</div>
        <div class="pt-weeks"><div><span class="lbl">This week</span><b>${sgn(wk(thisWk))}</b></div><div><span class="lbl">Last week</span><b>${sgn(wk(lastWk))}</b></div></div>
      </div>`;

    const rcard = (r) => {
      const st = rewardState(r, pts), pct = Math.min(100, pts.A / st.price * 100);
      const rise = r.rise && st.price !== r.cost ? ` <span class="note">(base ${r.cost})</span>` : '';
      return `<div class="rw-card ${st.ok ? 'ready' : ''}">
        <div class="rw-top"><b>${esc(r.name)}</b><span class="rw-cost">${st.price.toLocaleString('en-IN')} pts${rise}</span></div>
        <div class="rw-meta">${LIMITS[r.limit || 'none']}${r.special === 'rest' ? ' · protects your streak, no penalties' : r.special === 'pass' ? ' · skips today’s goal and its penalty' : ''}${r.needsGoal ? ' · after today’s goal' : ''}${r.allowDebt ? ' · open while in debt' : ''}${r.rise ? ` · +${r.rise}% per use` : ''}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="rw-act">
          <button class="btn sm primary" data-action="rw-redeem" data-id="${r.id}" ${st.ok ? '' : 'disabled'}>Redeem</button>
          <button class="btn sm" data-action="rw-edit" data-id="${r.id}">Edit</button>
          <button class="btn sm danger" data-action="rw-del" data-id="${r.id}">Delete</button>
        </div>
        ${st.ok ? '' : `<div class="rw-why">${esc(st.why)}</div>`}
      </div>`;
    };
    const shop = `
      <div class="card"><h2>Rewards <button class="btn sm primary" data-action="rw-add">+ New reward</button></h2>
        ${rewards.length ? `<div class="rw-grid">${rewards.map(rcard).join('')}</div>`
          : `<div class="empty"><b>No rewards yet</b>Add things you would enjoy and set what they cost.
              <div style="margin-top:12px"><button class="btn sm" data-action="rw-suggest">Add suggested rewards</button></div></div>`}
      </div>`;

    const autoNow = (() => { let on = true; (cfg.autoLog || []).slice().sort((x, y) => (x.d < y.d ? -1 : 1)).forEach((e) => { if (e.d <= today) on = e.on; }); return on; })();
    const loanCard = `
      <div class="card"><h2>Loan <small>for emergencies</small></h2>
        ${pts.debt > 0 ? `
          <div class="loan-owe"><div><div class="lbl">You owe</div><div class="num">${pts.debt.toLocaleString('en-IN')}</div></div>
            <div class="note">Borrowed with fee ${pts.borrowed.toLocaleString('en-IN')} · repaid ${pts.repaidAll.toLocaleString('en-IN')}</div></div>
          <div class="loan-act"><input type="number" id="loan-amt" min="1" max="${pts.debt}" placeholder="Amount" inputmode="numeric">
            <button class="btn sm primary" data-action="loan-repay">Repay</button>
            <button class="btn sm" data-action="loan-repay-all" ${pts.A > 0 ? '' : 'disabled'}>Repay all you can</button></div>
          <div class="note">Only rewards marked "open while in debt", rest days and goal passes can be redeemed until this is cleared.</div>`
        : `<div class="note">No loan. Borrow up to <b>${v.loanMax.toLocaleString('en-IN')}</b> points. A ${v.loanFee}% fee is added once, and the debt never grows after that.</div>
           <div class="loan-act"><button class="btn sm primary" data-action="loan-take">Take a loan</button></div>`}
        <div class="field" style="margin:12px 0 0"><label class="chk"><input type="checkbox" data-change="loan-auto" ${autoNow ? 'checked' : ''}> Auto-repay ${v.loanShare}% of each day's earnings while I owe</label></div>
      </div>`;
    const history = `
      <div class="card"><h2>Redeemed <small>latest 10</small></h2>
        ${hist.length ? hist.map((x) => `<div class="list-row"><div class="grow"><div class="nm">${esc(x.name)}</div><div class="meta">${fmtShort(x.date)}</div></div><b class="neg">−${x.cost}</b><button class="btn sm" data-action="rd-undo" data-id="${x.id}">Undo</button></div>`).join('')
          : '<div class="note">Nothing redeemed yet.</div>'}
      </div>`;

    const days = `
      <div class="card"><h2>Recent days <small>tap a day for the breakdown</small></h2>
        ${recent.length ? recent.map((d) => { const x = pts.days[d], open = !!ui.rw.open[d]; return `
          <div class="pd ${open ? 'open' : ''}"><div class="pd-head" data-action="pt-open" data-date="${d}"><span class="caret">›</span><span class="grow">${fmtDow(d)}, ${fmtShort(d)}${isRest(d) ? ' <span class="pill rest">Rest</span>' : ''}</span><b class="${x.total < 0 ? 'neg' : 'pos'}">${sgn(x.total)}</b></div>
          ${open ? `<div class="pd-body">${x.items.length ? itemRows(x.items) : '<div class="note">Nothing earned or lost.</div>'}${x.repaid ? `<div class="pt-row loan"><span>Auto-repaid to your loan</span><b>−${x.repaid}</b></div>` : ''}</div>` : ''}</div>`; }).join('')
          : '<div class="note">Finished days will appear here.</div>'}
      </div>`;

    const locked = ptLocked(), dis = locked ? 'disabled' : '';
    const lockBox = locked
      ? `<div class="pt-lock on"><b>Locked</b> until ${esc(lockWhen())}. Point values, prices and reward rules cannot be changed until then.</div>`
      : `<div class="pt-lock"><div>Tuned your points? Lock them for ${LOCK_DAYS} days so a bad day cannot change the rules.</div><button class="btn sm" data-action="pt-lock">Lock for ${LOCK_DAYS} days</button></div>`;
    const logAll = ui.rw.logAll, logs = live(data.pointsLog).sort((x, y) => y.at - x.at);
    const weekChanges = logs.filter((l) => l.at > Date.now() - 7 * 86400000 && !/^Locked /.test(l.text)).length;
    const logCard = `
      <div class="card"><h2>Changes <small>${logs.length} total</small></h2>
        ${weekChanges > 2 ? `<div class="pt-pending" style="margin:0 0 10px"><div class="note">${weekChanges} changes in the last 7 days. Try settling on numbers and let them run.</div></div>` : ''}
        ${logs.length ? (logAll ? logs : logs.slice(0, 10)).map((l) => { const dt = new Date(l.at); return `<div class="pt-row"><span>${esc(l.text)}</span><span class="note" style="white-space:nowrap">${fmtShort(ymd(dt))}, ${dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>`; }).join('')
          : '<div class="note">Every change to your points or reward prices will be recorded here.</div>'}
        ${logs.length > 10 ? `<div style="margin-top:8px"><button class="linkbtn" data-action="log-all">${logAll ? 'Show latest 10' : `Show all ${logs.length}`}</button></div>` : ''}
      </div>`;
    const settings = `
      <div class="card"><h2>Points settings <button class="btn sm" data-action="pt-set-toggle">${ui.rw.set ? 'Hide' : 'Show'}</button></h2>
        ${lockBox}
        <div ${ui.rw.set ? '' : 'hidden'}>
        <div class="field"><label>Count points from</label><input type="date" data-change="pt-start" value="${cfg.startDate}" ${dis}></div>
        <div class="field"><label>Fallback planning time when no sleep is logged</label><input type="time" data-change="pt-planby" value="${esc(cfg.planBy || '08:00')}" ${dis}></div>
        <div class="field"><label class="chk"><input type="checkbox" data-change="pt-pen" ${cfg.penalties ? 'checked' : ''} ${dis}> Deduct points for missed goals and blocks</label></div>
        <div class="pt-grid">${PT_LABELS.map(([k, l]) => `<label class="pt-set"><span>${l}</span><input type="number" min="0" step="1" data-change="pt-val" data-key="${k}" value="${v[k]}" ${dis}></label>`).join('')}</div>
        <div class="row" style="margin-top:12px"><button class="btn" data-action="pt-reset" ${dis}>Reset to defaults</button></div>
        <p class="note" style="margin-top:12px">Changing a value recalculates your whole history. Rest days (including ones you buy), skipped blocks, sleep and untracked gaps never cost points, and your score never goes below zero.</p>
        </div>
      </div>`;

    return `
      <div class="page-head"><div><h1>Rewards</h1><p class="sub">Earn points for studying, spend them on rewards you choose</p></div></div>
      <div class="stack">
        ${header}
        <div class="grid">
          <div class="stack">${loanCard}${shop}${history}</div>
          <div class="stack">${todayCard}${chart}${days}${settings}${logCard}</div>
        </div>
      </div>`;
  }

  // =====================================================================
  //  RENDER + EVENTS
  // =====================================================================
  function render() {
    $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === ui.page));
    const main = $('#main');
    const keep = main.scrollTop;
    main.innerHTML = ({ today: pageToday, timetable: pageTimetable, progress: pageProgress, journal: pageJournal, rewards: pageRewards, library: pageLibrary }[ui.page] || pageToday)();
    main.scrollTop = keep;
    if (ui.page === 'timetable' && ui.tt.scrollNow) {
      ui.tt.scrollNow = false;
      const target = $('.tb.st-now, .tb.st-upcoming') || $('.tl-now');
      if (target) main.scrollTop = Math.max(0, target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 90);
    }
    if (ui.page === 'library') store.location().then((p) => { const el = $('#loc'); if (el) el.textContent = 'Data file: ' + p; });
    if (ui.page !== 'today') document.title = 'Study Tracker';
    tick();
  }

  function applyPreset(p) {
    ui.form = { type: p.type, topic: p.topic || '', priority: p.priority, mode: p.minutes ? 'countdown' : 'stopwatch', minutes: p.minutes || 25 };
  }

  const actions = {
    nav: (el) => { ui.page = el.dataset.page; if (ui.page === 'timetable') { ui.tt.date = null; ui.tt.scrollNow = true; } render(); },
    'modal-bg': (el, e) => { if (e.target === el) closeModal(); },
    'modal-close': () => closeModal(),

    'date-prev': () => { ui.date = addDays(ui.date, -1); render(); },
    'date-next': () => { ui.date = addDays(ui.date, 1); render(); },
    'date-today': () => { ui.date = todayStr(); render(); },
    'goto-day': (el) => { ui.date = el.dataset.date; ui.page = 'today'; render(); },

    'set-type': (el) => {
      ui.form.type = el.dataset.v;
      if (kindOf(ui.form.type) === 'break' || kindOf(ui.form.type) === 'sleep') { ui.form.priority = 'low'; }
      render();
    },
    'set-prio': (el) => { ui.form.priority = el.dataset.v; render(); },
    'set-mode': (el) => { ui.form.mode = el.dataset.v; render(); },
    'use-preset': (el) => { const p = live(data.presets).find((x) => x.id === el.dataset.id); if (p) { applyPreset(p); render(); toast(`Preset loaded: ${p.name}`); } },
    start: () => {
      const f = ui.form;
      if (f.mode === 'countdown' && !(f.minutes > 0)) { toast('Enter the countdown minutes'); return; }
      requestStart(f);
    },
    pause: pauseTimer,
    resume: resumeTimer,
    stop: () => stopTimer(true),
    discard: () => { if (confirm('Discard this timer without saving?')) stopTimer(false); },

    'entry-add': () => entryModal(null),
    'entry-edit': (el) => { const s = live(data.sessions).find((x) => x.id === el.dataset.id); if (s) entryModal(s); },
    'entry-del-modal': (el) => {
      const s = live(data.sessions).find((x) => x.id === el.dataset.id);
      if (s) { closeModal(); softDelete(s, `Deleted "${s.topic}"`); }
    },
    'entry-del': (el) => {
      const s = live(data.sessions).find((x) => x.id === el.dataset.id);
      if (s) softDelete(s, `Deleted "${s.topic}"`);
    },

    'prog-mode': (el) => { ui.prog.mode = el.dataset.v; render(); },
    'prog-prev': () => progStep(-1),
    'prog-next': () => progStep(1),
    'prog-now': () => { ui.prog.month = todayStr().slice(0, 7); ui.prog.anchor = todayStr(); render(); },

    'topic-add': () => topicModal(null),
    'topic-edit': (el) => { const t = live(data.topics).find((x) => x.id === el.dataset.id); if (t) topicModal(t); },
    'topic-del': (el) => {
      const t = live(data.topics).find((x) => x.id === el.dataset.id);
      if (t) softDelete(t, `Deleted topic "${t.name}"`);
    },
    'preset-add': () => presetModal(null),
    'preset-edit': (el) => { const p = live(data.presets).find((x) => x.id === el.dataset.id); if (p) presetModal(p); },
    'preset-del': (el) => {
      const p = live(data.presets).find((x) => x.id === el.dataset.id);
      if (p) softDelete(p, `Deleted preset "${p.name}"`);
    },
    'preset-start': (el) => {
      const p = live(data.presets).find((x) => x.id === el.dataset.id);
      if (!p) return;
      requestStart({ type: p.type, topic: p.topic, priority: p.priority, mode: p.minutes ? 'countdown' : 'stopwatch', minutes: p.minutes });
    },

    // --- sleep, gaps, categories
    'go-sleep': () => requestStart({ type: 'sleep', topic: '', priority: 'low', mode: 'stopwatch' }),
    'sleep-log': () => sleepModal(),
    'gap-break': (el) => {
      const s = +el.dataset.s, e = +el.dataset.e;
      data.sessions.push(touch({ id: uid(), date: ymd(new Date(s)), start: s, seconds: Math.round((e - s) / 1000), topic: 'Break', type: 'break', priority: 'low', comment: '' }));
      persist(true); render(); toast('Counted as break');
    },
    'gap-label': (el) => { const s = +el.dataset.s, e = +el.dataset.e; entryModal(null, { start: s, seconds: Math.round((e - s) / 1000), type: 'break', priority: 'low' }); },
    'cat-add': () => catModal(null),
    'cat-edit': (el) => { const x = catRaw(el.dataset.id); if (x) catModal(x); },
    'cat-del': (el) => {
      const x = catRaw(el.dataset.id);
      if (x && !LOCKED.includes(x.id)) softDelete(x, `Deleted category "${x.name}"`);
    },
    // --- timer
    extend: () => {
      const t = data.timer; if (!t || t.mode !== 'countdown') return;
      t.targetSec = Math.max(t.targetSec, Math.ceil(elapsedMs(t) / 1000)) + 600; t.alerted = false;
      data.timerUpdatedAt = Date.now(); persist(true); render(); toast('Added 10 minutes');
    },
    // --- entry modal helpers
    'm-finished': () => {
      const secs = (parseInt($('#m-h').value, 10) || 0) * 3600 + (parseInt($('#m-min').value, 10) || 0) * 60;
      if (secs < 60) { toast('Enter the duration first'); return; }
      setStartFields(Date.now() - secs * 1000);
    },
    'm-startnow': () => setStartFields(Date.now()),
    'entry-unlink': (el) => {
      const s = live(data.sessions).find((x) => x.id === el.dataset.id);
      if (s) { delete s.blockId; delete s.planDate; touch(s); closeModal(); persist(true); render(); toast('Unlinked from the timetable'); }
    },
    // --- timetable
    'tt-prev': () => { ui.tt.date = addDays(ttDate(), -1); render(); },
    'tt-next': () => { ui.tt.date = addDays(ttDate(), 1); render(); },
    'tt-today': () => { ui.tt.date = activePlanDate(); ui.tt.scrollNow = true; render(); },
    'tt-view': (el) => { ui.tt.view = el.dataset.v; ui.tt.scrollNow = true; render(); },
    'tt-scope': (el) => { ui.tt.scope = el.dataset.v; render(); toast(ui.tt.scope === 'day' ? 'Edits now change only this day' : 'Edits now also apply to the days after'); },
    'tt-add': () => blockModal(ttDate(), null),
    'tt-edit': (el) => {
      if (justDragged) return;
      const b = resolvePlan(ttDate()).blocks.find((x) => x.id === el.dataset.id);
      if (b) blockModal(ttDate(), b);
    },
    'tt-del-modal': (el) => {
      const id = el.dataset.id;
      if (confirm('Delete this block from the plan?')) { closeModal(); savePlan(ttDate(), (next) => { next.blocks = next.blocks.filter((x) => x.id !== id); }); }
    },
    'tt-quick-add': () => {
      const ta = $('#tt-quick'); if (!ta) return;
      const { out, bad } = parseQuickLines(ta.value);
      if (!out.length) { toast(bad.length ? 'Use the format 14:00 to 15:00 Topic' : 'Type a time range first'); return; }
      savePlan(ttDate(), (next) => { next.blocks.push(...out); });
      toast(bad.length ? `Added ${out.length}. Could not read: ${bad[0]}` : `Added ${out.length} ${out.length === 1 ? 'block' : 'blocks'}`);
    },
    'tt-start': (el) => startFromBlock(el.dataset.date, el.dataset.id),
    'tt-start-alt': (el) => startFromBlock(el.dataset.date, el.dataset.id, el.dataset.mode),
    'tt-reopen': (el) => { markBlockDone(el.dataset.date, el.dataset.id, false); toast('Block reopened'); },
    'tt-skip': (el) => {
      const date = ttDate(), cur = resolvePlan(date), id = el.dataset.id;
      const rec = { blocks: clone(cur.blocks), skipped: [...cur.skipped], completed: [...(cur.completed || [])], updatedAt: Date.now() };
      if ((ownPlan(date) || {}).createdAt) rec.createdAt = ownPlan(date).createdAt;
      rec.skipped = rec.skipped.includes(id) ? rec.skipped.filter((x) => x !== id) : [...rec.skipped, id];
      data.plans[date] = rec; persist(true); render();
    },
    'tt-reset': () => {
      if (!confirm('Remove this day\'s custom plan and go back to the previous plan?')) return;
      data.plans[ttDate()] = { deleted: true, updatedAt: Date.now() }; persist(true); render();
    },
    'tt-clear': () => {
      if (!resolvePlan(ttDate()).blocks.length) { toast('The plan is already empty'); return; }
      if (confirm('Clear every block from this day\'s plan?')) savePlan(ttDate(), (next) => { next.blocks = []; next.skipped = []; });
    },
    'tt-copy': () => {
      const from = $('#copy-from').value, date = ttDate();
      if (!from) { toast('Pick a day to copy from'); return; }
      if (from === date) { toast('Pick a different day'); return; }
      const src = resolvePlan(from);
      if (!src.blocks.length) { toast('That day has no plan'); return; }
      if (resolvePlan(date).blocks.length && !confirm(`Replace this day's plan with the plan from ${fmtShort(from)}?`)) return;
      savePlan(date, (next) => { next.blocks = src.blocks.map((b) => ({ ...b, id: uid() })); next.skipped = []; });
      toast('Plan copied');
    },
    'tpl-save': () => {
      const name = ($('#tpl-name').value || '').trim(), blocks = resolvePlan(ttDate()).blocks;
      if (!name) { toast('Give the template a name'); return; }
      if (!blocks.length) { toast('The plan is empty'); return; }
      data.templates.push(touch({ id: uid(), name, blocks: clone(blocks) }));
      persist(true); render(); toast(`Saved template "${name}"`);
    },
    'tpl-apply': (el) => {
      const t = live(data.templates).find((x) => x.id === el.dataset.id), date = ttDate(); if (!t) return;
      if (resolvePlan(date).blocks.length && !confirm(`Replace this day's plan with "${t.name}"?`)) return;
      savePlan(date, (next) => { next.blocks = t.blocks.map((b) => ({ ...b, id: uid() })); next.skipped = []; });
    },
    'tpl-del': (el) => {
      const t = live(data.templates).find((x) => x.id === el.dataset.id);
      if (t) softDelete(t, `Deleted template "${t.name}"`);
    },
    // --- rewards
    'rw-add': () => rewardModal(null),
    'rw-edit': (el) => { const r = live(data.rewards).find((x) => x.id === el.dataset.id); if (r) rewardModal(r); },
    'rw-del': (el) => { const r = live(data.rewards).find((x) => x.id === el.dataset.id); if (r) { ptLog(`Deleted reward "${r.name}"`); softDelete(r, `Deleted reward "${r.name}"`); } },
    'rw-suggest': () => {
      SUGGESTED_REWARDS.forEach(([name, cost, limit, needsGoal, special, allowDebt]) => data.rewards.push(touch({ id: uid(), name, cost, limit, needsGoal, rise: 0, ...(allowDebt ? { allowDebt: true } : {}), ...(special ? { special } : {}) })));
      ptLog(`Added ${SUGGESTED_REWARDS.length} suggested rewards`);
      persist(true); render(); toast('Rewards added. Edit the costs to suit you');
    },
    'rw-redeem': (el) => {
      const r = live(data.rewards).find((x) => x.id === el.dataset.id); if (!r) return;
      const pts = computePoints(), st = rewardState(r, pts);
      if (!st.ok) { toast(st.why); return; }
      const rec = touch({ id: uid(), rewardId: r.id, name: r.name, cost: st.price, date: todayStr(), ...(r.special ? { special: r.special } : {}) });
      data.redemptions.push(rec); persist(true); render();
      toast(r.special === 'rest' ? `Rest day unlocked for ${st.price} points. Today is protected` : r.special === 'pass' ? `Goal pass bought for ${st.price} points. Today's goal is waived` : `Redeemed "${r.name}" for ${st.price} points`, () => { rec.deleted = true; touch(rec); persist(true); render(); });
    },
    'rd-undo': (el) => { const x = live(data.redemptions).find((r) => r.id === el.dataset.id); if (x) softDelete(x, `Returned ${x.cost} points for "${x.name}"`); },
    'pt-lock': () => {
      if (ptLocked()) return;
      if (!confirm(`Lock all point values, prices and reward rules for ${LOCK_DAYS} days?\n\nYou will not be able to unlock early.`)) return;
      data.pointsCfg.lockUntil = Date.now() + LOCK_DAYS * 86400000; touch(data.pointsCfg);
      ptLog(`Locked points and prices for ${LOCK_DAYS} days`);
      persist(true); render(); toast(`Locked until ${lockWhen()}`);
    },
    'loan-take': () => {
      const pts = computePoints(), v = ptv();
      if (pts.debt > 0) { toast('Repay your current loan first'); return; }
      const max = Math.max(1, v.loanMax);
      openModal('Take a loan', `
        <div class="field"><label>How many points? (up to ${max})</label><input type="number" id="loan-new" min="1" max="${max}" step="10" value="${Math.min(500, max)}"></div>
        <p class="note">A ${v.loanFee}% fee is added once. For 500 points you would owe ${Math.round(500 * (1 + v.loanFee / 100))}. Your level and score do not change.</p>`, () => {
        const amt = Math.round(parseFloat($('#loan-new').value));
        if (!(amt >= 1) || amt > max) { toast(`Enter 1 to ${max}`); return false; }
        const fee = Math.round(amt * v.loanFee / 100);
        const rec = touch({ id: uid(), date: todayStr(), principal: amt, fee });
        data.loans.push(rec); ptLog(`Took a loan of ${amt} (owe ${amt + fee})`);
        persist(true); render();
        toast(`Borrowed ${amt} points. You owe ${amt + fee}`, () => { rec.deleted = true; touch(rec); ptLog(`Cancelled the loan of ${amt}`); persist(true); render(); });
      }, 'Borrow');
    },
    'loan-repay': () => {
      const pts = computePoints(), el = $('#loan-amt'), amt = Math.round(parseFloat(el && el.value));
      if (!(amt >= 1)) { toast('Enter an amount to repay'); return; }
      if (amt > pts.A) { toast(`You only have ${pts.A} available points`); return; }
      if (amt > pts.debt) { toast(`You only owe ${pts.debt}`); return; }
      const rec = touch({ id: uid(), date: todayStr(), amount: amt });
      data.repayments.push(rec); ptLog(`Repaid ${amt} of the loan`); persist(true); render();
      toast(`Repaid ${amt} points`, () => { rec.deleted = true; touch(rec); persist(true); render(); });
    },
    'loan-repay-all': () => {
      const pts = computePoints(), amt = Math.min(pts.A, pts.debt);
      if (amt < 1) { toast('No available points to repay with'); return; }
      const rec = touch({ id: uid(), date: todayStr(), amount: amt });
      data.repayments.push(rec); ptLog(`Repaid ${amt} of the loan`); persist(true); render();
      toast(amt >= pts.debt ? 'Loan cleared' : `Repaid ${amt} points`, () => { rec.deleted = true; touch(rec); persist(true); render(); });
    },
    'pt-set-toggle': () => { ui.rw.set = !ui.rw.set; try { localStorage.setItem('st-pt-set', ui.rw.set ? '1' : '0'); } catch (e) { /* ignore */ } render(); },
    'log-all': () => { ui.rw.logAll = !ui.rw.logAll; render(); },
    'pt-open': (el) => { ui.rw.open[el.dataset.date] = !ui.rw.open[el.dataset.date]; render(); },
    'pt-reset': () => {
      if (ptLocked()) { toast(lockMsg()); return; }
      if (!confirm('Reset all point values to the defaults?')) return;
      ptLog('All point values reset to defaults');
      data.pointsCfg.v = {}; touch(data.pointsCfg); persist(true); render(); toast('Point values reset');
    },
    // --- subjects
    'subj-add': () => subjectModal(null),
    'subj-edit': (el) => { const s = live(data.subjects).find((x) => x.id === el.dataset.id); if (s) subjectModal(s); },
    'subj-del': (el) => { const s = live(data.subjects).find((x) => x.id === el.dataset.id); if (s) softDelete(s, `Deleted subject "${s.name}". Its topics now have no subject`); },
    'subj-suggest': () => {
      ['Reasoning', 'Quant', 'Hindi', 'Accountancy & Computer', 'Banking Awareness'].forEach((name, i) => {
        if (!live(data.subjects).some((s) => s.name.toLowerCase() === name.toLowerCase())) data.subjects.push(touch({ id: uid(), name, color: DONUT_COLORS[i % DONUT_COLORS.length] }));
      });
      persist(true); render(); toast('Subjects added. Use Organise to sort your topics into them');
    },
    'subj-toggle': (el) => { ui.prog.open[el.dataset.id] = !ui.prog.open[el.dataset.id]; render(); },
    'subj-inc': (el) => { ui.prog.incOther = el.dataset.v === '1'; render(); },
    'org-toggle': () => { ui.lib.org = !ui.lib.org; ui.lib.sel = []; render(); },
    'org-pick': (el) => { const i = ui.lib.sel.indexOf(el.dataset.id); if (i >= 0) ui.lib.sel.splice(i, 1); else ui.lib.sel.push(el.dataset.id); render(); },
    'org-apply': () => {
      if (!ui.lib.sel.length) { toast('Tick some topics first'); return; }
      const target = ($('#org-target') || {}).value || '';
      let n = 0;
      ui.lib.sel.forEach((id) => { const t = data.topics.find((x) => x.id === id); if (t) { if (target) t.subjectId = target; else delete t.subjectId; touch(t); n++; } });
      ui.lib.sel = []; persist(true); render(); toast(`Moved ${n} ${n === 1 ? 'topic' : 'topics'}`);
    },
    // --- important topics
    'imp-add': () => {
      const el = $('#imp-new'), lines = String((el && el.value) || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) { toast('Type a topic first'); return; }
      let order = Math.max(0, ...data.important.items.map((i) => i.order || 0));
      lines.forEach((text) => data.important.items.push(touch({ id: uid(), text, done: false, order: ++order })));
      persist(true); render();
      const n = $('#imp-new'); if (n) n.focus();
    },
    'imp-del': (el) => { const it = data.important.items.find((x) => x.id === el.dataset.id); if (it) softDelete(it, `Removed "${it.text}"`); },
    'imp-clear': () => {
      const done = impItems().filter((i) => i.done);
      done.forEach((i) => { i.deleted = true; touch(i); });
      persist(true); render();
      toast(`Removed ${done.length} ticked ${done.length === 1 ? 'topic' : 'topics'}`, () => { done.forEach((i) => { i.deleted = false; touch(i); }); persist(true); render(); });
    },
    'imp-text': () => { ui.imp.text = true; render(); },
    'imp-text-cancel': () => { ui.imp.text = false; render(); },
    'imp-text-done': () => {
      const lines = String(($('#imp-text') || {}).value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pool = impItems();
      lines.forEach((text, idx) => {
        const hit = pool.findIndex((i) => i.text === text);
        if (hit >= 0) { const it = pool.splice(hit, 1)[0]; if (it.order !== idx + 1) { it.order = idx + 1; touch(it); } }
        else data.important.items.push(touch({ id: uid(), text, done: false, order: idx + 1 }));
      });
      pool.forEach((i) => { i.deleted = true; touch(i); }); // lines you removed
      ui.imp.text = false; persist(true); render();
    },
    // --- v4
    'toast-undo': () => { const f = toastUndo; toastUndo = null; $('#toast').hidden = true; if (f) f(); },
    'set-focus': (el) => {
      const s = data.sessions.find((x) => x.id === el.dataset.id); closeModal();
      if (s) { s.focus = +el.dataset.v; touch(s); persist(true); render(); toast(`Focus ${s.focus}/5 saved`); }
    },
    'qa-add': () => {
      const el = $('#qa'), txt = ((el && el.value) || '').trim();
      if (!txt) { toast('Type what you did, e.g. Chemistry 11:00-12:30'); return; }
      const r = parseQuickEntry(txt, ui.date);
      if (r.error) { toast(r.error); return; }
      if (!r.complete) {
        const pre = { type: r.type, topic: r.topic, priority: r.priority };
        if (r.start) pre.start = r.start;
        if (r.seconds) pre.seconds = r.seconds;
        entryModal(null, pre); return;
      }
      if (r.seconds < 60 || r.seconds > 20 * 3600) { toast('Duration should be between 1 minute and 20 hours'); return; }
      const topic = r.topic || defaultLabel(r.type);
      const rec = touch({ id: uid(), date: sessionDate(r.type, r.start, r.seconds), start: r.start, seconds: r.seconds, topic, type: r.type, priority: r.priority, comment: '' });
      data.sessions.push(rec);
      if (r.topic) ensureTopic(r.topic, r.type, r.priority);
      offerBlockMatch(rec);
      ui.date = rec.date; persist(true); render();
      toast(`Added ${short(r.seconds)} of ${topic}`, () => { rec.deleted = true; touch(rec); persist(true); render(); });
    },
    'ci-set': (el) => {
      const d = ui.date, k = el.dataset.k, v = +el.dataset.v, ci = Object.assign({}, data.checkins[d]);
      if (ci[k] === v) delete ci[k]; else ci[k] = v;
      ci.updatedAt = Date.now(); data.checkins[d] = ci; persist(true); render();
    },
    'donut-mode': (el) => { ui.donut.mode = el.dataset.v; ui.donut.sel = null; render(); },
    'donut-pick': (el) => { const i = +el.dataset.i; ui.donut.sel = ui.donut.sel === i ? null : i; render(); },
    'install-now': async () => {
      if (deferredInstall) {
        const ev = deferredInstall; deferredInstall = null;
        try { ev.prompt(); await ev.userChoice; } catch { /* ignore */ }
        render();
      } else installModal();
    },
    'install-dismiss': () => { try { localStorage.setItem('studytracker-install-dismissed', '1'); } catch { /* ignore */ } render(); },
    'sound-test': () => ting(),
    // --- journal
    'jr-new': () => journalModal(null),
    'jr-edit': (el) => journalModal(el.dataset.date),
    'jr-open': (el) => { ui.date = el.dataset.date; ui.page = 'today'; render(); },
    'jr-more': (el) => {
      const t = el.previousElementSibling; if (!t) return;
      const open = t.classList.toggle('clamp');
      el.textContent = open ? 'Read more' : 'Show less';
    },
    'jr-del': (el) => {
      const d = el.dataset.date;
      const prev = data.journal[d] && data.journal[d].text;
      if (prev !== undefined) {
        data.journal[d] = { text: '', updatedAt: Date.now() }; closeModal(); persist(true); render();
        toast('Deleted journal entry', () => { data.journal[d] = { text: prev, updatedAt: Date.now() }; persist(true); render(); });
      }
    },

    'sync-connect': async () => {
      const tok = ($('#s-token').value || '').trim();
      if (!tok) { toast('Paste your GitHub token first'); return; }
      sync.token = tok; sync.gistId = ''; saveSyncCfg();
      toast('Connecting…');
      await runSync();
      if (!sync.token) { toast('That token was rejected'); }
      else if (sync.status.startsWith('Sync failed') || sync.status.startsWith('Offline')) { toast(sync.status); sync.token = ''; saveSyncCfg(); }
      else toast('Connected. Data is now synced');
      render();
    },
    'sync-now': async () => { await runSync(); toast(sync.status || 'Synced'); const el = $('#sync-status-text'); if (el) el.textContent = syncText(); },
    'sync-off': () => { if (confirm('Disconnect sync on this device? Your data stays here.')) { sync.token = ''; sync.gistId = ''; saveSyncCfg(); render(); } },
    export: async () => { const r = await store.exportData(data); if (r) toast('Backup exported'); },
    import: async () => {
      const inc = await store.importData();
      if (!inc) return;
      if (inc.error || !Array.isArray(inc.sessions)) { toast(inc && inc.error ? inc.error : 'That file is not a valid backup.'); return; }
      const before = live(data.sessions).length;
      data = mergeData(data, inc);
      persist(true); render();
      toast(`Merged. ${live(data.sessions).length - before} new entries added`);
    }
  };

  function progStep(dir) {
    const p = ui.prog;
    if (p.mode === 'week') p.anchor = addDays(p.anchor, 7 * dir);
    else if (p.mode === 'month') {
      const [y, m] = p.month.split('-').map(Number);
      const d = new Date(y, m - 1 + dir, 1);
      p.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }
    render();
  }

  // live-typing handlers (no re-render, so inputs keep focus)
  const binds = {
    'f-topic': (el) => { ui.form.topic = el.value; },
    'm-calc': () => updateEnd(),
    'sl-calc': () => updateSleepSum(),
    'b-calc': () => updateBlockDur(),
    'jr-q': (el) => {
      ui.jr.q = el.value;
      const v = journalView(), list = $('#jr-list'), cnt = $('#jr-count');
      if (list) list.innerHTML = v.html;
      if (cnt) cnt.textContent = v.count;
    },
    'f-minutes': (el) => { ui.form.minutes = parseInt(el.value, 10) || 0; },
    'imp-title': (el) => { data.important.title = el.value; data.important.titleAt = Date.now(); persist(); },
    'imp-item': (el) => { const it = data.important.items.find((x) => x.id === el.dataset.id); if (it) { it.text = el.value; touch(it); persist(); } },
    'run-comment': (el) => { if (data.timer) { data.timer.comment = el.value; data.timerUpdatedAt = Date.now(); persist(); } },
    journal: (el) => {
      const d = ui.date;
      if (!el.value.trim() && !data.journal[d]) return;
      data.journal[d] = { text: el.value, updatedAt: Date.now() };
      persist();
    }
  };
  // committed-value handlers
  const changes = {
    'date-pick': (el) => { if (el.value) { ui.date = el.value; render(); } },
    'f-topic-change': (el) => {
      const hit = live(data.topics).find((x) => x.name.toLowerCase() === el.value.trim().toLowerCase());
      if (hit) { ui.form.priority = hit.priority; render(); }
    },
    'gap-cap': (el) => { data.settings.gapCapMin = Math.min(720, Math.max(10, parseInt(el.value, 10) || 120)); touch(data.settings); persist(true); render(); toast('Updated'); },

    'pt-val': (el) => {
      const k = el.dataset.key; if (!(k in PT_DEFAULTS)) return;
      if (ptLocked()) { toast(lockMsg()); render(); return; }
      const old = ptv()[k], nv = Math.max(0, parseFloat(el.value) || 0);
      if (nv === old) { render(); return; }
      data.pointsCfg.v[k] = nv; touch(data.pointsCfg);
      ptLog(`${(PT_LABELS.find((x) => x[0] === k) || [k, k])[1]}: ${old} → ${nv}`);
      persist(true); render();
    },
    'loan-auto': (el) => {
      const t = todayStr(), log = (data.pointsCfg.autoLog || []).filter((e) => e.d !== t);
      log.push({ d: t, on: !!el.checked }); data.pointsCfg.autoLog = log; touch(data.pointsCfg);
      ptLog(`Loan auto-repay turned ${el.checked ? 'on' : 'off'}`);
      persist(true); render();
    },
    'pt-planby': (el) => {
      if (ptLocked()) { toast(lockMsg()); render(); return; }
      if (el.value && el.value !== data.pointsCfg.planBy) { ptLog(`Plan the day by: ${data.pointsCfg.planBy} → ${el.value}`); data.pointsCfg.planBy = el.value; touch(data.pointsCfg); persist(true); render(); }
    },
    'pt-pen': (el) => {
      if (ptLocked()) { toast(lockMsg()); render(); return; }
      data.pointsCfg.penalties = !!el.checked; touch(data.pointsCfg);
      ptLog(`Penalties for missed goals and blocks: ${el.checked ? 'on' : 'off'}`);
      persist(true); render();
    },
    'pt-start': (el) => {
      if (ptLocked()) { toast(lockMsg()); render(); return; }
      if (el.value && el.value !== data.pointsCfg.startDate) { ptLog(`Count points from: ${data.pointsCfg.startDate} → ${el.value}`); data.pointsCfg.startDate = el.value; touch(data.pointsCfg); persist(true); render(); }
    },
    'topic-subject': (el) => { const t = data.topics.find((x) => x.id === el.dataset.id); if (t) { if (el.value) t.subjectId = el.value; else delete t.subjectId; touch(t); persist(true); render(); } },
    'imp-done': (el) => { const it = data.important.items.find((x) => x.id === el.dataset.id); if (it) { it.done = !!el.checked; touch(it); persist(true); render(); } },
    'block-mode': (el) => { data.settings.blockMode = el.value === 'countdown' ? 'countdown' : 'stopwatch'; touch(data.settings); persist(true); toast('Updated'); },
    'block-ting': (el) => { data.settings.blockTing = !!el.checked; touch(data.settings); persist(true); },
    'ask-focus': (el) => { data.settings.askFocus = !!el.checked; touch(data.settings); persist(true); },
    sound: (el) => { data.settings.sound = !!el.checked; touch(data.settings); persist(true); if (el.checked) ting(); },
    'tt-date': (el) => { if (el.value) { ui.tt.date = el.value; render(); } },
    'tt-anchor': (el) => { data.settings.dayStart = el.value || '05:00'; touch(data.settings); persist(true); render(); },
    'jr-month': (el) => { ui.jr.month = el.value; render(); },
    'prog-month': (el) => { if (el.value) { ui.prog.month = el.value; render(); } },
    'prog-anchor': (el) => { if (el.value) { ui.prog.anchor = el.value; render(); } },
    'prog-from': (el) => { if (el.value) { ui.prog.from = el.value; render(); } },
    'prog-to': (el) => { if (el.value) { ui.prog.to = el.value; render(); } },
    goal: (el) => {
      data.settings.dailyGoalMin = Math.max(0, parseInt(el.value, 10) || 0);
      touch(data.settings); persist(true); toast('Goal updated');
    }
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el, e);
  });
  document.addEventListener('click', (e) => { if (e.target.closest('#mini')) { ui.page = 'today'; render(); } });
  document.addEventListener('input', (e) => { const f = binds[e.target.dataset && e.target.dataset.bind]; if (f) f(e.target); });
  document.addEventListener('change', (e) => { const f = changes[e.target.dataset && e.target.dataset.change]; if (f) f(e.target); });

  // ---------- boot ----------
  (async function init() {
    data = normalize(await store.load());
    // the clock may have ticked past midnight while the app was closed
    render();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
    setInterval(tick, 500);
    if (sync.token) runSync();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
    // expose a small hook for automated tests
    window.__st = { get data() { return data; }, ui, render, computePoints, rewardState, rewardPrice, levelOf, subjectGroups, actualRaw, donutSlices, weekReview, parseQuickEntry, streak, dayStats, isRest, ting, weekStats, mergeData, todayStr, resolvePlan, blockActual, blockTimes, blockStatus, parseQuickLines, activePlanDate, ttDate, anchorMs };
  })();
})();

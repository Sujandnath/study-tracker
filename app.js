'use strict';
(() => {
  /* =====================================================================
   *  Study Tracker – renderer
   *
   *  Data model (identical on every device, so Windows and Android can
   *  later be linked and merged):
   *    topics   [{id, name, type, priority, updatedAt, deleted}]
   *    presets  [{id, name, topic, type, priority, minutes, updatedAt, deleted}]
   *    sessions [{id, date:'YYYY-MM-DD', start:ms, seconds, topic, type,
   *               priority, comment, updatedAt, deleted}]
   *    journal  { 'YYYY-MM-DD': {text, updatedAt} }
   *    settings {dailyGoalMin, updatedAt}
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

  const TYPES = {
    study: { label: 'Study', color: '#2563eb' },
    break: { label: 'Break', color: '#38bdf8' },
    other: { label: 'Other', color: '#94a3b8' }
  };
  const PRIOS = {
    high: { label: 'High', color: '#e11d48', bg: '#fff1f2' },
    medium: { label: 'Medium', color: '#d97706', bg: '#fffbeb' },
    low: { label: 'Low', color: '#059669', bg: '#ecfdf5' }
  };
  const prioPill = (p) => `<span class="pill" style="background:${PRIOS[p].bg};color:${PRIOS[p].color}">${PRIOS[p].label}</span>`;
  const typeDot = (t) => `<span class="tdot" style="background:${TYPES[t].color}"></span>`;
  const defaultLabel = (type) => (type === 'break' ? 'Break' : type === 'other' ? 'Activity' : 'Study session');

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
      presets: [
        { id: uid(), name: 'Pomodoro 25', topic: '', type: 'study', priority: 'medium', minutes: 25, updatedAt: t },
        { id: uid(), name: 'Deep focus 50', topic: '', type: 'study', priority: 'high', minutes: 50, updatedAt: t },
        { id: uid(), name: 'Short break 5', topic: '', type: 'break', priority: 'low', minutes: 5, updatedAt: t }
      ],
      sessions: [],
      journal: {},
      settings: { dailyGoalMin: 240, updatedAt: t },
      timer: null
    };
  }
  function normalize(d) {
    const base = defaults();
    d = d && typeof d === 'object' ? d : base;
    d.version = 1;
    d.deviceId = d.deviceId || base.deviceId;
    for (const k of ['topics', 'presets', 'sessions']) if (!Array.isArray(d[k])) d[k] = base[k];
    if (!d.journal || typeof d.journal !== 'object') d.journal = {};
    d.settings = Object.assign({ dailyGoalMin: 240, updatedAt: 0 }, d.settings || {});
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
    if ((inc.settings.updatedAt || 0) > (out.settings.updatedAt || 0)) out.settings = inc.settings;
    return out;
  }

  let data;
  const ui = {
    page: 'today',
    date: todayStr(),
    form: { type: 'study', topic: '', priority: 'medium', mode: 'stopwatch', minutes: 25 },
    prog: { mode: 'month', month: todayStr().slice(0, 7), anchor: todayStr(), from: addDays(todayStr(), -29), to: todayStr() }
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
  const syncPayload = (d) => JSON.stringify({ version: 1, topics: d.topics, presets: d.presets, sessions: d.sessions, journal: d.journal, settings: d.settings });

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
  setInterval(() => { if (!document.hidden) runSync(); }, 90000);

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
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 2600);
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
  });

  // ---------- timer ----------
  const elapsedMs = (t) => t.accumulatedMs + (t.startedAt ? Date.now() - t.startedAt : 0);

  function startTimer(spec) {
    const topic = (spec.topic || '').trim();
    data.timer = {
      topic, type: spec.type, priority: spec.priority,
      mode: spec.mode, targetSec: spec.mode === 'countdown' ? Math.round(spec.minutes * 60) : 0,
      accumulatedMs: 0, startedAt: Date.now(), startWall: Date.now(), comment: '', alerted: false
    };
    persist(true);
    ui.page = 'today'; ui.date = todayStr();
    render();
  }
  function pauseTimer() {
    const t = data.timer; if (!t || !t.startedAt) return;
    t.accumulatedMs = elapsedMs(t); t.startedAt = null;
    persist(true); render();
  }
  function resumeTimer() {
    const t = data.timer; if (!t || t.startedAt) return;
    t.startedAt = Date.now();
    persist(true); render();
  }
  function stopTimer(save) {
    const t = data.timer; if (!t) return;
    const secs = Math.round(elapsedMs(t) / 1000);
    data.timer = null;
    if (save && secs >= 1) {
      const name = t.topic || defaultLabel(t.type);
      data.sessions.push(touch({
        id: uid(), date: ymd(new Date(t.startWall)), start: t.startWall, seconds: secs,
        topic: name, type: t.type, priority: t.priority, comment: (t.comment || '').trim()
      }));
      ensureTopic(t.topic, t.type, t.priority);
      ui.date = ymd(new Date(t.startWall));
      toast(`Saved ${short(secs)} of ${name}`);
    } else if (save) {
      toast('Too short to save (under 1 second)');
    }
    persist(true); render();
  }
  function ensureTopic(name, type, priority) {
    name = (name || '').trim();
    if (!name || type === 'break') return;
    const ex = live(data.topics).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!ex) data.topics.push(touch({ id: uid(), name, type, priority }));
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach((delay) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.2);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + delay); o.stop(ctx.currentTime + delay + 0.22);
      });
    } catch { /* audio not available */ }
  }

  function tick() {
    const t = data && data.timer;
    const mini = $('#mini');
    if (!t) { mini.hidden = true; return; }
    const el = elapsedMs(t) / 1000;
    const shown = t.mode === 'countdown' ? Math.max(0, t.targetSec - el) : el;
    const over = t.mode === 'countdown' && el >= t.targetSec;

    if (over && !t.alerted && t.startedAt) {
      t.alerted = true; persist(true);
      beep();
      const label = t.topic || defaultLabel(t.type);
      toast(`Time is up: ${label}`);
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
      if (rem) rem.textContent = t.mode === 'countdown' ? (over ? 'Target reached – overtime' : `of ${short(t.targetSec)} target`) : 'Stopwatch';
      const bar = $('#tbar');
      if (bar) bar.style.width = (t.mode === 'countdown' ? Math.min(100, el / t.targetSec * 100) : 0) + '%';
    }
    document.title = `${hms(shown)} · ${t.topic || defaultLabel(t.type)}`;
  }

  // ---------- derived data ----------
  const sessionsOn = (d) => live(data.sessions).filter((s) => s.date === d).sort((a, b) => a.start - b.start);
  function totals(list) {
    const t = { study: 0, break: 0, other: 0 };
    list.forEach((s) => { t[s.type] = (t[s.type] || 0) + s.seconds; });
    return t;
  }
  function streak() {
    const days = new Set(live(data.sessions).filter((s) => s.type === 'study').map((s) => s.date));
    let d = todayStr(), n = 0;
    if (!days.has(d)) d = addDays(d, -1);
    while (days.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }
  function topicTotal(name) {
    return live(data.sessions).filter((s) => s.topic.toLowerCase() === name.toLowerCase()).reduce((a, s) => a + s.seconds, 0);
  }

  // =====================================================================
  //  TODAY PAGE
  // =====================================================================
  function pageToday() {
    const d = ui.date, isToday = d === todayStr();
    const list = sessionsOn(d);
    const tot = totals(list);
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
      <div class="grid">
        <div class="stack">
          <div class="card">${timerCard()}</div>
        </div>
        <div class="stack">
          <div class="card">
            <h2>Summary <small>${list.length} ${list.length === 1 ? 'entry' : 'entries'}</small></h2>
            <div class="tiles">
              ${['study', 'break', 'other'].map((k) => `
                <div class="tile"><div class="k">${typeDot(k)}${TYPES[k].label}</div><div class="v">${short(tot[k])}</div></div>`).join('')}
            </div>
            <div class="goal">
              <div class="gl"><span>Daily study goal</span><span>${short(tot.study)} / ${short(goal)}</span></div>
              <div class="bar"><i style="width:${pct}%"></i></div>
            </div>
          </div>
          <div class="card">
            <h2>Journal <small>saved automatically</small></h2>
            <textarea data-bind="journal" placeholder="How did the day go? What clicked, what to revisit…">${esc(journal)}</textarea>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:20px">
        <h2>Activity log <button class="btn sm primary" data-action="entry-add">+ Add entry</button></h2>
        ${logTable(list)}
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
            <span class="pill" style="background:#eff6ff;color:${TYPES[t.type].color}">${TYPES[t.type].label}</span>
            ${prioPill(t.priority)}
          </div>
          <div class="clock ${t.startedAt ? '' : 'paused'}" id="clock">00:00:00</div>
          <div class="remain" id="remain"></div>
          <div class="bar"><i id="tbar" style="width:0%"></i></div>
          <div class="timer-actions">
            ${t.startedAt
              ? '<button class="btn big" data-action="pause">Pause</button>'
              : '<button class="btn big primary" data-action="resume">Resume</button>'}
            <button class="btn big primary" data-action="stop">Stop &amp; save</button>
            <button class="btn big danger" data-action="discard">Discard</button>
          </div>
          <input type="text" data-bind="run-comment" placeholder="Add a comment (optional)" value="${esc(t.comment)}">
        </div>`;
    }

    const f = ui.form;
    const topics = live(data.topics).filter((x) => x.type === f.type);
    const presets = live(data.presets);
    return `
      <h2>Start a timer</h2>
      <div class="field">
        <label>Activity</label>
        <div class="seg">
          ${Object.entries(TYPES).map(([k, v]) => `<button class="${f.type === k ? 'on' : ''}" data-action="set-type" data-v="${k}"><span class="dot" style="background:${v.color}"></span>${v.label}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>${f.type === 'break' ? 'Label (optional)' : 'Topic'}</label>
        <input type="text" id="f-topic" list="topic-list" data-bind="f-topic" data-change="f-topic-change" autocomplete="off"
          placeholder="${f.type === 'break' ? 'e.g. Tea, walk, lunch' : 'Type a topic or pick a saved one'}" value="${esc(f.topic)}">
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
      <button class="btn primary big" data-action="start">Start</button>`;
  }

  function logTable(list) {
    if (!list.length) return `<div class="empty"><b>Nothing logged yet</b>Start the timer above, or add an entry manually.</div>`;
    return `
      <div class="tbl-scroll"><table class="tbl">
        <thead><tr><th>#</th><th>Topic</th><th>Time</th><th>Priority</th><th>Duration</th><th>Comment</th><th></th></tr></thead>
        <tbody>
          ${list.map((s, i) => `
            <tr>
              <td class="num">${i + 1}</td>
              <td><div class="topic-cell">${typeDot(s.type)}${esc(s.topic)}</div></td>
              <td>${fmtTime(s.start)}</td>
              <td>${prioPill(s.priority)}</td>
              <td class="dur">${hms(s.seconds)}</td>
              <td class="cmt" title="${esc(s.comment)}">${esc(s.comment)}</td>
              <td class="act">
                <button class="btn sm" data-action="entry-edit" data-id="${s.id}">Edit</button>
                <button class="btn sm danger" data-action="entry-del" data-id="${s.id}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  function chev(dir) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}"/></svg>`;
  }

  // ---------- entry modal (add / edit) ----------
  function entryModal(existing) {
    const s = existing || {
      type: 'study', topic: '', priority: 'medium', seconds: 1800, comment: '',
      start: (() => { const n = new Date(); const base = parseYmd(ui.date); base.setHours(n.getHours(), n.getMinutes(), 0, 0); return base.getTime(); })()
    };
    const startD = new Date(s.start);
    const body = `
      <div class="field"><label>Activity</label>
        <select id="m-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="field"><label>Topic</label>
        <input type="text" id="m-topic" list="m-topics" value="${esc(existing ? s.topic : '')}" placeholder="Topic or label" autocomplete="off">
        <datalist id="m-topics">${live(data.topics).map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div>
      <div class="field"><label>Importance</label>
        <select id="m-prio">${Object.entries(PRIOS).map(([k, v]) => `<option value="${k}" ${s.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="row">
        <div class="field grow"><label>Date</label><input type="date" id="m-date" value="${ymd(startD)}"></div>
        <div class="field grow"><label>Start time</label><input type="time" id="m-time" value="${pad(startD.getHours())}:${pad(startD.getMinutes())}"></div>
      </div>
      <div class="row">
        <div class="field grow"><label>Hours</label><input type="number" id="m-h" min="0" max="23" value="${Math.floor(s.seconds / 3600)}"></div>
        <div class="field grow"><label>Minutes</label><input type="number" id="m-min" min="0" max="59" value="${Math.floor(s.seconds % 3600 / 60)}"></div>
      </div>
      <div class="field"><label>Comment</label><input type="text" id="m-comment" value="${esc(s.comment)}" placeholder="Optional"></div>
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
      Object.assign(rec, { date, start: day.getTime(), seconds: secs, topic, type, priority: prio, comment: $('#m-comment').value.trim() });
      touch(rec);
      if (!existing) data.sessions.push(rec);
      if ($('#m-topic').value.trim()) ensureTopic($('#m-topic').value, type, prio);
      ui.date = date;
      persist(true); render();
    });
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
    const all = live(data.sessions).filter((s) => s.date >= r.from && s.date <= r.to);
    const tot = totals(all);
    const nDays = daysBetween(r.from, r.to);
    const today = todayStr();
    const elapsedDays = Math.max(1, Math.min(nDays, daysBetween(r.from, r.to < today ? r.to : today)));
    const perDay = {};
    all.forEach((s) => { (perDay[s.date] = perDay[s.date] || { study: 0, break: 0, other: 0 })[s.type] += s.seconds; });
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
        <div class="tiles six">
          <div class="tile"><div class="k">Total study</div><div class="v">${short(tot.study)}</div><div class="s">${(tot.study / 3600).toFixed(1)} hours</div></div>
          <div class="tile"><div class="k">Daily average</div><div class="v">${short(tot.study / elapsedDays)}</div><div class="s">over ${elapsedDays} ${elapsedDays === 1 ? 'day' : 'days'}</div></div>
          <div class="tile"><div class="k">Active days</div><div class="v">${activeDays}<span style="font-size:14px;color:var(--muted)"> / ${nDays}</span></div><div class="s">days with study</div></div>
          <div class="tile"><div class="k">Best day</div><div class="v">${best && best.sec ? short(best.sec) : '–'}</div><div class="s">${best && best.sec ? fmtShort(best.d) : 'no data yet'}</div></div>
          <div class="tile"><div class="k">Breaks</div><div class="v">${short(tot.break)}</div><div class="s">${tot.study ? Math.round(tot.break / tot.study * 100) + '% of study' : '–'}</div></div>
          <div class="tile"><div class="k">Streak</div><div class="v">${streak()}<span style="font-size:14px;color:var(--muted)"> ${streak() === 1 ? 'day' : 'days'}</span></div><div class="s">current</div></div>
        </div>

        <div class="card">
          <h2>${nDays > 62 ? 'Weekly' : 'Daily'} time <small>hours</small></h2>
          <div class="chart-wrap">${barChart(r, perDay, nDays)}</div>
          <div class="legend">${Object.entries(TYPES).map(([k, v]) => `<span>${typeDot(k)}${v.label}</span>`).join('')}</div>
        </div>

        ${p.mode === 'month' ? `<div class="card"><h2>Calendar <small>darker = more study · click a day to open it</small></h2>${heatmap(r, perDay)}</div>` : ''}

        <div class="two">
          <div class="card"><h2>By topic <small>study + other</small></h2>${topicBreakdown(all)}</div>
          <div class="card"><h2>By importance <small>study + other</small></h2>${prioBreakdown(all)}<div style="height:18px"></div><h2>Time split</h2>${splitBar(tot)}</div>
        </div>
      </div>`;
  }

  function barChart(r, perDay, nDays) {
    // bucket by day (<= 62 days) or by week
    const buckets = [];
    if (nDays <= 62) {
      for (let i = 0; i < nDays; i++) {
        const d = addDays(r.from, i), x = perDay[d] || { study: 0, break: 0, other: 0 };
        buckets.push({ label: String(parseYmd(d).getDate()), tip: `${fmtShort(d)}`, ...x });
      }
    } else {
      let cur = r.from;
      while (cur <= r.to) {
        const end = addDays(cur, 6) > r.to ? r.to : addDays(cur, 6);
        const b = { label: fmtShort(cur), tip: `${fmtShort(cur)} – ${fmtShort(end)}`, study: 0, break: 0, other: 0 };
        for (let d = cur; d <= end; d = addDays(d, 1)) { const x = perDay[d]; if (x) { b.study += x.study; b.break += x.break; b.other += x.other; } }
        buckets.push(b); cur = addDays(end, 1);
      }
    }
    const narrow = window.innerWidth <= 760;
    const W = narrow ? 400 : 820, H = narrow ? 230 : 250, L = narrow ? 40 : 46, R = 6, T = 12, B = 28;
    const iw = W - L - R, ih = H - T - B;
    const maxH = Math.max(...buckets.map((b) => (b.study + b.break + b.other) / 3600), 0);
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
      const tip = `${b.tip}\nStudy ${short(b.study)} · Break ${short(b.break)} · Other ${short(b.other)}`;
      ['study', 'break', 'other'].forEach((k) => {
        const h = b[k] / 3600;
        if (h <= 0) return;
        const y1 = y(acc + h), y0 = y(acc);
        g += `<rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1)}" fill="${TYPES[k].color}" rx="${k === 'study' ? 3 : 0}"><title>${esc(tip)}</title></rect>`;
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
      h += `<div class="day l${lvl} ${d > today ? 'future' : ''} ${d === today ? 'is-today' : ''}" data-action="goto-day" data-date="${d}" title="${fmtLong(d)}: ${short(sec)} study">
        <span class="n">${parseYmd(d).getDate()}</span><span class="t">${sec ? short(sec) : ''}</span></div>`;
    }
    const sw = ['#f1f5f9', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8'].map((c) => `<i style="background:${c}"></i>`).join('');
    return `<div class="cal">${h}</div><div class="cal-legend">Less ${sw} More <span style="margin-left:8px">(goal = ${short(goal)})</span></div>`;
  }

  function topicBreakdown(list) {
    const map = new Map();
    list.filter((s) => s.type !== 'break').forEach((s) => {
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
    list.filter((s) => s.type !== 'break').forEach((s) => { t[s.priority] += s.seconds; });
    const max = Math.max(...Object.values(t), 1);
    return Object.entries(PRIOS).map(([k, v]) => `
      <div class="hrow"><div class="nm">${prioPill(k)}</div>
        <div class="bar"><i style="width:${t[k] / max * 100}%;background:${v.color}"></i></div>
        <div class="val">${short(t[k])}</div></div>`).join('');
  }
  function splitBar(tot) {
    const sum = tot.study + tot.break + tot.other;
    if (!sum) return '<div class="note">Nothing logged in this range.</div>';
    return `<div class="stackbar">${['study', 'break', 'other'].map((k) => `<i style="width:${tot[k] / sum * 100}%;background:${TYPES[k].color}" title="${TYPES[k].label} ${short(tot[k])}"></i>`).join('')}</div>
      <div class="legend">${['study', 'break', 'other'].map((k) => `<span>${typeDot(k)}${TYPES[k].label} ${Math.round(tot[k] / sum * 100)}%</span>`).join('')}</div>`;
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
          <div class="card">
            <h2>Topics <button class="btn sm primary" data-action="topic-add">+ New topic</button></h2>
            ${topics.length ? topics.map((t) => `
              <div class="list-row">
                <div class="grow"><div class="nm">${typeDot(t.type)}${esc(t.name)}</div>
                  <div class="meta">${TYPES[t.type].label} · ${short(topicTotal(t.name))} logged in total</div></div>
                ${prioPill(t.priority)}
                <button class="btn sm" data-action="topic-edit" data-id="${t.id}">Edit</button>
                <button class="btn sm danger" data-action="topic-del" data-id="${t.id}">Delete</button>
              </div>`).join('')
            : '<div class="empty"><b>No saved topics yet</b>Add one here, or just start a timer – new topics are saved automatically.</div>'}
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <h2>Presets <button class="btn sm primary" data-action="preset-add">+ New preset</button></h2>
            ${presets.length ? presets.map((p) => `
              <div class="list-row">
                <div class="grow"><div class="nm">${typeDot(p.type)}${esc(p.name)}</div>
                  <div class="meta">${prioPill(p.priority)} ${p.minutes ? p.minutes + ' min' : 'Stopwatch'}${p.topic ? ' · ' + esc(p.topic) : ''}</div></div>
                <button class="btn sm primary" data-action="preset-start" data-id="${p.id}" ${data.timer ? 'disabled title="A timer is already running"' : ''}>Start</button>
                <button class="btn sm" data-action="preset-edit" data-id="${p.id}">Edit</button>
                <button class="btn sm danger" data-action="preset-del" data-id="${p.id}">Delete</button>
              </div>`).join('') : '<div class="empty"><b>No presets</b>A preset remembers a topic, importance and duration.</div>'}
          </div>
          ${syncCard()}
          <div class="card">
            <h2>Settings &amp; backup</h2>
            <div class="field"><label>Daily study goal (minutes)</label>
              <input type="number" min="0" max="1440" step="15" data-change="goal" value="${data.settings.dailyGoalMin}"></div>
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
      <div class="field"><label>Type</label><select id="t-type">${['study', 'other'].map((k) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${TYPES[k].label}</option>`).join('')}</select></div>
      <div class="field"><label>Default importance</label><select id="t-prio">${Object.entries(PRIOS).map(([k, v]) => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>`,
    () => {
      const name = $('#t-name').value.trim();
      if (!name) { toast('Give the topic a name'); return false; }
      const dup = live(data.topics).find((x) => x.name.toLowerCase() === name.toLowerCase() && (!existing || x.id !== existing.id));
      if (dup) { toast('A topic with that name already exists'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, { name, type: $('#t-type').value, priority: $('#t-prio').value });
      touch(rec);
      if (!existing) data.topics.push(rec);
      persist(true); render();
    });
  }

  function presetModal(existing) {
    const p = existing || { name: '', topic: '', type: 'study', priority: 'medium', minutes: 25 };
    openModal(existing ? 'Edit preset' : 'New preset', `
      <div class="field"><label>Preset name</label><input type="text" id="p-name" value="${esc(p.name)}" placeholder="e.g. Physics deep focus"></div>
      <div class="field"><label>Activity</label><select id="p-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
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
  //  RENDER + EVENTS
  // =====================================================================
  function render() {
    $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === ui.page));
    const main = $('#main');
    const keep = main.scrollTop;
    main.innerHTML = ui.page === 'today' ? pageToday() : ui.page === 'progress' ? pageProgress() : pageLibrary();
    main.scrollTop = keep;
    if (ui.page === 'library') store.location().then((p) => { const el = $('#loc'); if (el) el.textContent = 'Data file: ' + p; });
    if (ui.page !== 'today') document.title = 'Study Tracker';
    tick();
  }

  function applyPreset(p) {
    ui.form = { type: p.type, topic: p.topic || '', priority: p.priority, mode: p.minutes ? 'countdown' : 'stopwatch', minutes: p.minutes || 25 };
  }

  const actions = {
    nav: (el) => { ui.page = el.dataset.page; render(); },
    'modal-bg': (el, e) => { if (e.target === el) closeModal(); },
    'modal-close': () => closeModal(),

    'date-prev': () => { ui.date = addDays(ui.date, -1); render(); },
    'date-next': () => { ui.date = addDays(ui.date, 1); render(); },
    'date-today': () => { ui.date = todayStr(); render(); },
    'goto-day': (el) => { ui.date = el.dataset.date; ui.page = 'today'; render(); },

    'set-type': (el) => {
      ui.form.type = el.dataset.v;
      if (ui.form.type === 'break') { ui.form.priority = 'low'; }
      render();
    },
    'set-prio': (el) => { ui.form.priority = el.dataset.v; render(); },
    'set-mode': (el) => { ui.form.mode = el.dataset.v; render(); },
    'use-preset': (el) => { const p = live(data.presets).find((x) => x.id === el.dataset.id); if (p) { applyPreset(p); render(); toast(`Preset loaded: ${p.name}`); } },
    start: () => {
      const f = ui.form;
      if (f.mode === 'countdown' && !(f.minutes > 0)) { toast('Enter the countdown minutes'); return; }
      startTimer(f);
    },
    pause: pauseTimer,
    resume: resumeTimer,
    stop: () => stopTimer(true),
    discard: () => { if (confirm('Discard this timer without saving?')) stopTimer(false); },

    'entry-add': () => entryModal(null),
    'entry-edit': (el) => { const s = live(data.sessions).find((x) => x.id === el.dataset.id); if (s) entryModal(s); },
    'entry-del-modal': (el) => {
      const s = live(data.sessions).find((x) => x.id === el.dataset.id);
      if (s && confirm(`Delete "${s.topic}" (${short(s.seconds)})?`)) { s.deleted = true; touch(s); closeModal(); persist(true); render(); }
    },
    'entry-del': (el) => {
      const s = live(data.sessions).find((x) => x.id === el.dataset.id);
      if (s && confirm(`Delete "${s.topic}" (${short(s.seconds)})?`)) { s.deleted = true; touch(s); persist(true); render(); }
    },

    'prog-mode': (el) => { ui.prog.mode = el.dataset.v; render(); },
    'prog-prev': () => progStep(-1),
    'prog-next': () => progStep(1),
    'prog-now': () => { ui.prog.month = todayStr().slice(0, 7); ui.prog.anchor = todayStr(); render(); },

    'topic-add': () => topicModal(null),
    'topic-edit': (el) => { const t = live(data.topics).find((x) => x.id === el.dataset.id); if (t) topicModal(t); },
    'topic-del': (el) => {
      const t = live(data.topics).find((x) => x.id === el.dataset.id);
      if (t && confirm(`Delete topic "${t.name}"? Logged time stays in your history.`)) { t.deleted = true; touch(t); persist(true); render(); }
    },
    'preset-add': () => presetModal(null),
    'preset-edit': (el) => { const p = live(data.presets).find((x) => x.id === el.dataset.id); if (p) presetModal(p); },
    'preset-del': (el) => {
      const p = live(data.presets).find((x) => x.id === el.dataset.id);
      if (p && confirm(`Delete preset "${p.name}"?`)) { p.deleted = true; touch(p); persist(true); render(); }
    },
    'preset-start': (el) => {
      const p = live(data.presets).find((x) => x.id === el.dataset.id);
      if (!p || data.timer) return;
      startTimer({ type: p.type, topic: p.topic, priority: p.priority, mode: p.minutes ? 'countdown' : 'stopwatch', minutes: p.minutes });
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
    'f-minutes': (el) => { ui.form.minutes = parseInt(el.value, 10) || 0; },
    'run-comment': (el) => { if (data.timer) { data.timer.comment = el.value; persist(); } },
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
    setInterval(tick, 500);
    if (sync.token) runSync();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
    // expose a small hook for automated tests
    window.__st = { get data() { return data; }, ui, render, mergeData, todayStr };
  })();
})();

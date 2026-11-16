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
  // turns http(s):// and www. links in plain text into clickable links (text is escaped first)
  function linkify(text) {
    return esc(text).replace(/\b((?:https?:\/\/|www\.)[^\s<]+)/gi, (u) => {
      let tail = ''; while (/[.,;:!?)\]]$/.test(u)) { tail = u.slice(-1) + tail; u = u.slice(0, -1); }
      const href = /^www\./i.test(u) ? 'https://' + u : u;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="lnk">${u}</a>${tail}`;
    });
  }
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
      pauses: [],
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
      settings: { dailyGoalMin: 240, dayStart: '05:00', gapCapMin: 120, sound: true, askFocus: true, restPerWeek: 1, blockMode: 'stopwatch', blockTing: true, blockMin: 60, pauseBudget: 10, longPause: 15, updatedAt: t },
      timer: null,
      timerUpdatedAt: 0
    };
  }
  function normalize(d) {
    const base = defaults();
    d = d && typeof d === 'object' ? d : base;
    d.version = 1;
    d.deviceId = d.deviceId || base.deviceId;
    for (const k of ['topics', 'subjects', 'rewards', 'redemptions', 'pauses', 'pointsLog', 'loans', 'repayments', 'presets', 'sessions', 'templates']) if (!Array.isArray(d[k])) d[k] = base[k];
    if (!d.plans || typeof d.plans !== 'object' || Array.isArray(d.plans)) d.plans = {};
    if (!Array.isArray(d.categories)) d.categories = [];
    BUILTIN_CATS.forEach((b) => { if (!d.categories.some((x) => x.id === b.id)) d.categories.push({ ...b, updatedAt: 0 }); });
    d.timerUpdatedAt = d.timerUpdatedAt || 0;
    if (!d.journal || typeof d.journal !== 'object') d.journal = {};
    for (const k of ['rest', 'checkins']) if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) d[k] = {};
    if (!d.important || typeof d.important !== 'object' || Array.isArray(d.important)) d.important = {};
    if (!d.pointsCfg || typeof d.pointsCfg !== 'object' || Array.isArray(d.pointsCfg)) d.pointsCfg = { updatedAt: 0 };
    d.pointsCfg.subjFrom = d.pointsCfg.subjFrom || todayStr(); // the daily every-subject goal starts counting the day it is first opened
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
    d.settings = Object.assign({ dailyGoalMin: 240, dayStart: '05:00', gapCapMin: 120, sound: true, askFocus: true, restPerWeek: 1, blockMode: 'stopwatch', blockTing: true, blockMin: 60, pauseBudget: 10, longPause: 15, updatedAt: 0 }, d.settings || {});
    if (!d.settings.medSeeded) {
      if (!d.categories.some((x) => x.id === 'meditation' || (!x.deleted && /medit/i.test(x.name || '')))) d.categories.push({ id: 'meditation', name: 'Meditation', color: '#8b5cf6', kind: 'neutral', updatedAt: 0 });
      d.settings.medSeeded = true;
    }
    if (!d.settings.routineSeeded) { // small rewards for logging meals and showers, set once (editable on each category)
      d.categories.forEach((x) => { if (x.deleted || x.earn || x.kind !== 'neutral') return;
        if (/meal|breakfast|lunch|dinner|food/i.test(x.name || '')) x.earn = { pts: 2, max: 3, min: 10 };
        else if (/shower|bath/i.test(x.name || '')) x.earn = { pts: 2, max: 1, min: 3 }; });
      d.settings.routineSeeded = true;
    }
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
    out.pauses = mergeById(out.pauses, inc.pauses);
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
    ms: { open: (() => { try { return localStorage.getItem('st-ms-open') !== '0'; } catch (e) { return true; } })(), all: false },
    ib: { open: (() => { try { return localStorage.getItem('st-ib-open') !== '0'; } catch (e) { return true; } })() },
    undoOpen: (() => { try { return localStorage.getItem('st-undo-open') === '1'; } catch (e) { return false; } })(),
    rw: { open: {}, goalsDone: false, mode: 'day', date: null, month: null, from: null, to: null, logAll: false, set: (() => { try { return localStorage.getItem('st-pt-set') === '1'; } catch (e) { return false; } })() },
    form: { type: 'study', topic: '', priority: 'medium', mode: 'stopwatch', minutes: 25 },
    prog: { mode: 'month', month: todayStr().slice(0, 7), anchor: todayStr(), from: addDays(todayStr(), -29), to: todayStr(), incOther: false, open: {} }
  };

  let saveTimer;
  // =====================================================================
  //  CHANGE HISTORY: the last changes you made, each one undoable.
  //  Kept on this device only (not synced). Points settings, the lock, the
  //  loan and the timer are deliberately not part of it.
  // =====================================================================
  const HIST_ARR = ['sessions', 'topics', 'subjects', 'presets', 'rewards', 'redemptions', 'categories', 'templates'];
  const HIST_MAP = ['journal', 'checkins', 'plans', 'rest'];
  const HIST_KEY = 'studytracker-history';
  let hist = [], histSnapState = null, histSuppress = false;
  try { hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); if (!Array.isArray(hist)) hist = []; } catch (e) { hist = []; }
  const histSave = () => { try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, 30))); } catch (e) { /* storage unavailable */ } };
  const histStrip = (j) => String(j).replace(/"updatedAt":\d+,?/g, '');
  function histItems(k) { return k === 'important' ? data.important.items : data[k]; }
  function histBuild() {
    const s = { a: {}, m: {}, set: {}, setU: (data.settings && data.settings.updatedAt) || 0 };
    HIST_ARR.concat('important').forEach((k) => { const mp = new Map(); histItems(k).forEach((r) => mp.set(r.id, { u: r.updatedAt || 0, d: !!r.deleted, j: JSON.stringify(r) })); s.a[k] = mp; });
    HIST_MAP.forEach((k) => { const mp = new Map(); Object.keys(data[k] || {}).forEach((key) => { const r = data[k][key]; mp.set(key, { u: (r && r.updatedAt) || 0, j: JSON.stringify(r) }); }); s.m[k] = mp; });
    Object.keys(data.settings || {}).forEach((k) => { if (k !== 'updatedAt') s.set[k] = JSON.stringify(data.settings[k]); });
    return s;
  }
  function histRebase() { try { histSnapState = histBuild(); } catch (e) { histSnapState = null; } }
  function histDiff() {
    const s = histSnapState, out = [];
    HIST_ARR.concat('important').forEach((k) => {
      const old = s.a[k];
      histItems(k).forEach((r) => {
        const o = old.get(r.id), u = r.updatedAt || 0, d = !!r.deleted;
        if (!o) { const j = JSON.stringify(r); old.set(r.id, { u, d, j }); if (!d) out.push({ coll: k, key: r.id, kind: 'add', before: null, after: j }); }
        else if (o.u !== u || o.d !== d) {
          const j = JSON.stringify(r); old.set(r.id, { u, d, j });
          if (histStrip(j) !== histStrip(o.j)) out.push({ coll: k, key: r.id, kind: !o.d && d ? 'delete' : o.d && !d ? 'restore' : 'edit', before: o.j, after: j });
        }
      });
    });
    HIST_MAP.forEach((k) => {
      const old = s.m[k];
      Object.keys(data[k] || {}).forEach((key) => {
        const r = data[k][key], o = old.get(key), u = (r && r.updatedAt) || 0;
        if (!o || o.u !== u) { const j = JSON.stringify(r); old.set(key, { u, j }); if (!o || histStrip(o.j) !== histStrip(j)) out.push({ coll: k, key, kind: o ? 'edit' : 'add', before: o ? o.j : null, after: j }); }
      });
    });
    if (((data.settings && data.settings.updatedAt) || 0) !== s.setU) {
      s.setU = data.settings.updatedAt || 0;
      Object.keys(data.settings).forEach((k) => { if (k === 'updatedAt') return; const j = JSON.stringify(data.settings[k]); if (s.set[k] !== j) { out.push({ coll: 'settings', key: k, kind: 'edit', before: s.set[k] === undefined ? null : s.set[k], after: j }); s.set[k] = j; } });
    }
    return out;
  }
  const HIST_NOUN = { sessions: 'entry', topics: 'topic', subjects: 'subject', presets: 'preset', rewards: 'reward', redemptions: 'redemption', categories: 'category', templates: 'template', important: 'important topic', plans: 'plan', journal: 'journal', checkins: 'check-in', rest: 'rest day', settings: 'setting' };
  function histLabel(e) {
    let r = {}; try { r = JSON.parse(e.after !== null && e.after !== undefined ? e.after : e.before) || {}; } catch (x) { r = {}; }
    const verb = { add: 'Added', edit: 'Edited', delete: 'Deleted', restore: 'Restored' }[e.kind];
    let what = '';
    if (e.coll === 'sessions') what = `${r.topic || 'entry'} · ${short(r.seconds || 0)}`;
    else if (e.coll === 'redemptions') return `Redeemed ${r.name} (−${r.cost})`.replace('Redeemed', e.kind === 'delete' ? 'Returned' : 'Redeemed');
    else if (e.coll === 'important') what = r.text || '';
    else if (['plans', 'journal', 'checkins', 'rest'].includes(e.coll)) what = fmtShort(e.key);
    else if (e.coll === 'settings') what = `${e.key} ${e.before === null ? '' : JSON.parse(e.before) + ' → '}${JSON.parse(e.after)}`;
    else what = r.name || '';
    return `${verb} ${HIST_NOUN[e.coll]}: ${what}`.trim();
  }
  function histCapture() {
    if (!data) return;
    if (!histSnapState || histSuppress) { histSuppress = false; histRebase(); return; }
    let ents; try { ents = histDiff(); } catch (e) { histRebase(); return; }
    if (!ents.length) return;
    const sessionTopics = new Set(ents.filter((e) => e.coll === 'sessions' && e.kind === 'add').map((e) => { try { return String(JSON.parse(e.after).topic || '').toLowerCase(); } catch (x) { return ''; } }));
    const now = Date.now();
    ents.forEach((e) => {
      if (e.coll === 'topics' && e.kind === 'add') { try { if (sessionTopics.has(String(JSON.parse(e.after).name || '').toLowerCase())) return; } catch (x) { /* keep */ } }
      const last = hist[0];
      if (last && last.coll === e.coll && last.key === e.key && now - last.at < 120000 && e.kind === 'edit' && (last.kind === 'edit' || last.kind === 'add')) {
        last.after = e.after; last.at = now; last.label = histLabel(last);
        if (last.kind === 'edit' && last.before !== null && histStrip(last.before) === histStrip(last.after)) hist.shift();
        return;
      }
      const item = { id: uid(), at: now, ...e }; item.label = histLabel(item); hist.unshift(item);
    });
    hist = hist.slice(0, 30); histSave();
  }
  function histUndo(id) {
    const i = hist.findIndex((h) => h.id === id), h = hist[i]; if (!h) return;
    if (h.coll === 'rewards' && h.kind === 'edit' && ptLocked()) { toast(lockMsg()); return; }
    const before = h.before !== null && h.before !== undefined ? JSON.parse(h.before) : null, now = Date.now();
    if (h.coll === 'settings') {
      if (h.before === null) delete data.settings[h.key]; else data.settings[h.key] = before;
      touch(data.settings);
    } else if (HIST_MAP.includes(h.coll)) {
      data[h.coll][h.key] = before ? { ...before, updatedAt: now } : h.coll === 'plans' ? { deleted: true, updatedAt: now } : h.coll === 'journal' ? { text: '', updatedAt: now } : h.coll === 'rest' ? { on: false, updatedAt: now } : { updatedAt: now };
    } else {
      const arr = histItems(h.coll), idx = arr.findIndex((r) => r.id === h.key);
      if (h.kind === 'add') { if (idx >= 0) { arr[idx].deleted = true; touch(arr[idx]); } }
      else { const obj = { ...before, updatedAt: now }; if (idx >= 0) arr[idx] = obj; else arr.push(obj); }
    }
    hist.splice(i, 1); histSave();
    histSuppress = true; persist(true); render(); toast(`Undone: ${h.label}`);
  }
  const histAgo = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : fmtShort(ymd(new Date(t))); };
  function undoCard() {
    const open = ui.undoOpen, items = hist.slice(0, 10);
    return `<div class="card"><h2>Undo <small>last 10 changes</small><button class="btn sm" data-action="undo-toggle">${open ? 'Hide' : 'Show'}</button></h2>
      ${open ? (items.length ? items.map((h) => `<div class="list-row"><div class="grow"><div class="nm">${esc(h.label)}</div><div class="meta">${histAgo(h.at)}</div></div><button class="btn sm" data-action="hist-undo" data-id="${h.id}">Undo</button></div>`).join('')
        : '<div class="note">Changes you make will appear here so you can undo them. Points settings, loans and timers are not included.</div>') : ''}
    </div>`;
  }

  function persist(immediate) {
    histCapture();
    clearTimeout(saveTimer);
    if (immediate) store.save(data);
    else saveTimer = setTimeout(() => store.save(data), 300);
    scheduleSync();
    bkSoon();
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
  const syncPayload = (d) => JSON.stringify({ version: 1, topics: d.topics, subjects: d.subjects, rewards: d.rewards, redemptions: d.redemptions, pauses: d.pauses, pointsCfg: d.pointsCfg, pointsLog: d.pointsLog, loans: d.loans, repayments: d.repayments, presets: d.presets, sessions: d.sessions, journal: d.journal, important: d.important, rest: d.rest, checkins: d.checkins, plans: d.plans, templates: d.templates, categories: d.categories, timer: d.timer || null, timerUpdatedAt: d.timerUpdatedAt || 0, settings: d.settings });

  async function runSync() {
    if (!sync.token) return;
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true; setSyncStatus('Syncing…');
    try {
      if (!sync.gistId) sync.gistId = await findGist();
      const remote = sync.gistId ? await readGist(sync.gistId) : null;
      const before = syncPayload(data);
      if (remote) { data = mergeData(data, remote); histRebase(); }
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
      blockId: spec.blockId || null, planDate: spec.planDate || null, planSec: spec.mode === 'stopwatch' ? Math.round(spec.planSec || 0) : 0,
      roundBreak: !!spec.roundBreak
    };
    data.timerUpdatedAt = Date.now();
    persist(true);
    ui.page = 'today'; ui.date = todayStr();
    render();
  }
  const PAUSE_REASONS = [['water', '💧', 'Water'], ['phone', '📱', 'Phone'], ['washroom', '🚻', 'Washroom'], ['distracted', '🌀', 'Distracted'], ['other', '✨', 'Other']];
  const pmm = (s) => { s = Math.max(0, Math.floor(s)); return s >= 3600 ? hms(s) : String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const pauseBudgetMin = () => (data.settings.pauseBudget === undefined ? 10 : data.settings.pauseBudget);
  const longPauseMin = () => (data.settings.longPause === undefined ? 15 : data.settings.longPause);
  // soft allowance: N minutes of pause for every hour of session (at least one hour's worth)
  function pauseAllowance(t, ps) {
    const b = pauseBudgetMin(); if (!b) return 0;
    const span = elapsedMs(t) / 1000 + (t.pauseSec || 0) + ps;
    return b * 60 * Math.max(1, span / 3600);
  }
  function pauseTimer() {
    const t = data.timer; if (!t || !t.startedAt) return;
    const study = isStudyTimer(t);
    t.accumulatedMs = elapsedMs(t); t.startedAt = null; t.pausedAt = study ? Date.now() : null; t.pauseAlerted = false; t.overAlerted = false; data.timerUpdatedAt = Date.now();
    if (study) ui.tAnim = 'pause'; persist(true); render();
  }
  // closes the current pause; a pause of a minute or more becomes a pause record (separate from break time)
  function endPause(t) {
    if (!t || !t.pausedAt) return null;
    const start = t.pausedAt, ms = Date.now() - start;
    t.pausedAt = null; t.pauseAlerted = false; t.overAlerted = false;
    if (ms < 60000) return null;
    const rec = touch({ id: uid(), date: sessionDate(t.type, start, 0), start, seconds: Math.round(ms / 1000), reason: '', topic: t.topic || defaultLabel(t.type), type: t.type, sessionId: t.id ? 'tm-' + t.id : '' });
    data.pauses.push(rec);
    t.pauseSec = (t.pauseSec || 0) + rec.seconds; t.pauseN = (t.pauseN || 0) + 1;
    return rec;
  }
  function resumeTimer() {
    const t = data.timer; if (!t || t.startedAt) return;
    ui.lastPause = t.pausedAt ? Math.round((Date.now() - t.pausedAt) / 1000) : 0;
    const rec = endPause(t);
    t.startedAt = Date.now(); data.timerUpdatedAt = Date.now();
    if (isStudyTimer(t)) ui.tAnim = 'run'; persist(true); render();
    if (rec) askPauseReason(rec.id);
  }
  let paskT = null;
  function hidePask() { const el = $('#pask'); if (!el) return; clearTimeout(paskT); el.classList.add('out'); setTimeout(() => { if (el.classList.contains('out')) el.remove(); }, 260); }
  function askPauseReason(id) {
    const p = data.pauses.find((x) => x.id === id); if (!p) return;
    const old = $('#pask'); if (old) old.remove();
    const el = document.createElement('div'); el.id = 'pask'; el.className = 'pask';
    el.innerHTML = `<div class="pask-t"><span class="pask-ic">⏸</span><div><b>Paused ${short(p.seconds)}</b><span>What pulled you away?</span></div></div>
      <div class="pask-c">${PAUSE_REASONS.map(([k, e, l]) => `<button data-action="pause-reason" data-id="${id}" data-v="${k}"><i>${e}</i>${l}</button>`).join('')}<button class="skip" data-action="pause-reason" data-id="${id}" data-v="">Skip</button></div>`;
    document.body.appendChild(el);
    clearTimeout(paskT); paskT = setTimeout(hidePask, 20000);
  }
  function stopTimer(save, opts) {
    const t = data.timer; if (!t) return;
    const quiet = !!(opts && opts.quiet), snap = JSON.parse(JSON.stringify(t));
    const prec = save ? endPause(t) : null;
    if (!save) t.pausedAt = null;
    const secs = Math.round(elapsedMs(t) / 1000);
    let ask = null;
    if (save && !quiet && t.blockId && secs >= 60) { // stopped early on a timetable block: was the topic finished?
      const pl = resolvePlan(t.planDate), bb = pl.blocks.find((x) => x.id === t.blockId);
      if (bb && kindOf(bb.type) === 'study' && !pl.skipped.includes(bb.id) && !(pl.completed || []).includes(bb.id)) {
        const prior = live(data.sessions).filter((x) => x.planDate === t.planDate && x.blockId === t.blockId).reduce((n, x) => n + x.seconds, 0);
        const total = prior + secs, dur = blockDur(bb) * 60, floor = ptv().earlyFloor / 100;
        if (total < dur * 0.9 && total >= dur * floor) ask = { date: t.planDate, b: bb, total, dur };
      }
    }
    data.timer = null; data.timerUpdatedAt = Date.now();
    const sid = t.id ? 'tm-' + t.id : uid(); // same id on every device, so stopping on two devices cannot double-count
    const restore = () => {
      closeModal();
      data.sessions = data.sessions.filter((x) => x.id !== sid);
      if (prec) data.pauses = data.pauses.filter((x) => x.id !== prec.id);
      data.timer = snap; data.timerUpdatedAt = Date.now(); persist(true); render();
    };
    if (save && secs >= 1) {
      const name = t.topic || defaultLabel(t.type);
      data.sessions = data.sessions.filter((x) => x.id !== sid);
      data.sessions.push(touch({
        id: sid, date: sessionDate(t.type, t.startWall, secs), start: t.startWall, seconds: secs,
        topic: name, type: t.type, priority: t.priority, comment: (t.comment || '').trim(),
        pausedSec: t.pauseSec || 0, pauses: t.pauseN || 0,
        ...(t.blockId ? { blockId: t.blockId, planDate: t.planDate } : {})
      }));
      ensureTopic(t.topic, t.type, t.priority);
      ui.date = sessionDate(t.type, t.startWall, secs);
      if (!quiet) toast(`Saved ${short(secs)} of ${name}`, restore);
      const after = () => {
        const stu = kindOf(t.type) === 'study';
        if (!quiet && secs >= 60 && stu && (data.settings.askFocus !== false || prec)) setTimeout(() => finishCard(sid, prec && prec.id, restore), 0);
        else if (!quiet && stu) setTimeout(() => { if (!data.timer && !$('#modal-root').innerHTML && roundNow().acc >= ROUND_SEC) roundDialog(null); }, 0);
      };
      if (ask) setTimeout(() => completePrompt(ask.date, ask.b, ask.total, ask.dur, after), 0); else after();
    } else if (save) {
      toast('Too short to save (under 1 second)');
    } else if (!quiet) {
      toast('Timer discarded', () => { data.timer = snap; data.timerUpdatedAt = Date.now(); persist(true); render(); });
    }
    persist(true); render();
  }
  function finishCard(sid, pauseId, restore) {
    const s = data.sessions.find((x) => x.id === sid);
    if (!s || s.deleted || $('#modal-root').innerHTML) return;
    const net = s.seconds, paused = s.pausedSec || 0, n = s.pauses || 0, score = Math.round(net / (net + paused) * 100), C = 2 * Math.PI * 34;
    const pr = pauseId ? data.pauses.find((x) => x.id === pauseId) : null;
    const rate = data.settings.askFocus !== false;
    choiceModal('Session complete', `
      <div class="fc">
        <div class="fc-ring"><svg viewBox="0 0 80 80"><circle class="bg" cx="40" cy="40" r="34"/><circle class="fg" id="fc-fg" cx="40" cy="40" r="34" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"/></svg>
          <div class="fc-score"><b>${score}%</b><span>focus</span></div></div>
        <div class="fc-stats">
          <div><b>${short(net)}</b><span>${esc(s.topic)}</span></div>
          <div><b>${paused ? short(paused) : 'none'}</b><span>paused${n ? ` · ${n} ${n === 1 ? 'time' : 'times'}` : ''}</span></div>
        </div>
      </div>
      ${pr ? `<div class="fc-why"><span class="note">Last pause (${short(pr.seconds)}): what pulled you away?</span><div class="pask-c">${PAUSE_REASONS.map(([k, e, l]) => `<button class="${pr.reason === k ? 'on' : ''}" data-action="pause-reason" data-id="${pr.id}" data-v="${k}"><i>${e}</i>${l}</button>`).join('')}</div></div>` : ''}
      ${rate ? `<p class="note" style="margin:14px 0 8px">How focused were you?</p><div class="rate big">${[1, 2, 3, 4, 5].map((k) => `<button data-action="set-focus" data-id="${sid}" data-v="${k}"><b>${k}</b><span>${FOCUS_WORDS[k - 1]}</span></button>`).join('')}</div>` : ''}`,
      [{ label: 'Stopped by mistake? Resume', fn: restore }, ...(!data.timer && roundNow().acc >= ROUND_SEC ? [{ label: 'Start 10 min break', cls: 'primary', fn: takeRoundBreak }] : []), { label: rate ? 'Skip' : 'Done', cls: rate ? '' : 'primary' }]);
    requestAnimationFrame(() => requestAnimationFrame(() => { const fg = $('#fc-fg'); if (fg) fg.style.strokeDashoffset = (C * (1 - score / 100)).toFixed(1); }));
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
    if (focusLocked() !== lockApplied) { render(); return; }
    if ((ui.page === 'timetable' || ui.page === 'today') && nowMs - lastLive > 30000) {
      lastLive = nowMs;
      const busy = drag || $('#modal-root').innerHTML || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
      if (!busy) { render(); return; }
    }
    if (!t) { mini.hidden = true; return; }
    const paused = !t.startedAt && !!t.pausedAt, ps = paused ? Math.max(0, (nowMs - t.pausedAt) / 1000) : 0;
    if (paused) {
      const allowed = pauseAllowance(t, ps), used = (t.pauseSec || 0) + ps, frac = allowed ? used / allowed : 0;
      const pc = $('#pclock'); if (pc) pc.textContent = pmm(ps);
      const fg = $('#pfg'); if (fg) fg.style.strokeDashoffset = (339.3 * (1 - Math.min(1, allowed ? frac : Math.min(1, ps / 900)))).toFixed(1);
      const panel = $('#ppanel'); if (panel) panel.className = 'pause-panel ' + (!allowed ? 'ok' : frac >= 1 ? 'over' : frac >= 0.75 ? 'warn' : 'ok');
      const pn = $('#pnote'); if (pn) pn.textContent = !allowed ? (ps < 60 ? 'under a minute is not logged' : 'being logged') : frac >= 1 ? 'over your pause budget' : `${short(Math.max(0, Math.round(used)))} of ${short(Math.round(allowed))} budget`;
      const lp = longPauseMin();
      if (lp && !t.pauseAlerted && ps >= lp * 60) {
        t.pauseAlerted = true; t.overAlerted = true; persist(true);
        if (data.settings.sound !== false) ting();
        toast(`Still on a break? You have been paused for ${short(Math.round(ps))}`);
        try { if ('Notification' in window) { Notification.requestPermission().then((p) => { if (p === 'granted') new Notification('Still paused', { body: `${t.topic || defaultLabel(t.type)} has been paused for ${short(Math.round(ps))}` }); }); } } catch { /* ignore */ }
      } else if (allowed && !t.overAlerted && used >= allowed) {
        t.overAlerted = true; persist(true); toast('Over your pause budget. Resume when you are ready');
      }
    }
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
    mini.innerHTML = `<div class="m-top"><span class="pulse ${t.startedAt ? '' : 'paused'}"></span>${t.startedAt ? 'Running' : 'Paused' + (paused ? ' · ' + pmm(ps) : '')}</div>
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
    { const rb = $('#rnd'); if (rb) rb.textContent = rndText(); }
    roundWatch(t, el);
    document.title = paused ? `⏸ ${pmm(ps)} paused · ${t.topic || defaultLabel(t.type)}` : `${hms(shown)} · ${t.topic || defaultLabel(t.type)}`;
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
      else if (!streakSafe(d)) break; // a rest day or a shielded day neither adds to nor breaks the streak
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
    const iv = list.map((s) => ({ s: s.start, e: s.start + (s.seconds + (s.pausedSec || 0)) * 1000, kind: kindOf(s.type) })); // paused time is not studying, but it is not a break either
    if (isToday && data.timer) { const tm = data.timer; iv.push({ s: tm.startWall, e: tm.startWall + elapsedMs(tm) + ((tm.pauseSec || 0) * 1000) + (!tm.startedAt && tm.pausedAt ? Date.now() - tm.pausedAt : 0), kind: kindOf(tm.type) }); }
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
      <p class="note">Study counts towards your daily goal and streak. Break is rest. Sleep is tracked separately. Neutral is everything else.</p>
      ${locked || x.kind === 'study' || x.kind === 'sleep' || x.kind === 'break' ? '' : `<div class="field" id="c-earnbox"><label class="chk"><input type="checkbox" id="c-earn" ${x.earn ? 'checked' : ''}> Small reward for logging this (routine)</label>
        <div class="row" style="margin-top:8px"><div class="field grow"><label>Points each</label><input type="number" id="c-epts" min="1" max="20" value="${x.earn ? x.earn.pts : 2}"></div>
        <div class="field grow"><label>Max per day</label><input type="number" id="c-emax" min="1" max="10" value="${x.earn ? x.earn.max : 1}"></div>
        <div class="field grow"><label>Min minutes</label><input type="number" id="c-emin" min="0" max="120" value="${x.earn ? x.earn.min : 5}"></div></div></div>`}`, () => {
      const name = $('#c-name').value.trim();
      if (!name) { toast('Give the category a name'); return false; }
      if (cats().some((y) => y.name.toLowerCase() === name.toLowerCase() && (!existing || y.id !== existing.id))) { toast('A category with that name already exists'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, { name, color: $('#c-color').value || x.color, kind: locked ? existing.kind : $('#c-kind').value });
      const eb = $('#c-earn');
      rec.earn = eb && eb.checked && rec.kind === 'neutral' ? { pts: Math.max(1, +$('#c-epts').value || 2), max: Math.max(1, +$('#c-emax').value || 1), min: Math.max(0, +$('#c-emin').value || 0) } : null;
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
  const redLive = () => ((data && data.redemptions) || []).filter((r) => !r.deleted);
  const shielded = (d) => redLive().some((r) => r.special === 'shield' && (r.for || r.date) === d);
  const streakSafe = (d) => isRest(d) || shielded(d);
  const discToken = (d) => redLive().find((r) => r.special === 'disc' && !r.used && r.date === d);
  const waiverToken = () => redLive().find((r) => r.special === 'waiver' && !r.used);
  const SPECIAL_NAMES = { rest: 'rest day', pass: 'goal pass', shield: 'streak shield', disc: 'goal discount', waiver: 'loan fee waiver' };
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
    { const ts = live(data.sessions).filter((s) => s.date >= from && s.date <= to && kindOf(s.type) === 'study' && s.pausedSec !== undefined), n = ts.reduce((x, s) => x + s.seconds, 0), pz = ts.reduce((x, s) => x + (s.pausedSec || 0), 0);
      if (n && (pz || ts.length)) parts.push(`Your focus score was <b>${Math.round(n / (n + pz) * 100)}%</b>${pz ? `, with <b>${short(pz)}</b> paused` : ' with no pauses'}.`); }
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
        .map(([id, v]) => ({ id, name: cat(id).name + (id === 'break' && ds.gapBreak ? ' (incl. gaps)' : ''), sec: v, color: cat(id).color }))
        .sort((x, y) => y.sec - x.sec);
    }
    const work = list.filter(isWork);
    if (mode === 'subject') return subjectGroups(list, false).map((g) => ({ id: g.id, name: g.name, sec: g.sec, color: g.color }));
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
        ${[['type', 'Type'], ...(live(data.subjects).length ? [['subject', 'Subject']] : []), ['topic', 'Topic']].map(([k, l]) => `<button class="${mode === k ? 'on' : ''}" data-action="donut-mode" data-v="${k}">${l}</button>`).join('')}
      </div>
      <div class="donut-wrap">
        <div class="donut"><svg viewBox="0 0 160 160" role="img" aria-label="Time split"><circle cx="80" cy="80" r="${R}" fill="none" stroke="#eef2f7" stroke-width="20"/>${arcs}</svg><div class="dc">${centre}</div></div>
        <div class="dl">${legend}</div>
      </div>`;
  }

  // =====================================================================
  //  SUMMARY CARD: period (day / week / month) x tab (activity, subject, topics, time of day, compare)
  // =====================================================================
  const SUM_TABS = [['type', 'Activity'], ['subject', 'Subject'], ['topic', 'Topics'], ['tod', 'Time of day'], ['cmp', 'Compare']];
  const datesIn = (a, b) => { const o = []; for (let x = a, g = 0; x <= b && g < 400; x = addDays(x, 1), g++) o.push(x); return o; };
  function sumRange(d, period) {
    if (period === 'week') { const a = weekStart(d); return [a, addDays(a, 6)]; }
    if (period === 'month') { const x = parseYmd(d); return [ymd(new Date(x.getFullYear(), x.getMonth(), 1)), ymd(new Date(x.getFullYear(), x.getMonth() + 1, 0))]; }
    return [d, d];
  }
  function sumPrev(d, period) {
    if (period === 'week') return sumRange(addDays(weekStart(d), -7), 'week');
    if (period === 'month') { const x = parseYmd(d); return sumRange(ymd(new Date(x.getFullYear(), x.getMonth() - 1, 1)), 'month'); }
    return [addDays(d, -1), addDays(d, -1)];
  }
  function sumData(a, b) {
    const days = datesIn(a, b), sess = live(data.sessions).filter((s) => s.date >= a && s.date <= b);
    let gapBreak = 0, untracked = 0, sleep = 0, sleepN = 0;
    days.forEach((x) => { const ds = dayStats(x); gapBreak += ds.gapBreak; untracked += ds.untracked; if (ds.tot.sleep) { sleep += ds.tot.sleep; sleepN++; } });
    const k = (kd) => sess.filter((s) => kindOf(s.type) === kd).reduce((n, s) => n + s.seconds, 0);
    const study = k('study'), brk = k('break') + gapBreak;
    return { days, sess, gapBreak, untracked, sleep, sleepN, study, brk, ratio: study + brk ? Math.round(study / (study + brk) * 100) : 0, entries: sess.length };
  }
  function todBuckets(sess) {
    const b = [0, 1, 2, 3].map(() => ({ study: 0, other: 0 }));
    sess.filter((s) => kindOf(s.type) !== 'sleep').forEach((s) => {
      const kd = kindOf(s.type) === 'study' ? 'study' : 'other';
      for (let t = 0; t < s.seconds; t += 60) { const h = new Date(s.start + t * 1000).getHours(); b[h >= 5 && h < 12 ? 0 : h >= 12 && h < 17 ? 1 : h >= 17 && h < 21 ? 2 : 3][kd] += Math.min(60, s.seconds - t); }
    });
    return b;
  }
  function longestStretch(sess) {
    const st = sess.filter((s) => kindOf(s.type) === 'study').sort((x, y) => x.start - y.start);
    let best = 0, cur = 0, end = null;
    st.forEach((s) => { if (end !== null && s.start - end >= ROUND_BRK * 1000) cur = 0; cur += s.seconds; end = s.start + (s.seconds + (s.pausedSec || 0)) * 1000; best = Math.max(best, cur); });
    return best;
  }
  const sgnT = (sec) => (sec > 0 ? '+' : sec < 0 ? '−' : '') + short(Math.abs(sec));
  function sumCards(slices, total, withIcon) {
    return slices.map((x, i) => `<div class="sm-c ${i === 0 && slices.length % 2 === 1 ? 'wide' : ''}" style="--c:${x.color}">
        <span class="sm-ic">${withIcon && x.id ? stIcon(catIconKey(cat(x.id)), 18) : '<i></i>'}</span>
        <div><b>${short(x.sec)}</b><span>${esc(x.name)} · ${total ? Math.round(x.sec / total * 100) : 0}%${x.n ? ` · ${x.n} ${x.n === 1 ? 'session' : 'sessions'}` : ''}</span></div></div>`).join('');
  }
  function summaryCard(d) {
    const sm = ui.sum = ui.sum || { tab: 'type', period: 'day' };
    if (!SUM_TABS.some(([k]) => k === sm.tab)) sm.tab = 'type';
    const [a, b] = sumRange(d, sm.period), sd = sumData(a, b), today = todayStr(), isToday = d === today;
    const tab = sm.tab, goal = data.settings.dailyGoalMin * 60;
    const when = sm.period === 'day' ? (isToday ? 'today' : fmtShort(d)) : sm.period === 'week' ? (weekStart(today) === a ? 'this week' : `week of ${fmtShort(a)}`) : (today.slice(0, 7) === a.slice(0, 7) ? 'this month' : parseYmd(a).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }));
    const slicesAll = donutSlices(sd.sess, { gapBreak: sd.gapBreak }, tab === 'subject' ? 'subject' : tab === 'topic' ? 'topic' : 'type');
    const nSess = (name) => sd.sess.filter((s) => s.topic.toLowerCase() === name.toLowerCase()).length;
    let hero = '', sub = '', badge = '', bar = '', body = '';
    const barHtml = (items, tot) => `<div class="sm-bar">${items.filter((x) => x.sec > 0).map((x) => `<i style="flex:${x.sec};background:${x.color}" title="${esc(x.name)}"></i>`).join('') || '<i class="empty" style="flex:1"></i>'}</div>`;
    const goalOk = goal && sd.study >= goal * Math.max(1, sd.days.filter((x) => x <= today).length);
    if (tab === 'type' || tab === 'subject' || tab === 'topic') {
      const total = slicesAll.reduce((n, x) => n + x.sec, 0);
      const sl = tab === 'topic' ? slicesAll.map((x) => ({ ...x, n: x.name === 'Others' ? 0 : nSess(x.name) })) : slicesAll;
      hero = total ? hms2(total) : '–';
      sub = tab === 'type' ? `tracked ${when}` : tab === 'subject' ? `of study ${when} across ${slicesAll.filter((x) => x.name !== 'No subject').length} ${slicesAll.filter((x) => x.name !== 'No subject').length === 1 ? 'subject' : 'subjects'}` : `${slicesAll.length} ${slicesAll.length === 1 ? 'topic' : 'topics'} ${when}`;
      badge = goal && sd.study ? `<span class="sm-badge ${goalOk ? 'ok' : ''}">${goalOk ? '✓ Study goal reached' : short(sd.study) + ' studied'}</span>` : '';
      bar = barHtml(sl);
      body = sl.length ? `<div class="sm-grid">${sumCards(sl, total, tab === 'type')}</div>` : '<div class="note" style="margin:14px 0">Log some time and your split shows up here.</div>';
      if (tab === 'subject') {
        const subs = live(data.subjects).filter((x) => !x.noWeekly && live(data.topics).some((t) => t.subjectId === x.id)), got = new Set(slicesAll.map((x) => x.id));
        const miss = subs.filter((x) => !got.has(x.id));
        if (miss.length) body += `<div class="sm-miss"><span>Not studied ${sm.period === 'day' ? 'yet' : 'in this period'}</span>${miss.map((x) => `<b>${esc(x.name)}</b>`).join('')}</div>`;
      }
    } else if (tab === 'tod') {
      const bk = todBuckets(sd.sess), mx = Math.max(1, ...bk.map((x) => x.study + x.other)), best = bk.reduce((bi, x, i) => (x.study > bk[bi].study ? i : bi), 0);
      const names = [['Morning', '5am–12pm'], ['Afternoon', '12–5pm'], ['Evening', '5–9pm'], ['Night', '9pm–5am']];
      hero = bk[best].study ? names[best][0] : '–'; sub = bk[best].study ? `is your best time ${when} · ${short(bk[best].study)} of study` : `no study ${when}`;
      bar = barHtml(names.map((n, i) => ({ name: n[0], sec: bk[i].study, color: ['#f59e0b', '#2563eb', '#8b5cf6', '#475569'][i] })));
      body = `<div class="sm-tod">${names.map((n, i) => `<div class="sm-t"><div class="sm-th"><b>${n[0]}</b><span>${n[1]}</span></div>
          <div class="sm-tb"><i class="st" style="width:${bk[i].study / mx * 100}%"></i><i class="ot" style="width:${bk[i].other / mx * 100}%"></i></div>
          <div class="sm-tv"><b>${short(bk[i].study)}</b> study · ${short(bk[i].other)} other</div></div>`).join('')}</div>`;
      const st = sd.sess.filter((s) => kindOf(s.type) === 'study').sort((x, y) => x.start - y.start);
      const longest = sm.period === 'day' ? longestStretch(sd.sess) : Math.max(0, ...sd.days.map((x) => longestStretch(sd.sess.filter((s) => s.date === x))));
      body += `<div class="sm-chips">${sm.period === 'day' && st.length ? `<span>▶ Started <b>${hmOf(st[0].start)}</b></span><span>■ Last study ended <b>${hmOf(st[st.length - 1].start + st[st.length - 1].seconds * 1000)}</b></span>` : ''}<span>⏱ Longest stretch <b>${short(longest)}</b></span></div>`;
    } else {
      let [pa, pb] = sumPrev(d, sm.period);
      const ndays = sd.days.filter((x) => x <= today).length, partial = sm.period !== 'day' && ndays < sd.days.length;
      if (partial) pb = addDays(pa, Math.max(0, ndays - 1)); // a week or month still in progress is compared with the same number of days before it
      const pv = sumData(pa, pb), vs = sm.period === 'day' ? 'yesterday' : sm.period === 'week' ? 'last week' : 'last month';
      const dS = sd.study - pv.study;
      hero = sgnT(dS) === '0m' ? '±0' : sgnT(dS); sub = `of study ${when} vs ${vs}${partial ? ` (first ${ndays} ${ndays === 1 ? 'day' : 'days'})` : ''}`;
      badge = sd.ratio || pv.ratio ? `<span class="sm-badge ${sd.ratio >= pv.ratio ? 'ok' : ''}">${sd.ratio}% study vs break</span>` : '';
      const mx = Math.max(1, sd.study + sd.brk, pv.study + pv.brk);
      const two = (label, x) => `<div class="sm-2"><span>${label}</span><div class="sm-bar"><i style="flex:${x.study};background:#2563eb"></i><i style="flex:${x.brk};background:#dc2626"></i></div></div>`;
      bar = `<div class="sm-cmpbars">${two('Now', sd)}${two(vs[0].toUpperCase() + vs.slice(1), pv)}</div>`;
      const row = (lab, now, prev, fmt, good) => { const df = now - prev, cls = df === 0 ? '' : (df > 0) === good ? 'up' : 'down'; return `<div class="sm-r"><span>${lab}</span><b>${fmt(now)}</b><i>${fmt(prev)}</i><em class="${cls}">${df === 0 ? '–' : (df > 0 ? '▲ ' : '▼ ') + (fmt === short ? short(Math.abs(df)) : Math.abs(df) + (fmt.pct ? '%' : ''))}</em></div>`; };
      const pct = (v) => v + '%'; pct.pct = true;
      const cnt = (v) => String(v);
      body = `<div class="sm-rows"><div class="sm-r head"><span></span><b>Now</b><i>${vs[0].toUpperCase() + vs.slice(1)}</i><em>Change</em></div>
        ${row('Study', sd.study, pv.study, short, true)}${row('Break incl. gaps', sd.brk, pv.brk, short, false)}${row('Study vs break', sd.ratio, pv.ratio, pct, true)}${row('Entries', sd.entries, pv.entries, cnt, true)}</div>`;
      if (sm.period === 'day') {
        const prev7 = sumData(addDays(d, -7), addDays(d, -1)), avg = Math.round(prev7.study / 7), dA = sd.study - avg;
        body += `<div class="sm-chips"><span>📈 7-day average <b>${short(avg)}</b></span><span class="${dA >= 0 ? 'good' : 'bad'}">${dA >= 0 ? '▲' : '▼'} <b>${short(Math.abs(dA))}</b> ${dA >= 0 ? 'above' : 'below'} your average</span></div>`;
      }
    }
    const nd = Math.max(1, sd.days.filter((x) => x <= today).length), gTot = goal * nd, gp = gTot ? Math.min(100, sd.study / gTot * 100) : 0;
    const goalStrip = tab !== 'cmp' && goal ? `<div class="sm-goal"><div><span>${sm.period === 'day' ? 'Daily study goal' : 'Study goal for ' + nd + (nd === 1 ? ' day' : ' days')}</span><b class="${gp >= 100 ? 'ok' : ''}">${Math.round(sd.study / gTot * 100)}% · ${short(sd.study)} of ${short(gTot)}</b></div><div class="sm-gb"><i style="width:${gp}%"></i></div></div>` : '';
    const sleepChip = sm.period === 'day' ? `🌙 ${sd.sleep ? `Slept <b>${short(sd.sleep)}</b> ${isToday ? 'last night' : 'that night'}` : 'No sleep logged'}` : `🌙 ${sd.sleepN ? `Slept <b>${short(Math.round(sd.sleep / sd.sleepN))}</b> avg per night` : 'No sleep logged'}`;
    return `<div class="card sum">
      <h2>Summary <small>${sd.entries} ${sd.entries === 1 ? 'entry' : 'entries'}</small></h2>
      <div class="sm-ctl"><div class="seg sm-per">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, l]) => `<button class="${sm.period === k ? 'on' : ''}" data-action="sum-period" data-v="${k}">${l}</button>`).join('')}</div></div>
      <div class="seg sm-tabs">${SUM_TABS.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-action="sum-tab" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="sm-hero"><div><div class="sm-big">${hero}</div><div class="sm-sub">${sub}</div></div>${badge}</div>
      ${bar}${body}${goalStrip}
      <div class="sm-foot"><span class="sm-chip lav">${sleepChip}</span>${sd.untracked ? `<span class="sm-chip">⏳ <b>${short(sd.untracked)}</b> untracked <small>gaps over ${fmtDur(gapCapMin())}</small></span>` : ''}${sm.period === 'day' ? '<button class="linkbtn" data-action="sleep-log">Log sleep</button>' : ''}</div>
      ${sm.period === 'day' ? restLine(d) : ''}
    </div>`;
  }
  const hms2 = (sec) => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? `${h}h ${pad(m)}m` : `${m}m`; };
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
    const W1 = W0 + 86400000, now = Date.now(), cap = gapCapMin() * 60000, MERGE = 5 * 60000;
    const clip = (o) => { const s = (Math.max(o.st, W0) - W0) / 60000, e = (Math.min(o.en, W1) - W0) / 60000; return { ...o, s, e }; };
    // gaps are worked out from the real entries (unchanged)
    const gaps = []; let cur = null;
    raw.forEach((o) => { if (cur !== null && o.st - cur >= 60000 && o.st - cur <= cap) gaps.push({ st: cur, en: o.st }); cur = cur === null ? o.en : Math.max(cur, o.en); });
    if (cur !== null && now > cur && now - cur <= cap && now > W0 && now < W1) gaps.push({ st: cur, en: now }); // time since the last entry counts as break too
    // for drawing only: stop-and-resume pieces of the same topic (a few minutes apart) are shown as one bar
    const disp = [];
    raw.forEach((o) => {
      const p = disp[disp.length - 1];
      if (p && !p.run && !o.run && p.type === o.type && (p.topic || '').toLowerCase() === (o.topic || '').toLowerCase() && o.st - p.en <= MERGE) {
        p.en = Math.max(p.en, o.en); p.full += o.full; p.count += 1; p.linked = p.linked || o.linked; if (o.focus) p.focus = o.focus;
      } else disp.push({ ...o, count: 1 });
    });
    const items = disp.map(clip);
    // side-by-side columns only for entries that genuinely overlap in time
    let cluster = [], cEnd = -1, laneEnds = [];
    const flush = () => { const n = Math.max(1, ...cluster.map((i) => i.lane + 1)); cluster.forEach((i) => { i.n = n; }); cluster = []; };
    items.forEach((it) => {
      if (it.s >= cEnd) { flush(); laneEnds = []; cEnd = it.e; } else cEnd = Math.max(cEnd, it.e);
      let l = laneEnds.findIndex((e) => e <= it.s);
      if (l < 0) { l = laneEnds.length; laneEnds.push(it.e); } else laneEnds[l] = it.e;
      it.lane = l; cluster.push(it);
    });
    flush();
    const gapHtml = gaps.map((g) => { const s = clip(g); return `<div class="ab gap" title="Gap, counted as break · ${hmOf(g.st)}–${hmOf(g.en)}" style="top:${(s.s - from) / 60 * tlh}px;height:${Math.max(2, (s.e - s.s) / 60 * tlh)}px"></div>`; }).join('');
    const blocks = items.map((o, idx) => {
      const label = esc(o.topic || defaultLabel(o.type)), c = cat(o.type);
      const dur = o.run ? 'running' : short(o.full);
      const action = o.run ? 'data-action="nav" data-page="today"' : `data-action="entry-edit" data-id="${o.id}"`;
      // short entries are drawn at their true length, only stretched a little for legibility while the next entry is further away
      const nat = (o.e - o.s) / 60 * tlh, next = items.slice(idx + 1).find((x) => x.s > o.s), room = next ? (next.s - o.s) / 60 * tlh - 1 : 20;
      const h = Math.max(nat, Math.min(20, room), 7);
      const size = h >= 34 ? '' : h >= 15 ? ' s' : ' xs';
      const rep = o.count > 1 ? ` ×${o.count}` : '';
      return `<div class="ab${size} ${o.run ? 'run' : ''}" ${action} title="${label}${rep} · ${hmOf(o.st)}–${hmOf(o.en)} · ${dur}"
        style="--c:${c.color};top:${(o.s - from) / 60 * tlh}px;height:${h}px;left:calc(${o.lane / o.n * 100}% + 2px);width:calc(${100 / o.n}% - 4px)">
        <b>${o.linked ? '⇄ ' : ''}${label}</b><span>${o.st < W0 ? '…' : ''}${hmOf(o.st)}–${hmOf(o.en)}${o.en > W1 ? '…' : ''} · ${dur}${rep}${o.focus ? ' · ★' + o.focus : ''}</span></div>`;
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
      <div class="field"><label>Colour</label><input type="color" id="sj-color" value="${esc(x.color)}"></div>
      <label class="chk"><input type="checkbox" id="sj-weekly" ${x.noWeekly ? '' : 'checked'}> Counts for the “every subject” goals, daily and weekly <span class="note">(untick for non-study subjects like Routine)</span></label>`, () => {
      const name = $('#sj-name').value.trim();
      if (!name) { toast('Give the subject a name'); return false; }
      if (live(data.subjects).some((s) => s.name.toLowerCase() === name.toLowerCase() && (!existing || s.id !== existing.id))) { toast('A subject with that name already exists'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, { name, color: $('#sj-color').value || x.color, noWeekly: !$('#sj-weekly').checked });
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
      ${bkBanner()}
      <div class="grid">
        <div class="stack">
          <div class="card ${focusLocked() ? 'timer-live' : ''}">${timerCard()}</div>
          ${upNextCard()}
          ${dayTimelineCard(d)}
        </div>
        <div class="stack">
          ${summaryCard(d)}
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
    const t = data.timer, anim = ui.tAnim; ui.tAnim = null;
    if (t) {
      const label = t.topic || defaultLabel(t.type);
      return `
        <div class="timer-run">
          <div class="what">${esc(label)}</div>
          <div class="badges">
            <span class="pill" style="background:#eff6ff;color:${cat(t.type).color}">${esc(cat(t.type).name)}</span>

            ${t.blockId ? '<span class="pill" style="background:#eff6ff;color:#1d4ed8">From timetable</span>' : ''}
            ${isStudyTimer(t) ? `<span class="pill rnd" id="rnd">${rndText()}</span>` : ''}
          </div>
          <div class="tstage ${t.startedAt || !isStudyTimer(t) ? 'run' : 'pz'} ${anim ? 'go-' + anim : ''}">
            <div class="face main-f">
              <div class="clock ${t.startedAt ? '' : 'paused'}" id="clock">00:00:00</div>
              <div class="remain" id="remain"></div>
              <div class="bar"><i id="tbar" style="width:0%"></i></div>
            </div>
            ${!isStudyTimer(t) ? '' : `<div class="face pause-f" ${t.startedAt ? 'aria-hidden="true"' : ''}>
              <div class="pause-panel ok" id="ppanel">
                <svg class="pp-ring" viewBox="0 0 120 120"><circle class="pp-bg" cx="60" cy="60" r="54"/><circle class="pp-fg" id="pfg" cx="60" cy="60" r="54" stroke-dasharray="339.3" stroke-dashoffset="339.3"/></svg>
                <div class="pp-in"><span class="pp-l">Paused for</span><b id="pclock">${pmm(t.startedAt ? (ui.lastPause || 0) : 0)}</b><span class="pp-s" id="pnote"></span></div>
              </div>
            </div>`}
          </div>
          <div class="timer-actions">
            ${t.startedAt
              ? '<button class="btn big" data-action="pause">Pause</button>'
              : '<button class="btn big primary" data-action="resume">Resume</button>'}
            ${t.mode === 'countdown' ? '<button class="btn big" data-action="extend">+10 min</button>' : ''}
            <button class="btn big primary" data-action="stop">${kindOf(t.type) === 'sleep' ? 'Woke up &amp; save' : 'Stop &amp; save'}</button>
            <button class="btn big danger" data-action="discard">Discard</button>
          </div>
          <input type="text" data-bind="run-comment" placeholder="Add a comment (optional)" value="${esc(t.comment)}">
          <div class="timer-extra">
            <button class="linkbtn" data-action="switch-topic">⇄ Switch topic</button>
            ${t.startedAt && !t.backed && elapsedMs(t) < 300000 ? '<span class="late"><span class="note">Started earlier?</span>' + [5, 10, 15].map((m) => `<button data-action="back-start" data-v="${m}">${m} min ago</button>`).join('') + '</span>' : ''}
          </div>
        </div>`;
    }

    return startCardHtml();
  }

  // ---------- the Start a timer card ----------
  const ST_ICONS = {
    study: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v14H5.5A1.5 1.5 0 0 0 4 19.5v-14zM4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3M8.5 8h6"/>',
    break: '<path d="M5 9h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9zM16 10h1.5a2 2 0 0 1 0 4H16M8 3v2M11 3v2"/>',
    sleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    meals: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-2.5 5-2.5 8h2.5v10"/>',
    plan: '<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/>',
    shower: '<path d="M12 3.5c3 3.6 5 6.1 5 8.5a5 5 0 0 1-10 0c0-2.4 2-4.9 5-8.5z"/>',
    workout: '<path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>',
    lotus: '<path d="M12 5c2 2.2 3 4.3 3 6.5S14 15 12 16c-2-1-3-2.3-3-4.5S10 7.2 12 5zM4 10c2.5 0 4.5 1 5.5 3M20 10c-2.5 0-4.5 1-5.5 3M6 17c2 1.5 4 2 6 2s4-.5 6-2"/>',
    other: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'
  };
  const stIcon = (k, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ST_ICONS[k] || ST_ICONS.other}</svg>`;
  function catIconKey(c) {
    if (c.kind === 'study') return 'study'; if (c.kind === 'break') return 'break'; if (c.kind === 'sleep') return 'sleep';
    const n = (c.name || '').toLowerCase();
    return /medit|mindful|breath/.test(n) ? 'lotus' : /meal|food|lunch|dinner|breakfast|eat/.test(n) ? 'meals' : /plan/.test(n) ? 'plan' : /shower|bath/.test(n) ? 'shower' : /workout|gym|exercise|fitness|yoga|run/.test(n) ? 'workout' : 'other';
  }
  const startLabel = () => {
    const f = ui.form, c = cat(f.type), k = c.kind;
    const verb = k === 'study' ? 'Start studying' : k === 'break' ? 'Start break' : k === 'sleep' ? 'Start sleep' : `Start ${(c.name || 'timer').toLowerCase()}`;
    return verb + (f.mode === 'countdown' && f.minutes > 0 ? ` · ${f.minutes} min` : '');
  };
  const stTitle = (k) => (k === 'break' ? ['Taking a break?', 'Add a label if you like, then start the clock'] : k === 'sleep' ? ['Time to rest?', 'Start the clock when you lie down, or log sleep you already had'] : ['What are you working on?', 'Type a topic, or tap a recent one']);
  const stPlaceholder = (k) => (k === 'break' ? 'e.g. Tea, walk, lunch' : k === 'sleep' ? 'e.g. Night sleep, nap' : 'Type a topic or pick a saved one');
  function recentTopics(type) {
    const seen = new Set(), out = [];
    live(data.sessions).filter((s) => s.type === type && (s.topic || '').trim()).sort((x, y) => y.start - x.start).forEach((s) => {
      const k = s.topic.toLowerCase(); if (!seen.has(k) && out.length < 5) { seen.add(k); out.push(s.topic); }
    });
    return out;
  }
  const stChips = (type) => recentTopics(type).map((t) => `<button class="st-chip" data-action="use-topic" data-v="${esc(t)}"><i style="background:${cat(type).color}"></i>${esc(t)}</button>`).join('');
  function startCardHtml() {
    const f = ui.form, fk = kindOf(f.type), topics = live(data.topics).filter((x) => x.type === f.type), presets = live(data.presets), [h, sub] = stTitle(fk);
    return `
      <div id="startcard" class="startcard ${f.mode === 'countdown' ? 'cd' : ''}">
        <div class="st-glow"></div>
        <h2 id="st-title">${h}</h2><div class="note" id="st-sub">${sub}</div>
        <div class="st-bar"><span class="st-s">${stIcon('search', 22)}</span>
          <input type="text" id="f-topic" list="topic-list" data-bind="f-topic" data-change="f-topic-change" autocomplete="off" placeholder="${stPlaceholder(fk)}" value="${esc(f.topic)}">
          <kbd>↵ Start</kbd></div>
        <datalist id="topic-list">${topics.map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist>
        <div class="st-chips" id="st-recent">${stChips(f.type)}</div>
        <div class="st-lbl">Activity</div>
        <div class="st-tiles">${cats().map((x) => `<button class="st-tile ${f.type === x.id ? 'on' : ''}" data-action="set-type" data-v="${esc(x.id)}" style="--c:${x.color}"><span class="ic">${stIcon(catIconKey(x))}</span><span class="nm">${esc(x.name)}</span></button>`).join('')}</div>
        <div class="st-row">
          <div><div class="st-lbl">Timer</div>
            <div class="st-modes"><div class="seg">
              <button class="${f.mode === 'stopwatch' ? 'on' : ''}" data-action="set-mode" data-v="stopwatch">Stopwatch</button>
              <button class="${f.mode === 'countdown' ? 'on' : ''}" data-action="set-mode" data-v="countdown">Countdown</button></div>
              <span class="st-step"><button data-action="f-min-step" data-v="-5" aria-label="5 minutes less">−</button><input type="number" min="1" max="600" data-bind="f-minutes" value="${f.minutes}" aria-label="Minutes"><span>min</span><button data-action="f-min-step" data-v="5" aria-label="5 minutes more">+</button></span></div></div>
        </div>
        ${presets.length ? `<div class="st-lbl">Presets</div><div class="st-pre">${presets.map((p) => `<button class="st-pr" data-action="use-preset" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>` : ''}
        <div class="st-go"><button class="st-start" data-action="start">${stIcon('play', 20)}<span id="st-start-t">${esc(startLabel())}</span></button>
          <button class="st-ghost" data-action="go-sleep">${stIcon('sleep', 18)}Going to sleep</button></div>
        <div class="st-foot"><button class="linkbtn" data-action="sleep-log">Log sleep</button></div>
      </div>`;
  }
  // update the start card in place so the changes animate instead of the card being redrawn
  function syncStartCard() {
    const root = $('#startcard'); if (!root) { render(); return; }
    const f = ui.form, fk = kindOf(f.type), [h, sub] = stTitle(fk);
    $$('.st-tile', root).forEach((b) => b.classList.toggle('on', b.dataset.v === f.type));
    $$('.st-modes .seg button', root).forEach((b) => b.classList.toggle('on', b.dataset.v === f.mode));
    root.classList.toggle('cd', f.mode === 'countdown');
    $('#st-title', root).textContent = h; $('#st-sub', root).textContent = sub;
    const inp = $('#f-topic', root); inp.placeholder = stPlaceholder(fk); if (inp.value !== f.topic) inp.value = f.topic;
    const mi = $('[data-bind=f-minutes]', root); if (mi && +mi.value !== f.minutes) mi.value = f.minutes;
    $('#st-start-t', root).textContent = startLabel();
    const rc = $('#st-recent', root); rc.classList.remove('swap'); void rc.offsetWidth; rc.innerHTML = stChips(f.type); rc.classList.add('swap');
    $('#topic-list', root).innerHTML = live(data.topics).filter((x) => x.type === f.type).map((x) => `<option value="${esc(x.name)}"></option>`).join('');
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
        <thead><tr><th>#</th><th>Topic</th><th>Time</th><th>Duration</th><th>Comment</th><th></th></tr></thead>
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
      const prio = (existing && existing.priority) || 'medium';
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
          <div class="card"><h2>Time split</h2>${splitBar(tot)}</div>
        </div>
        ${pauseCard(r)}
        ${wr ? wr.highlights + wr.days : ''}
      </div>`;
  }

  function pauseCard(r) {
    const ps = live(data.pauses).filter((p) => p.date >= r.from && p.date <= r.to);
    const ss = live(data.sessions).filter((s) => s.date >= r.from && s.date <= r.to && kindOf(s.type) === 'study' && s.pausedSec !== undefined);
    if (!ps.length && !ss.length) return '';
    const net = ss.reduce((n, s) => n + s.seconds, 0), pz = ss.reduce((n, s) => n + (s.pausedSec || 0), 0), score = net + pz ? Math.round(net / (net + pz) * 100) : null;
    const by = {}; ps.forEach((p) => { const k = p.reason || 'none'; (by[k] = by[k] || { sec: 0, n: 0 }); by[k].sec += p.seconds; by[k].n++; });
    const rows = Object.entries(by).sort((x, y) => y[1].sec - x[1].sec), top = rows.length ? rows[0][1].sec : 1;
    const label = (k) => { const f = PAUSE_REASONS.find((x) => x[0] === k); return f ? `${f[1]} ${f[2]}` : 'No reason given'; };
    return `<div class="card pz-card"><h2>Pauses & focus <small>session time spent studying</small></h2>
      <div class="pz-top"><div class="pz-score"><b>${score === null ? '–' : score + '%'}</b><span>focus score</span></div>
        <div class="pz-n"><b>${ps.length}</b><span>${ps.length === 1 ? 'pause' : 'pauses'}</span></div>
        <div class="pz-n"><b>${short(ps.reduce((n, p) => n + p.seconds, 0))}</b><span>paused in total</span></div>
        <div class="pz-n"><b>${ps.length ? short(Math.round(ps.reduce((n, p) => n + p.seconds, 0) / ps.length)) : '–'}</b><span>average pause</span></div></div>
      ${rows.length ? `<div class="pz-rows">${rows.map(([k, v], i) => `<div class="pz-row"><span class="pz-l">${label(k)}</span><div class="pz-bar"><i style="width:${Math.max(4, v.sec / top * 100)}%;animation-delay:${i * 70}ms"></i></div><span class="pz-v">${short(v.sec)} · ${v.n}×</span></div>`).join('')}</div>` : '<p class="note">No pauses of a minute or more in this period.</p>'}
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
          ${undoCard()}
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
                  <div class="meta">${p.minutes ? p.minutes + ' min' : 'Stopwatch'}${p.topic ? ' · ' + esc(p.topic) : ''}</div></div>
                <button class="btn sm primary" data-action="preset-start" data-id="${p.id}">Start</button>
                <button class="btn sm" data-action="preset-edit" data-id="${p.id}">Edit</button>
                <button class="btn sm danger" data-action="preset-del" data-id="${p.id}">Delete</button>
              </div>`).join('') : '<div class="empty"><b>No presets</b>A preset remembers a topic and a duration.</div>'}
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
            <div class="field"><label>Default length of a block added from your topics (minutes)</label><input type="number" min="5" max="480" step="5" data-change="block-min" value="${data.settings.blockMin || 60}"></div>
            <div class="field"><label>Pause budget (minutes of pause per hour of session, 0 = off)</label><input type="number" min="0" max="60" step="1" data-change="pause-budget" value="${data.settings.pauseBudget === undefined ? 10 : data.settings.pauseBudget}"></div>
            <div class="field"><label>Remind me when a pause lasts this long (minutes, 0 = off)</label><input type="number" min="0" max="240" step="5" data-change="long-pause" value="${data.settings.longPause === undefined ? 15 : data.settings.longPause}"></div>
            <div class="field"><label class="chk"><input type="checkbox" data-change="lock-other" ${data.settings.lockOther ? 'checked' : ''}> Also lock the app while a workout or other non-study timer runs (study always locks; breaks and sleep never do)</label></div>
            <div class="field"><label class="chk"><input type="checkbox" data-change="block-ting" ${data.settings.blockTing !== false ? 'checked' : ''}> Soft bell when a stopwatch block reaches its planned time</label></div>
            <div class="row">
              <button class="btn" data-action="export">Export backup</button>
              <button class="btn" data-action="import">Import &amp; merge</button>
            </div>
            <p class="note" style="margin-top:12px">Backups are plain JSON. Importing <b>merges</b> by record, so nothing is overwritten blindly – the same file format is used for syncing between devices.</p>
            ${backupCard()}
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
`,
    () => {
      const name = $('#t-name').value.trim();
      if (!name) { toast('Give the topic a name'); return false; }
      const dup = live(data.topics).find((x) => x.name.toLowerCase() === name.toLowerCase() && (!existing || x.id !== existing.id));
      if (dup) { toast('A topic with that name already exists'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, { name, type: $('#t-type').value, priority: (existing && existing.priority) || 'medium' });
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
        <div class="field grow"><label>Minutes (0 = stopwatch)</label><input type="number" id="p-min" min="0" max="600" value="${p.minutes}"></div>
      </div>`,
    () => {
      const name = $('#p-name').value.trim();
      if (!name) { toast('Give the preset a name'); return false; }
      const rec = existing || { id: uid() };
      Object.assign(rec, {
        name, type: $('#p-type').value, topic: $('#p-topic').value.trim(), priority: (existing && existing.priority) || 'medium',
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
            <div class="bmeta">${spill(st)} <span>Planned ${fmtDur(dur)}${st.act ? ' · Did ' + short(st.act) : ''}</span></div>
            ${b.note ? `<div class="note" style="margin-top:4px">${linkify(b.note)}</div>` : ''}
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
              <span class="note">Start a line with a category name, like <b>break:</b> or <b>sleep:</b>.</span>
            </div>
          </div>
          <div class="card">
            <h2>${v === 'list' ? 'Plan' : 'Day timeline'} <small>${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}</small></h2>
            ${!blocks.length ? '<div class="empty"><b>No blocks yet</b>Type lines like <i>14:00 to 15:00 Ratio v5</i> above.</div>' : v === 'list' ? rows : timelineHtml(date, blocks, plan)}
          </div>
        </div>
        <div class="stack">
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
          ${importantCard()}
          ${missedCard()}
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
  const defaultBlockMin = () => Math.max(5, +(data.settings && data.settings.blockMin) || 60);
  // first free slot of `dur` minutes on the day (minutes after the day start); prefers `pref` when that is free and not in the past
  function freeSlot(date, dur, pref) {
    const plan = resolvePlan(date), iv = plan.blocks.map((b) => [offMin(b.start), offMin(b.start) + blockDur(b)]).sort((x, y) => x[0] - y[0]);
    const nowOff = date === activePlanDate() ? Math.max(0, Math.ceil((Date.now() - anchorMs(date)) / 60000 / 5) * 5) : 0;
    const free = (s) => s >= nowOff && s + dur <= 1440 && iv.every(([x, y]) => s + dur <= x || s >= y);
    if (pref !== undefined && free(pref)) return pref;
    let s = nowOff;
    for (const [x, y] of iv) { if (s + dur <= x) break; if (y > s) s = y; }
    return s + dur <= 1440 ? s : null;
  }
  function addBlock(date, spec, quiet) {
    const dur = Math.max(5, Math.round(spec.minutes || defaultBlockMin()));
    const s = freeSlot(date, dur, spec.pref);
    if (s === null) { if (!quiet) toast('No room left on this day'); return null; }
    const blk = { id: uid(), start: fromMin(anchorMin() + s), end: fromMin(anchorMin() + s + dur), topic: spec.topic, type: spec.type || 'study', priority: spec.priority || 'medium', note: '' };
    savePlan(date, (next) => { next.blocks.push(blk); });
    if (!quiet) toast(`Added ${spec.topic}, ${blk.start}–${blk.end}`, () => savePlan(date, (next) => { next.blocks = next.blocks.filter((x) => x.id !== blk.id); }));
    return blk;
  }
  function recentBlocks(date) {
    const map = new Map(), onDay = resolvePlan(date).blocks;
    Object.keys(data.plans).filter((k) => !data.plans[k].deleted).sort().forEach((k) => (data.plans[k].blocks || []).forEach((b) => {
      if (!b.topic) return;
      const key = `${b.type}|${b.topic.toLowerCase()}|${blockDur(b)}`, e = map.get(key) || { topic: b.topic, type: b.type, minutes: blockDur(b), count: 0 };
      Object.assign(e, { priority: b.priority, start: b.start, last: k }); e.count++; map.set(key, e);
    }));
    return [...map.values()].filter((e) => !onDay.some((b) => (b.topic || '').toLowerCase() === e.topic.toLowerCase() && blockDur(b) === e.minutes))
      .sort((x, y) => (y.last > x.last ? 1 : y.last < x.last ? -1 : y.count - x.count)).slice(0, 10);
  }
  function importantCard() {
    const items = impItems(), date = ttDate(), plan = resolvePlan(date), open = ui.ib.open;
    const plannedOf = (t) => plan.blocks.find((b) => (b.topic || '').toLowerCase() === t.toLowerCase());
    const studied = (t) => live(data.sessions).some((s) => s.date === date && kindOf(s.type) === 'study' && s.topic.toLowerCase() === t.toLowerCase());
    const todo = items.filter((i) => !i.done && !plannedOf(i.text) && !studied(i.text));
    const recent = recentBlocks(date);
    const row = (i) => {
      const pb = plannedOf(i.text), sd = studied(i.text);
      return `<li class="${i.done || sd ? 'done' : ''}">
        <input type="checkbox" data-change="imp-done" data-id="${i.id}" ${i.done ? 'checked' : ''} aria-label="Covered">
        <input class="imp-item" data-bind="imp-item" data-id="${i.id}" value="${esc(i.text)}" aria-label="Topic">
        ${sd ? '<span class="ib-state ok">Studied</span>' : ''}
        ${pb ? `<span class="ib-state">${pb.start}–${pb.end}</span>`
          : `<span class="ib-add"><button class="btn sm primary" data-action="ib-add" data-id="${i.id}" title="Add to the timeline">+ Timeline</button><button class="btn sm" data-action="ib-more" data-id="${i.id}" aria-label="Choose length and time">▾</button></span>`}
        <button class="imp-x" data-action="imp-del" data-id="${i.id}" aria-label="Remove topic">×</button>
      </li>`;
    };
    const body = ui.imp.text
      ? `<textarea id="imp-text" rows="10" placeholder="One topic per line">${esc(items.map((i) => i.text).join('\n'))}</textarea>
         <div class="imp-add"><button class="btn sm primary" data-action="imp-text-done">Save list</button><button class="btn sm" data-action="imp-text-cancel">Cancel</button></div>`
      : `${items.length ? `<div class="ib-bar"><button class="btn sm primary" data-action="ib-add-all" ${todo.length ? '' : 'disabled'}>Add ${todo.length || 'all'} to ${fmtShort(date)}</button><span class="note">one after another, in free slots</span></div>` : ''}
         <ul class="imp-list">${items.map(row).join('')}</ul>
         ${items.length ? '' : '<p class="note imp-empty">Keep the topics you must not forget here, then add each to the timeline with one tap.</p>'}
         <div class="imp-add"><input id="imp-new" type="text" placeholder="Add a topic…" autocomplete="off"><button class="btn sm primary" data-action="imp-add">Add</button></div>
         ${recent.length ? `<div class="ib-recent"><div class="lbl">Recent blocks <span class="note">tap to add to this day</span></div><div class="ib-chips">${recent.map((e, k) => `<button class="ib-chip" data-action="ib-recent" data-i="${k}" title="${e.start}"><span class="dot" style="background:${cat(e.type).color}"></span>${esc(e.topic)} <small>${fmtDur(e.minutes)}</small></button>`).join('')}</div></div>` : ''}
         <div class="imp-foot"><button class="linkbtn" data-action="imp-text">Edit as text / paste a list</button>${items.some((i) => i.done) ? '<button class="linkbtn" data-action="imp-clear">Remove ticked</button>' : ''}</div>`;
    return `<div class="card imp">
      <div class="imp-bar"><span></span></div>
      <div class="ib-head"><input class="imp-title" data-bind="imp-title" value="${esc(data.important.title)}" aria-label="Note title"><button class="btn sm" data-action="ib-toggle">${open ? 'Hide' : 'Show'}</button></div>
      ${open ? body : `<p class="note ib-sum">${items.length} ${items.length === 1 ? 'topic' : 'topics'} · ${todo.length} to plan${recent.length ? ` · ${recent.length} recent blocks` : ''}</p>`}
    </div>`;
  }

  // every planned block (not break/sleep) on a finished day that got no time and wasn't skipped; days with no plan of their own repeat the last plan
  function missedBlocks() {
    const keys = Object.keys(data.plans).filter((k) => data.plans[k] && !data.plans[k].deleted).sort();
    if (!keys.length) return [];
    const hidden = data.settings.missedHidden || {}, last = addDays(activePlanDate(), -1), out = [];
    for (let d = keys[0]; d <= last; d = addDays(d, 1)) {
      if (isRest(d)) continue;
      const plan = resolvePlan(d);
      plan.blocks.forEach((b) => {
        if (['break', 'sleep'].includes(kindOf(b.type)) || !b.topic || plan.skipped.includes(b.id) || hidden[d + '|' + b.id]) return;
        if (blockActual(d, b.id) > 0) return;
        out.push({ date: d, b, key: d + '|' + b.id });
      });
    }
    return out.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : offMin(x.b.start) - offMin(y.b.start)));
  }
  function setMissedHidden(keys, on) {
    const h = Object.assign({}, data.settings.missedHidden || {});
    keys.forEach((k) => { if (on) h[k] = Date.now(); else delete h[k]; });
    data.settings.missedHidden = h; touch(data.settings); persist(true); render();
  }
  function missedCard() {
    const list = missedBlocks(), open = ui.ms.open, shown = ui.ms.all ? list : list.slice(0, 15);
    const row = (m, i) => `<li>
      <div class="ms-when"><b>${fmtShort(m.date)}</b><span>${parseYmd(m.date).toLocaleDateString('en-IN', { weekday: 'short' })}</span></div>
      <div class="ms-main"><span class="dot" style="background:${cat(m.b.type).color}"></span><span class="ms-nm">${esc(m.b.topic)}</span> <small>${m.b.start}–${m.b.end} · ${fmtDur(blockDur(m.b))}</small></div>
      <span class="ib-add"><button class="btn sm primary" data-action="ms-add" data-k="${esc(m.key)}">+ Timeline</button><button class="imp-x" data-action="ms-hide" data-k="${esc(m.key)}" aria-label="Remove from list" title="Remove from list">×</button></span>
    </li>`;
    return `<div class="card ms">
      <div class="imp-bar"><span></span></div>
      <div class="ib-head"><h2 class="ms-title">Missed topics${list.length ? ` <span class="ms-n">${list.length}</span>` : ''}</h2><button class="btn sm" data-action="ms-toggle">${open ? 'Hide' : 'Show'}</button></div>
      ${!open ? `<p class="note ib-sum">${list.length ? `${list.length} missed ${list.length === 1 ? 'block' : 'blocks'}` : 'Nothing missed'}</p>`
        : list.length ? `<ul class="ms-list">${shown.map(row).join('')}</ul>
          <div class="imp-foot">${list.length > 15 ? `<button class="linkbtn" data-action="ms-more">${ui.ms.all ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}<button class="linkbtn" data-action="ms-clear">Remove all from list</button></div>`
        : '<p class="note imp-empty">Blocks you plan but never start will show up here, so nothing slips away.</p>'}
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
      const rec = { id: existing ? existing.id : uid(), start, end, topic: $('#b-topic').value.trim(), type: $('#b-type').value, priority: (existing && existing.priority) || 'medium', note: $('#b-note').value.trim() };
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
    // up to 3 blocks that are on now or still to come (finished, skipped and missed ones are left out)
    const items = list.filter((x) => !['done', 'skipped'].includes(x.st.key) && x.endMs > now).slice(0, 3);
    const cur = items.length && items[0].startMs <= now;
    const head = `<h2>${items.length ? (cur ? 'Now in your timetable' : 'Up next') : 'Timetable'} <button class="linkbtn" data-action="nav" data-page="timetable">Open timetable →</button></h2>`;
    if (!items.length) return `<div class="card">${head}<p class="note">Every planned block for today is finished or skipped.</p></div>`;
    return `<div class="card">${head}
      ${items.map((it, k) => { const b = it.b, dur = blockDur(b), now1 = it.startMs <= now;
        return `<div class="blk" style="padding:${k ? '10px' : '0'} 0 0">
        <div class="btime">${b.start} – ${b.end}<small>${fmtDur(dur)}</small></div>
        <div class="bmain"><div class="btopic">${typeDot(b.type)}${esc(b.topic || defaultLabel(b.type))}</div>
          <div class="bmeta">${spill(it.st)}</div>
          ${b.note ? `<div class="note" style="margin-top:4px">${linkify(b.note)}</div>` : ''}</div>
        <div class="bact"><button class="btn sm ${k === 0 || now1 ? 'primary' : ''}" data-action="tt-start" data-date="${pd}" data-id="${b.id}">${it.st.act ? 'Resume' : 'Start'}</button></div>
      </div>`; }).join('')}</div>`;
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
  const PT_DEFAULTS = { study30: 10, workout30: 10, workoutMax: 3, goal: 50, stretchMin: 540, stretch: 100, plan: 15, loanFee: 25, loanMax: 1500, loanShare: 50, planWindow: 60, earlyFloor: 50, blockH: 30, blockM: 20, blockL: 10, roundBase: 10, roundStep: 5, roundCap: 40, routineCap: 10, subjDay: 30, subjMin: 20, missSubject: 5, focus: 5, checkin: 5, journal: 5, sleep: 5, streak3: 20, streak7: 50, streak30: 150, allSubjects: 50, missGoal: 20, missBlock: 10, cap: 30, meditate30: 10, meditateMax: 2, earlyStart: 15, earlyWin: 60, wakeSteady: 10, wakeWin: 30, revise: 10, deep: 20, deepMin: 90, weak: 15, weakMin: 30, noMiss: 25, weekGoal: 80, weekGoalH: 20, perfectWeek: 100, improve: 30, comeback: 20, comebackMin: 60, streak14: 30, mile50: 50, mile100: 100, mile250: 250, weekReview: 15, mock: 30, mockBeat: 15, discPct: 30 };
  const PT_LABELS = [
    ['study30', 'Study, per 30 minutes (paid per minute)'], ['workout30', 'Workout, per 30 minutes (paid per minute)'], ['workoutMax', 'Workout: most 30-minute blocks counted per day'], ['meditate30', 'Meditation, per 30 minutes (paid per minute)'], ['meditateMax', 'Meditation: most 30-minute blocks counted per day'], ['goal', 'Daily goal reached'], ['stretchMin', 'Stretch goal (minutes of study)'], ['stretch', 'Stretch goal reached (bonus on top)'], ['plan', 'Planned the day early'], ['planWindow', 'Plan within this many minutes of waking'], ['earlyFloor', 'Finish a block early: minimum % of the planned time'], ['loanFee', 'Loan fee (%, charged up front)'], ['loanMax', 'Loan: maximum amount'], ['loanShare', 'Loan auto-repay share of daily earnings (%)'],
    ['blockM', 'Study block done'], ['routineCap', 'Routine logging (meals, shower…): maximum points per day'], ['roundBase', 'Focus round 2 reward (1h of study, then a break and back in 15 min)'], ['roundStep', 'Focus rounds: extra for each round after'], ['roundCap', 'Focus rounds: maximum reward'], ['subjDay', 'Every subject studied today: reward'], ['subjMin', 'Minutes of study per subject to count today'], ['missSubject', 'Subject skipped today: penalty each'],
    ['focus', 'Focused session (rated 4–5, 30+ min)'], ['checkin', 'Evening check-in'], ['journal', 'Journal entry'], ['sleep', 'Sleep logged'],
    ['streak3', '3-day streak'], ['streak7', '7-day streak'], ['streak30', '30-day streak'], ['allSubjects', 'Every subject studied in a week'],
    ['missGoal', 'Missed goal: maximum penalty'], ['missBlock', 'Missed study block'], ['cap', 'Daily penalty cap'],
    ['earlyStart', 'Early start: first study within the window after waking'], ['earlyWin', 'Early start window (minutes after waking)'],
    ['wakeSteady', 'Steady wake time (within the window of your usual week)'], ['wakeWin', 'Steady wake window (minutes)'],
    ['revise', 'Revision: study a topic last covered 3+ days ago (10+ min)'], ['deep', 'Deep work: one session at least this long, rated 4–5'], ['deepMin', 'Deep work session length (minutes)'],
    ['weak', 'Weak subject: time on your least-studied subject this week'], ['weakMin', 'Weak subject minutes needed'],
    ['noMiss', 'No-miss day: every planned study block done (2+ blocks)'], ['weekGoal', 'Weekly study target reached'], ['weekGoalH', 'Weekly study target (hours)'],
    ['perfectWeek', 'Perfect week: daily goal met on every non-rest day'], ['improve', 'Improvement: week beats last week by 10%+'],
    ['comeback', 'Comeback: study after a day with none'], ['comebackMin', 'Comeback minutes needed'],
    ['streak14', '14-day streak'], ['mile50', 'Milestone: 50 hours of study in total'], ['mile100', 'Milestone: 100 hours of study in total'], ['mile250', 'Milestone: 250 hours of study in total'],
    ['weekReview', 'Weekly review: a 100+ character journal entry on Sunday'],
    ['mock', 'Mock test taken (topic has "mock" or "test", 30+ min)'], ['mockBeat', 'Mock score beats your last one (write it in the topic, e.g. "Mock 3 - 72%")'],
    ['discPct', 'Goal discount reward: percent off']
  ];
  const LEVELS = [['Beginner', 0], ['Learner', 200], ['Focused', 600], ['Scholar', 1500], ['Master', 3500], ['Legend', 8000]];
  const ptv = () => Object.assign({}, PT_DEFAULTS, data.pointsCfg.v);
  const LOCK_DAYS = 7;
  const ptLocked = () => (data.pointsCfg.lockUntil || 0) > Date.now();
  const lockWhen = () => { const d = new Date(data.pointsCfg.lockUntil); return `${fmtLong(ymd(d))}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };
  const lockMsg = () => `Locked until ${lockWhen()}. Points and prices cannot be changed yet`;
  function ptLog(text) { const at = Date.now(); data.pointsLog.push({ id: uid(), at, text, updatedAt: at }); }
  const sgn = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');

  const isMeditation = (s) => /medit|mindful|breathwork|breathing|pranayam|dhyan/i.test(cat(s.type).name + ' ' + s.topic);
  // a study session counts toward the weekly "every subject" goal through its topic's subject (study only)
  function weeklySubjectIds(s, tmap) {
    if (kindOf(s.type) !== 'study') return [];
    const t = tmap.get((s.topic || '').toLowerCase());
    return t && t.subjectId ? [t.subjectId] : [];
  }
  const isWorkout = (s) => !isMeditation(s) && /workout|exercise|gym|yoga|fitness/i.test(cat(s.type).name + ' ' + s.topic);
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
    const subs = live(data.subjects).filter((s) => !s.noWeekly && live(data.topics).some((t) => t.subjectId === s.id));
    const reds = live(data.redemptions);
    const loanBy = {}; live(data.loans).forEach((l) => { (loanBy[l.date] = loanBy[l.date] || []).push(l); });
    const repBy = {}; live(data.repayments).forEach((r) => { (repBy[r.date] = repBy[r.date] || []).push(r); });
    const autoLog = [...(cfg.autoLog || [])].sort((x, y) => (x.d < y.d ? -1 : 1));
    const autoOn = (d) => { let on = true; autoLog.forEach((e) => { if (e.d <= d) on = e.on; }); return on; };
    const share = Math.min(100, Math.max(0, v.loanShare)) / 100;
    const redBy = {}; reds.forEach((r) => { (redBy[r.date] = redBy[r.date] || []).push(r); });
    let first = start;
    studyDays.forEach((d) => { if (d < first) first = d; });
    const studyBy = {}, wakeBy = {}, topicDates = new Map(), mocks = [];
    const mockScore = (t) => { const m = /(\d+(?:\.\d+)?)\s*(?:%|\/\s*(\d+(?:\.\d+)?))/.exec(t || ''); if (!m) return null; const x = parseFloat(m[1]); return m[2] ? x / parseFloat(m[2]) * 100 : x; };
    const isMock = (s) => kindOf(s.type) === 'study' && /\b(mock|test)\b/i.test(s.topic || '');
    live(data.sessions).forEach((s) => {
      if (kindOf(s.type) === 'study') {
        studyBy[s.date] = (studyBy[s.date] || 0) + s.seconds;
        if (s.seconds >= 600) { const k = (s.topic || '').toLowerCase(); if (!topicDates.has(k)) topicDates.set(k, new Set()); topicDates.get(k).add(s.date); }
        if (isMock(s)) { const sc = mockScore(s.topic); if (sc !== null) mocks.push({ date: s.date, start: s.start, sc }); }
      } else if (kindOf(s.type) === 'sleep') { const w = s.start + s.seconds * 1000; if (!wakeBy[s.date] || s.seconds > wakeBy[s.date].sec) wakeBy[s.date] = { ms: w, sec: s.seconds }; }
    });
    mocks.sort((x, y) => x.start - y.start);
    const todMin = (ms) => { const t = new Date(ms); return t.getHours() * 60 + t.getMinutes(); };
    const circ = (x, y) => { const d = Math.abs(x - y) % 1440; return Math.min(d, 1440 - d); };
    let cumStudy = 0;
    const days = {};
    let L = 0, A = 0, streakLen = 0, spent = 0, pending = 0, debt = 0, borrowed = 0, repaidAll = 0;
    for (let d = first, guard = 0; d <= today && guard < 4000; d = addDays(d, 1), guard++) {
      const isToday = d === today, finished = !isToday;
      const list = by[d] || [];
      let study = list.filter((s) => kindOf(s.type) === 'study').reduce((n, s) => n + s.seconds, 0);
      if (isToday && tm && kindOf(tm.type) === 'study') study += tmElapsed;
      const studied = study > 0;
      const prevCum = cumStudy; cumStudy += study;
      streakLen = studied ? streakLen + 1 : (streakSafe(d) || isToday) ? streakLen : 0;
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
      { let msec = list.filter((s) => kindOf(s.type) !== 'study' && kindOf(s.type) !== 'sleep' && isMeditation(s)).reduce((n, s) => n + s.seconds, 0);
        if (isToday && tm && kindOf(tm.type) !== 'study' && kindOf(tm.type) !== 'sleep' && isMeditation(tm)) msec += tmElapsed;
        const mpts = Math.round(Math.min(msec / 60, v.meditateMax * 30) * v.meditate30 / 30);
        if (mpts) add(`Meditation ${short(msec)}`, mpts, 'earn'); }
      // timetable blocks
      const plan = resolvePlan(d);
      let doneH = 0, doneM = 0, doneL = 0, missed = 0, nb = 0;
      plan.blocks.forEach((b) => {
        if (kindOf(b.type) !== 'study' || plan.skipped.includes(b.id)) return;
        nb++;
        const dur = blockDur(b) * 60;
        let act = actual[d + '|' + b.id] || 0;
        if (isToday && tm && tm.blockId === b.id && tm.planDate === d) act += tmElapsed;
        if (dur > 0 && (act >= dur * 0.9 || (act > 0 && (plan.completed || []).includes(b.id)))) { doneM++; }
        else if (act === 0 && blockTimes(d, b).endMs < now) missed++;
      });
      const nd = doneH + doneM + doneL;
      if (nd) add(`${nd} study ${nd === 1 ? 'block' : 'blocks'} done`, nd * v.blockM, 'earn');
      if (nb >= 2 && nd === nb && v.noMiss > 0) add('No-miss day', v.noMiss, 'earn');
      const nf = list.filter((s) => kindOf(s.type) === 'study' && s.focus >= 4 && s.seconds >= 1800).length;
      if (nf) add(`${nf} focused ${nf === 1 ? 'session' : 'sessions'}`, nf * v.focus, 'earn');
      const ci = data.checkins[d];
      if (ci && (ci.mood || ci.focus)) add('Evening check-in', v.checkin, 'earn');
      if (((data.journal[d] && data.journal[d].text) || '').trim()) add('Journal entry', v.journal, 'earn');
      if (list.some((s) => kindOf(s.type) === 'sleep')) add('Sleep logged', v.sleep, 'earn');
      if (studied && (streakLen === 3 || streakLen === 7 || streakLen === 14 || streakLen === 30)) add(`${streakLen}-day streak`, v['streak' + streakLen], 'earn');
      { // ---- extra earners
        const sOf = (x) => (x === d ? study : (studyBy[x] || 0));
        const wake = wakeBy[d] ? wakeBy[d].ms : null, studySess = list.filter((s) => kindOf(s.type) === 'study');
        if (wake && v.earlyStart > 0) {
          const starts = studySess.map((s) => s.start); if (isToday && tm && kindOf(tm.type) === 'study') starts.push(tm.startWall);
          if (starts.length && Math.min(...starts) <= wake + v.earlyWin * 60000) add('Early start', v.earlyStart, 'earn');
        }
        if (wake && v.wakeSteady > 0) {
          const prior = []; for (let i = 1; i <= 7; i++) if (wakeBy[addDays(d, -i)]) prior.push(todMin(wakeBy[addDays(d, -i)].ms));
          if (prior.length >= 3) { prior.sort((x, y) => x - y); const med = prior[Math.floor(prior.length / 2)]; if (circ(todMin(wake), med) <= v.wakeWin) add('Steady wake time', v.wakeSteady, 'earn'); }
        }
        if (v.revise > 0 && studied) {
          const hit = studySess.filter((s) => s.seconds >= 600).map((s) => (s.topic || '').toLowerCase()).find((tp) => { const ds = topicDates.get(tp); if (!ds) return false; let prev = ''; ds.forEach((x) => { if (x < d && x > prev) prev = x; }); return prev && prev <= addDays(d, -3); });
          if (hit) add('Revision', v.revise, 'earn');
        }
        if (v.deep > 0 && studySess.some((s) => s.seconds >= v.deepMin * 60 && s.focus >= 4)) add('Deep work', v.deep, 'earn');
        if (v.weak > 0 && studied && subs.length >= 2) {
          const tot = new Map(subs.map((s) => [s.id, 0])), today2 = new Map(subs.map((s) => [s.id, 0]));
          for (let i = 1; i <= 7; i++) (by[addDays(d, -i)] || []).forEach((s) => { if (kindOf(s.type) !== 'study') return; const t = tmap.get((s.topic || '').toLowerCase()); if (t && tot.has(t.subjectId)) tot.set(t.subjectId, tot.get(t.subjectId) + s.seconds); });
          studySess.forEach((s) => { const t = tmap.get((s.topic || '').toLowerCase()); if (t && today2.has(t.subjectId)) today2.set(t.subjectId, today2.get(t.subjectId) + s.seconds); });
          const vals = [...tot.values()], mn = Math.min(...vals), mx = Math.max(...vals);
          if (mn < mx && [...tot.entries()].some(([id, x]) => x === mn && today2.get(id) >= v.weakMin * 60)) add('Weak subject', v.weak, 'earn');
        }
        const ws = weekStart(d);
        if (v.weekGoal > 0 && v.weekGoalH > 0) {
          let tot = 0; for (let x = ws; x <= d; x = addDays(x, 1)) tot += sOf(x);
          if (tot >= v.weekGoalH * 3600 && tot - study < v.weekGoalH * 3600) add('Weekly study target reached', v.weekGoal, 'earn');
        }
        if (finished && parseYmd(d).getDay() === 0 && ws >= start) {
          if (v.perfectWeek > 0 && goal > 0) {
            let met = 0, ok = true; for (let x = ws; x <= d; x = addDays(x, 1)) { if (sOf(x) >= goal) met++; else if (!isRest(x)) ok = false; }
            if (ok && met >= 4) add('Perfect week', v.perfectWeek, 'earn');
          }
          if (v.improve > 0) {
            let tw = 0, lw = 0; for (let i = 0; i < 7; i++) { tw += sOf(addDays(ws, i)); lw += sOf(addDays(ws, i - 7)); }
            if (lw > 0 && tw >= lw * 1.1) add('Better than last week', v.improve, 'earn');
          }
        }
        if (v.weekReview > 0 && parseYmd(d).getDay() === 0 && (((data.journal[d] && data.journal[d].text) || '').trim().length >= 100)) add('Weekly review', v.weekReview, 'earn');
        if (v.comeback > 0 && study >= v.comebackMin * 60 && prevCum > 0) { const pd = addDays(d, -1); if (!(studyBy[pd] > 0) && !isRest(pd)) add('Comeback', v.comeback, 'earn'); }
        [[50, 'mile50'], [100, 'mile100'], [250, 'mile250']].forEach(([h, k]) => { if (v[k] > 0 && prevCum < h * 3600 && cumStudy >= h * 3600) add(`${h} hours of study in total`, v[k], 'earn'); });
        const mt = studySess.filter((s) => isMock(s) && s.seconds >= 1800);
        if (mt.length && v.mock > 0) add('Mock test', v.mock, 'earn');
        if (mt.length && v.mockBeat > 0) {
          const sc = mt.map((s) => mockScore(s.topic)).filter((x) => x !== null), prev = mocks.filter((m) => m.date < d).pop();
          if (sc.length && prev && Math.max(...sc) > prev.sc) add('Mock score beat your last', v.mockBeat, 'earn');
        }
      }
      if (finished && parseYmd(d).getDay() === 0 && subs.length) {
        const covered = new Set();
        for (let i = 0; i < 7; i++) (by[addDays(d, -i)] || []).forEach((s) => {
          weeklySubjectIds(s, tmap).forEach((id) => covered.add(id));
        });
        if (subs.every((s) => covered.has(s.id))) add('Every subject studied this week', v.allSubjects, 'earn');
      }
      if (v.routineCap > 0) { let room = v.routineCap; routineInfo(list, isToday ? tm : null).forEach((r) => { const p = Math.min(room, r.n * r.c.earn.pts); if (p > 0) { add(`Routine: ${r.c.name}${r.n > 1 ? ' ×' + r.n : ''}`, p, 'earn'); room -= p; } }); }
      if (v.roundBase > 0) roundsOf(list, isToday ? tm : null).events.forEach((e) => add(`Focus round ${e.k} done`, e.pts, 'earn'));
      let subMiss = [];
      if (subs.length >= 2 && d >= (cfg.subjFrom || start) && (v.subjDay > 0 || v.missSubject > 0)) {
        const ss = new Map(subs.map((x) => [x.id, 0]));
        list.forEach((x) => weeklySubjectIds(x, tmap).forEach((id) => { if (ss.has(id)) ss.set(id, ss.get(id) + x.seconds); }));
        if (isToday && tm) weeklySubjectIds(tm, tmap).forEach((id) => { if (ss.has(id)) ss.set(id, ss.get(id) + tmElapsed); });
        subMiss = subs.filter((x) => ss.get(x.id) < v.subjMin * 60);
        if (!subMiss.length && v.subjDay > 0) add('Every subject studied today', v.subjDay, 'earn');
      }
      const earned = items.reduce((n, i) => n + i.pts, 0);
      // penalties (only for finished days; rest days are protected). Today shows what would apply if it ended now.
      const pens = [];
      if (cfg.penalties && !isRest(d)) {
        if (goal > 0 && study < goal && !boughtPass(d)) { const p = Math.round(v.missGoal * (1 - study / goal)); if (p) pens.push({ label: 'Missed daily goal', pts: -p }); }
        if (subMiss.length && v.missSubject > 0 && !boughtPass(d)) pens.push({ label: `${subMiss.length} ${subMiss.length === 1 ? 'subject' : 'subjects'} skipped`, pts: -subMiss.length * v.missSubject });
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
      days[d].avail = A;
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
  const redsOf = (r) => live(data.redemptions).filter((x) => x.rewardId === r.id && !x.free);
  const restBought = (d) => redLive().find((x) => x.special === 'rest' && x.date === d);
  function rewardPrice(r) {
    const today = todayStr(), recent = redsOf(r).filter((x) => x.date >= addDays(today, -6)).length;
    let p = r.cost * Math.pow(1 + (r.rise || 0) / 100, recent);
    if (r.needsGoal && !r.special && discToken(today)) p *= 1 - Math.min(100, ptv().discPct) / 100;
    return Math.max(1, Math.round(p));
  }
  // yesterday can be shielded when it had no study and nothing already protects it, and a streak existed before it
  function yesterdayShieldable(y) {
    if (streakSafe(y)) return false;
    if (live(data.sessions).some((s) => s.date === y && kindOf(s.type) === 'study')) return false;
    return live(data.sessions).some((s) => s.date < y && kindOf(s.type) === 'study');
  }
  function rewardState(r, pts) {
    const price = rewardPrice(r), today = todayStr(), mine = redsOf(r), goal = data.settings.dailyGoalMin * 60;
    const lim = r.limit || 'none';
    if (r.special === 'rest' && isRest(today)) return { price, ok: false, why: 'Today is already a rest day' };
    { // a bought rest day makes every normal reward cheaper than it free (once each per day)
      const rd = restBought(today);
      if (rd && !r.special && price < rd.cost) {
        if (redLive().some((x) => x.rewardId === r.id && x.free && x.date === today)) return { price: 0, base: price, free: true, ok: false, why: 'Already enjoyed free today' };
        return { price: 0, base: price, free: true, ok: true, why: '' };
      }
    }
    const inDay = mine.filter((x) => x.date === today).length;
    const inWeek = mine.filter((x) => weekStart(x.date) === weekStart(today)).length;
    const inMonth = mine.filter((x) => x.date.slice(0, 7) === today.slice(0, 7)).length;
    if (lim === 'twice' && inDay >= 2) return { price, ok: false, why: 'Limit reached today (twice a day)' };
    if (lim === 'day' && inDay >= 1) return { price, ok: false, why: 'Limit reached today (once a day)' };
    if (lim === 'week' && inWeek >= 1) return { price, ok: false, why: 'Limit reached this week (once a week)' };
    if (lim === 'month' && inMonth >= 1) return { price, ok: false, why: 'Limit reached this month (once a month)' };
    if (r.special === 'shield') {
      const y = addDays(today, -1), yMiss = yesterdayShieldable(y);
      if (shielded(today) && !yMiss) return { price, ok: false, why: 'Today is already protected by a shield' };
      if (isRest(today) && !yMiss) return { price, ok: false, why: 'Today is a rest day, so your streak is safe' };
      if (pts.studyToday > 0 && !yMiss) return { price, ok: false, why: 'You already studied today, so your streak is safe' };
    }
    if (r.special === 'disc' && discToken(today)) return { price, ok: false, why: 'A goal discount is already ready for today' };
    if (r.special === 'waiver' && waiverToken()) return { price, ok: false, why: 'You already have a loan fee waiver ready' };
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
    ['Half-day off', 3000, 'month', false], ['Day trip (big goal)', 4000, 'month', false],
    ['Streak shield (saves a missed day)', 400, 'week', false, 'shield'],
    ['Goal discount (30% off your next goal reward today)', 120, 'week', false, 'disc'],
    ['Loan fee waiver (no fee on your next loan)', 150, 'month', false, 'waiver']
  ];
  const NEW_SPECIALS = ['shield', 'disc', 'waiver'];
  function rewardModal(existing) {
    const r = existing || { name: '', cost: 100, limit: 'none', needsGoal: false, rise: 0 };
    openModal(existing ? 'Edit reward' : 'New reward', `
      <div class="field"><label>Reward</label><input type="text" id="rw-name" value="${esc(r.name)}" placeholder="e.g. Movie night"></div>
      <div class="row">
        <div class="field grow"><label>Cost (points)</label><input type="number" id="rw-cost" min="1" step="10" value="${r.cost}"></div>
        <div class="field grow"><label>Limit</label><select id="rw-limit">${Object.entries(LIMITS).map(([k, l]) => `<option value="${k}" ${(r.limit || 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div class="field grow"><label>Type</label><select id="rw-special"><option value="" ${!r.special ? 'selected' : ''}>Normal reward</option><option value="rest" ${r.special === 'rest' ? 'selected' : ''}>Rest day (protects today)</option><option value="pass" ${r.special === 'pass' ? 'selected' : ''}>Goal pass (skips today’s goal)</option><option value="shield" ${r.special === 'shield' ? 'selected' : ''}>Streak shield (saves a missed day)</option><option value="disc" ${r.special === 'disc' ? 'selected' : ''}>Goal discount (cheaper next goal reward today)</option><option value="waiver" ${r.special === 'waiver' ? 'selected' : ''}>Loan fee waiver (next loan has no fee)</option></select></div>
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
        if (old.special !== nv.special) ch.push(nv.special ? `type set to ${SPECIAL_NAMES[nv.special] || nv.special}` : 'now a normal reward');
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

  // ---- earnings & spending for a chosen period (Day / Week / Month / Custom)
  const itemKey = (l) => /^Study \d|^Study$/.test(l) ? 'Study time' : /^Workout/.test(l) ? 'Workout' : /^Meditation/.test(l) ? 'Meditation' : /^Daily goal/.test(l) ? 'Daily goal' : /^Stretch/.test(l) ? 'Stretch goal'
    : /study blocks? done/.test(l) ? 'Study blocks done' : /focused/.test(l) ? 'Focused sessions' : /^Evening check-in/.test(l) ? 'Evening check-in' : /^Journal/.test(l) ? 'Journal' : /^Sleep/.test(l) ? 'Sleep logged'
    : /-day streak/.test(l) ? 'Streak bonuses' : /^Every subject/.test(l) ? 'All subjects studied' : /^Planned the day/.test(l) ? 'Planned early' : /^Missed daily goal/.test(l) ? 'Missed daily goal'
    : /^Routine:/.test(l) ? 'Routine logging' : /^Focus round/.test(l) ? 'Focus rounds' : /missed blocks?/.test(l) ? 'Missed study blocks' : /penalty cap/.test(l) ? 'Daily penalty cap' : l;
  function rwRange(today) {
    const r = ui.rw, m = r.mode, anchor = r.date && r.date <= today ? r.date : today;
    if (m === 'week') { const s = weekStart(anchor); return { from: s, to: addDays(s, 6) < today ? addDays(s, 6) : today }; }
    if (m === 'month') {
      const ym = r.month || today.slice(0, 7), first = ym + '-01', nxt = parseYmd(first); nxt.setMonth(nxt.getMonth() + 1);
      const last = addDays(ymd(nxt), -1); return { from: first, to: last < today ? last : today };
    }
    if (m === 'custom') {
      let f = r.from || addDays(today, -29), t = r.to || today; if (f > t) [f, t] = [t, f];
      return { from: f, to: t > today ? today : t };
    }
    return { from: anchor, to: anchor };
  }
  function rangeCard(pts) {
    const today = pts.today, r = ui.rw, rg = rwRange(today), m = r.mode;
    const earn = {}, lose = {}; let earned = 0, lost = 0, auto = 0, pendingItems = [];
    const dayList = [];
    for (let d = rg.from; d <= rg.to; d = addDays(d, 1)) {
      const x = pts.days[d]; if (!x) continue;
      dayList.push(d);
      x.items.forEach((i) => { const k = itemKey(i.label); if (i.pts > 0) { earn[k] = (earn[k] || 0) + i.pts; earned += i.pts; } else { lose[k] = (lose[k] || 0) + i.pts; lost += i.pts; } });
      if (x.repaid) auto += x.repaid;
      if (!x.finished && x.pendingItems) pendingItems = x.pendingItems;
    }
    const reds = live(data.redemptions).filter((x) => x.date >= rg.from && x.date <= rg.to).sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : 0));
    const spent = reds.reduce((n, x) => n + x.cost, 0);
    const loans = live(data.loans).filter((x) => x.date >= rg.from && x.date <= rg.to);
    const borrowed = loans.reduce((n, x) => n + x.principal, 0), fees = loans.reduce((n, x) => n + x.fee, 0);
    const manual = live(data.repayments).filter((x) => x.date >= rg.from && x.date <= rg.to).reduce((n, x) => n + x.amount, 0);
    const net = earned + lost - spent;
    let endAvail = null; for (let d = rg.to; d >= rg.from && endAvail === null; d = addDays(d, -1)) if (pts.days[d] && pts.days[d].avail !== undefined) endAvail = pts.days[d].avail;
    const label = m === 'day' ? `${fmtDow(rg.from)}, ${fmtLong(rg.from)}` : m === 'week' ? `Week of ${fmtShort(rg.from)}` : m === 'month' ? parseYmd(rg.from).toLocaleDateString([], { month: 'long', year: 'numeric' }) : `${fmtShort(rg.from)} to ${fmtShort(rg.to)}`;
    const seg = (k, l) => `<button class="${m === k ? 'on' : ''}" data-action="rw-mode" data-v="${k}">${l}</button>`;
    const anchor = r.date && r.date <= today ? r.date : today;
    const ctl = m === 'custom'
      ? `<input type="date" data-change="rw-from" value="${rg.from}" max="${today}"><span class="note">to</span><input type="date" data-change="rw-to" value="${rg.to}" max="${today}">`
      : `<button class="btn sm" data-action="rw-step" data-dir="-1" aria-label="Previous">‹</button>${m === 'month'
          ? `<input type="month" data-change="rw-month" value="${(r.month || today.slice(0, 7))}" max="${today.slice(0, 7)}">`
          : `<input type="date" data-change="rw-date" value="${anchor}" max="${today}">`}<button class="btn sm" data-action="rw-step" data-dir="1" aria-label="Next">›</button>`;
    const rows = (obj, pos) => Object.entries(obj).sort((x, y) => (pos ? y[1] - x[1] : x[1] - y[1])).map(([k, v]) => `<div class="pt-row ${pos ? 'earn' : 'pen'}"><span>${esc(k)}</span><b>${sgn(v)}</b></div>`).join('');
    const dayRows = m === 'day' ? '' : (dayList.length ? [...dayList].reverse().map((d) => { const x = pts.days[d], open = !!ui.rw.open[d]; return `
          <div class="pd ${open ? 'open' : ''}"><div class="pd-head" data-action="pt-open" data-date="${d}"><span class="caret">›</span><span class="grow">${fmtDow(d)}, ${fmtShort(d)}${isRest(d) ? ' <span class="pill rest">Rest</span>' : ''}${x.finished ? '' : ' <span class="note">so far</span>'}</span><b class="${x.total < 0 ? 'neg' : 'pos'}">${sgn(x.total)}</b></div>
          ${open ? `<div class="pd-body">${x.items.length ? itemRows(x.items) : '<div class="note">Nothing earned or lost.</div>'}${x.repaid ? `<div class="pt-row loan"><span>Auto-repaid to your loan</span><b>−${x.repaid}</b></div>` : ''}</div>` : ''}</div>`; }).join('') : '');
    return `
      <div class="card"><h2>Earnings and spending <small>${esc(label)}</small></h2>
        <div class="rg-ctl"><div class="seg">${seg('day', 'Day')}${seg('week', 'Week')}${seg('month', 'Month')}${seg('custom', 'Custom')}</div><div class="rg-nav">${ctl}</div></div>
        ${dayList.length || reds.length ? `
        <div class="rg-stats">
          <div><span class="lbl">Earned</span><b class="pos">${sgn(earned)}</b></div>
          <div><span class="lbl">Lost</span><b class="${lost < 0 ? 'neg' : ''}">${sgn(lost)}</b></div>
          <div><span class="lbl">Spent</span><b class="${spent ? 'neg' : ''}">${spent ? '−' + spent : '0'}</b></div>
          <div><span class="lbl">Net</span><b class="${net < 0 ? 'neg' : 'pos'}">${sgn(net)}</b></div>
        </div>
        ${endAvail !== null ? `<div class="note" style="margin:-4px 0 10px">Available points at the end of ${m === 'day' ? 'the day' : 'the period'}: <b>${endAvail.toLocaleString('en-IN')}</b></div>` : ''}
        ${Object.keys(earn).length ? `<div class="rg-sec"><div class="lbl">Earned</div>${rows(earn, true)}</div>` : ''}
        ${Object.keys(lose).length ? `<div class="rg-sec"><div class="lbl">Lost</div>${rows(lose, false)}</div>` : ''}
        ${pendingItems.length ? `<div class="pt-pending"><div class="lbl">If today ended now</div>${itemRows(pendingItems)}<div class="note">Penalties are only applied when the day ends.</div></div>` : ''}
        ${reds.length ? `<div class="rg-sec"><div class="lbl">Spent on rewards</div>${reds.map((x) => `<div class="pt-row pen"><span>${esc(x.name)} <span class="note">${fmtShort(x.date)}</span></span><b>−${x.cost}</b></div>`).join('')}</div>` : ''}
        ${borrowed || manual || auto ? `<div class="rg-sec"><div class="lbl">Loan</div>
          ${borrowed ? `<div class="pt-row loan"><span>Borrowed (fee ${fees} added to the debt)</span><b>+${borrowed}</b></div>` : ''}
          ${manual ? `<div class="pt-row loan"><span>Repaid by you</span><b>−${manual}</b></div>` : ''}
          ${auto ? `<div class="pt-row loan"><span>Auto-repaid</span><b>−${auto}</b></div>` : ''}</div>` : ''}
        ${dayRows ? `<div class="rg-sec"><div class="lbl">Days <span class="note">(tap a day for the breakdown)</span></div>${dayRows}</div>` : ''}`
        : '<div class="note">No points data for this period yet.</div>'}
      </div>`;
  }

  // ---- Today's goals: what is left to earn today, with progress
  function planDeadline(d) {
    const v = ptv(), cfg = data.pointsCfg;
    const sl = live(data.sessions).filter((s) => s.date === d && kindOf(s.type) === 'sleep').sort((x, y) => y.seconds - x.seconds)[0];
    const by = String(cfg.planBy || '08:00').split(':'), cut = parseYmd(d); cut.setHours(+by[0] || 8, +by[1] || 0, 0, 0);
    return sl ? { limit: sl.start + sl.seconds * 1000 + v.planWindow * 60000, text: `within ${v.planWindow} min of waking` } : { limit: cut.getTime(), text: `by ${cfg.planBy || '08:00'}` };
  }
  function goalsCardHtml(pts) {
    const v = ptv(), today = pts.today, now = Date.now(), td = pts.days[today];
    const goalSec = data.settings.dailyGoalMin * 60, st = pts.studyToday;
    const sess = live(data.sessions).filter((s) => s.date === today), tm = data.timer;
    const tmEl = tm ? Math.round(elapsedMs(tm) / 1000) : 0;
    const earnedLabels = new Set(((td && td.items) || []).map((i) => itemKey(i.label)));
    const goals = [];
    const push = (g) => goals.push(g);
    const eod = new Date(); eod.setHours(24, 0, 0, 0);
    const dayLeft = Math.max(0, Math.round((eod.getTime() - now) / 1000));
    const more = (need, have) => { const l = Math.max(0, need - have); return l ? `${short(l)} more to go${l > dayLeft ? ' · not reachable before midnight' : ''}` : ''; };
    const earnedFor = (re) => ((td && td.items) || []).filter((i) => re.test(i.label)).reduce((n, i) => n + i.pts, 0);
    // 1. plan the day
    if (v.plan > 0) {
      if (earnedLabels.has('Planned early')) push({ id: 'plan', name: 'Plan your day', pts: v.plan, state: 'done', dn: 'Planned in time' });
      else { const dl = planDeadline(today), left = Math.ceil((dl.limit - now) / 60000);
        if (left > 0) push({ id: 'plan', name: 'Plan your day', pts: v.plan, state: 'open', note: `Make a plan in the Timetable ${dl.text}${left < 180 ? ` · ${left} min left` : ''}`, urgent: true });
        else push({ id: 'plan', name: 'Plan your day', pts: v.plan, state: 'missed', note: `The window (${dl.text}) has passed` }); }
    }
    // 2. daily goal
    if (v.goal > 0 && goalSec > 0) push({ id: 'goal', name: 'Daily study goal', pts: v.goal, state: st >= goalSec ? 'done' : 'open', pct: st / goalSec * 100, note: `${short(st)} of ${short(goalSec)} · ${more(goalSec, st)}`, dn: `${short(st)} studied` });
    // 3. study blocks
    { const plan = resolvePlan(today), blocks = plan.blocks.filter((b) => kindOf(b.type) === 'study' && !plan.skipped.includes(b.id));
      if (blocks.length && v.blockM) {
        let done = 0, left = 0;
        blocks.forEach((b) => {
          const dur = blockDur(b) * 60; let act = sess.filter((s) => s.planDate === today && s.blockId === b.id).reduce((n, s) => n + s.seconds, 0);
          if (tm && tm.blockId === b.id && tm.planDate === today) act += tmEl;
          const ok = dur > 0 && (act >= dur * 0.9 || (act > 0 && (plan.completed || []).includes(b.id)));
          if (ok) done++; else left += v.blockM;
        });
        push({ id: 'blocks', name: 'Study blocks', pts: done === blocks.length ? earnedFor(/study block/) : left, state: done === blocks.length ? 'done' : 'open', pct: done / blocks.length * 100, note: `${done} of ${blocks.length} study blocks done${left ? ` · +${left} still to earn` : ''}`, dn: `All ${blocks.length} blocks done${earnedFor(/study block/) ? ` · earned +${earnedFor(/study block/)}` : ''}` });
      } }
    // 4. stretch goal
    if (v.stretch > 0 && goalSec > 0 && v.stretchMin * 60 > goalSec) push({ id: 'stretch', name: 'Stretch goal', pts: v.stretch, state: st >= v.stretchMin * 60 ? 'done' : 'open', pct: st / (v.stretchMin * 60) * 100, note: `${short(st)} of ${short(v.stretchMin * 60)} · ${more(v.stretchMin * 60, st)}`, dn: `${short(st)} studied` });
    // 5. workout
    if (v.workout30 > 0 && v.workoutMax > 0) {
      let w = sess.filter((s) => kindOf(s.type) !== 'study' && kindOf(s.type) !== 'sleep' && isWorkout(s)).reduce((n, s) => n + s.seconds, 0);
      if (tm && kindOf(tm.type) !== 'study' && kindOf(tm.type) !== 'sleep' && isWorkout(tm)) w += tmEl;
      const cap = v.workoutMax * 1800;
      push({ id: 'workout', name: 'Workout', pts: Math.round(cap / 60 * v.workout30 / 30), state: w >= cap ? 'done' : 'open', pct: w / cap * 100, note: `${short(w)} of ${short(cap)} counted · ${more(cap, w)} · counts: workout, exercise, gym, yoga, fitness`, dn: `${short(w)} counted` });
    }
    // 5a. meditation
    if (v.meditate30 > 0 && v.meditateMax > 0) {
      let m = sess.filter((s) => kindOf(s.type) !== 'study' && kindOf(s.type) !== 'sleep' && isMeditation(s)).reduce((n, s) => n + s.seconds, 0);
      if (tm && kindOf(tm.type) !== 'study' && kindOf(tm.type) !== 'sleep' && isMeditation(tm)) m += tmEl;
      const cap = v.meditateMax * 1800;
      push({ id: 'meditate', name: 'Meditation', pts: Math.round(cap / 60 * v.meditate30 / 30), state: m >= cap ? 'done' : 'open', pct: m / cap * 100, note: `${short(m)} of ${short(cap)} counted · ${more(cap, m)} · counts: meditation, mindfulness, breathing`, dn: `${short(m)} counted` });
    }
    // 5b. early start and deep work
    { const sl = sess.filter((s) => kindOf(s.type) === 'sleep').sort((x, y) => y.seconds - x.seconds)[0];
      if (v.earlyStart > 0 && sl) {
        const wake = sl.start + sl.seconds * 1000, lim = wake + v.earlyWin * 60000, left = Math.ceil((lim - now) / 60000);
        if (earnedLabels.has('Early start')) push({ id: 'early', name: 'Early start', pts: v.earlyStart, state: 'done', dn: `Started within ${v.earlyWin} min of waking` });
        else if (left > 0) push({ id: 'early', name: 'Early start', pts: v.earlyStart, state: 'open', note: `Start studying within ${v.earlyWin} min of waking · ${left} min left`, urgent: true });
        else push({ id: 'early', name: 'Early start', pts: v.earlyStart, state: 'missed', note: `The window closed ${v.earlyWin} min after you woke at ${new Date(wake).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
      }
      if (v.deep > 0) {
        let best = Math.max(0, ...sess.filter((s) => kindOf(s.type) === 'study' && s.focus >= 4).map((s) => s.seconds));
        if (earnedLabels.has('Deep work')) push({ id: 'deep', name: 'Deep work', pts: v.deep, state: 'done', dn: 'Deep session completed' });
        else push({ id: 'deep', name: 'Deep work', pts: v.deep, state: 'open', pct: best / (v.deepMin * 60) * 100, note: `One session of ${short(v.deepMin * 60)}+ rated 4–5 · best so far ${short(best)}${best < v.deepMin * 60 ? ` (${short(v.deepMin * 60 - best)} more)` : ' · rate it 4–5 to count'}${v.deepMin * 60 > dayLeft ? ' · not reachable before midnight' : ''}` });
      } }
    // 6. focused sessions (a running count, never "done")
    if (v.focus > 0) { const n = sess.filter((s) => kindOf(s.type) === 'study' && s.focus >= 4 && s.seconds >= 1800).length;
      push({ id: 'focus', name: 'Focused sessions', pts: v.focus, state: 'count', note: `${n} so far (+${n * v.focus} earned) · each session rated 4–5 and 30+ min adds +${v.focus}` }); }
    // 7. daily ticks
    const ci = data.checkins[today];
    [['checkin', 'Evening check-in', v.checkin, !!(ci && (ci.mood || ci.focus)), 'Rate your mood and focus on the Today page'],
     ['journal', 'Journal entry', v.journal, !!(((data.journal[today] && data.journal[today].text) || '').trim()), 'Write a line in your journal'],
     ['sleep', 'Sleep logged', v.sleep, sess.some((s) => kindOf(s.type) === 'sleep'), 'Log last night’s sleep']].forEach(([id, name, p, ok, note]) => { if (p > 0) push({ id, name, pts: p, state: ok ? 'done' : 'open', note, dn: ok ? 'Done for today' : '' }); });
    // 8. streak milestone
    { const cur = streak(), next = [3, 7, 30].find((m) => m > cur);
      if (next && v['streak' + next] > 0) push({ id: 'streak', name: `${next}-day streak`, pts: v['streak' + next], state: 'open', pct: cur / next * 100, note: `${cur} of ${next} days${cur + 1 === next ? ' · study today to get it' : ` · ${next - cur} more day${next - cur === 1 ? '' : 's'}`}`, dots: next <= 10 ? { on: cur, total: next } : null }); }
    // 8a. focus rounds
    if (v.roundBase > 0) { const rs = roundNow(), nx = roundPts(rs.k), got = rs.events.reduce((n, e) => n + e.pts, 0);
      push({ id: 'rounds', name: 'Focus rounds', pts: nx, state: 'open', pct: Math.min(100, rs.acc / ROUND_SEC * 100),
        note: `${rs.done ? `Round ${rs.k}: break due (10 min, back within 15)` : `Round ${rs.k} · ${short(rs.acc)} of 1h`}${nx ? ` · +${nx} when you return from the break` : ' · round 1 starts your chain'}${got ? ` · earned +${got} today` : ''}` }); }
    // 8a2. routine logging
    if (v.routineCap > 0) { const ri = routineInfo(sess, tm);
      if (ri.length) {
        let room = v.routineCap, left = 0; ri.forEach((r) => { const e = Math.min(room, r.n * r.c.earn.pts); room -= e; left += (r.max - r.n) * r.c.earn.pts; });
        left = Math.min(left, room); const tot = ri.reduce((n, r) => n + r.max, 0), got = ri.reduce((n, r) => n + r.n, 0);
        push({ id: 'routine', name: 'Routine logging', pts: left, state: got >= tot || (left <= 0) ? 'done' : 'open', pct: got / tot * 100,
          note: `Log them to earn: ${ri.map((r) => `${r.c.name} +${r.c.earn.pts}${r.max > 1 ? ' each' : ''}${r.c.earn.min ? ` (${r.c.earn.min}+ min)` : ''}`).join(' · ')} · max +${v.routineCap} a day`,
          chips: ri.map((r) => ({ n: `${r.c.name} ${r.n}/${r.max}`, ok: r.n >= r.max })), dn: `Routine logged · +${Math.min(v.routineCap, ri.reduce((n, r) => n + r.n * r.c.earn.pts, 0))}` });
      } }
    // 8b. every subject today
    { const subs = live(data.subjects).filter((s) => !s.noWeekly && live(data.topics).some((t) => t.subjectId === s.id));
      if (subs.length >= 2 && (v.subjDay > 0 || v.missSubject > 0)) {
        const tmap = new Map(live(data.topics).map((t) => [t.name.toLowerCase(), t])), ss = new Map(subs.map((x) => [x.id, 0]));
        sess.forEach((x) => weeklySubjectIds(x, tmap).forEach((id) => { if (ss.has(id)) ss.set(id, ss.get(id) + x.seconds); }));
        if (tm) weeklySubjectIds(tm, tmap).forEach((id) => { if (ss.has(id)) ss.set(id, ss.get(id) + tmEl); });
        const need = v.subjMin * 60, okn = subs.filter((x) => ss.get(x.id) >= need).length, miss = subs.filter((x) => ss.get(x.id) < need);
        push({ id: 'subjday', name: 'Every subject today', pts: v.subjDay, state: !miss.length ? 'done' : 'open', pct: okn / subs.length * 100,
          note: `${okn} of ${subs.length} subjects${need ? ` (${short(need)} each)` : ''}${v.missSubject > 0 ? ` · −${v.missSubject} for each one skipped when the day ends` : ''}`,
          chips: subs.map((x) => ({ n: ss.get(x.id) >= need ? x.name : `${x.name} · ${short(need - ss.get(x.id))} left`, ok: ss.get(x.id) >= need })), dn: `All ${subs.length} subjects studied today` });
      } }
    // 9. every subject this week
    { const subs = live(data.subjects).filter((s) => !s.noWeekly && live(data.topics).some((t) => t.subjectId === s.id));
      if (subs.length && v.allSubjects > 0) {
        const tmap = new Map(live(data.topics).map((t) => [t.name.toLowerCase(), t])), cov = new Set();
        for (let d = weekStart(today); d <= today; d = addDays(d, 1)) live(data.sessions).filter((s) => s.date === d).forEach((s) => weeklySubjectIds(s, tmap).forEach((id) => cov.add(id)));
        const n = subs.filter((s) => cov.has(s.id)).length, miss = subs.filter((s) => !cov.has(s.id));
        const dl = (7 - ((parseYmd(today).getDay() + 6) % 7) - 1);
        push({ id: 'subjects', name: 'Every subject this week', pts: v.allSubjects, state: n === subs.length ? 'done' : 'open', pct: n / subs.length * 100,
          note: `${n} of ${subs.length} subjects · ${miss.length ? `still to study: ${miss.map((x) => x.name).join(', ')} · ` : ''}paid on Sunday${dl === 0 ? ' (today!)' : ` (${dl} day${dl === 1 ? '' : 's'} left)`}`,
          chips: subs.map((x) => ({ n: x.name, ok: cov.has(x.id) })), dn: `All ${subs.length} subjects studied this week` });
      } }
    const open = goals.filter((g) => g.state === 'open' || g.state === 'count'), done = goals.filter((g) => g.state === 'done'), missed = goals.filter((g) => g.state === 'missed');
    open.sort((x, y) => (y.urgent ? 1 : 0) - (x.urgent ? 1 : 0));
    const row = (g) => `<div class="gl ${g.state}${g.urgent ? ' urgent' : ''}">
        <div class="gl-top"><span class="gl-nm">${g.state === 'done' ? '<span class="gl-ck">✓</span>' : ''}${esc(g.name)}</span><span class="gl-pts">${g.state === 'count' ? '+' + g.pts + ' each' : g.pts ? '+' + g.pts : ''}</span></div>
        ${g.pct !== undefined && g.state !== 'done' ? `<div class="bar"><i style="width:${Math.min(100, Math.max(0, g.pct))}%"></i></div>` : ''}
        ${g.dots && g.state !== 'done' ? `<div class="gl-dots">${Array.from({ length: g.dots.total }, (_, i) => `<i class="${i < g.dots.on ? 'on' : ''}"></i>`).join('')}</div>` : ''}
        ${g.note && g.state !== 'done' ? `<div class="gl-note">${esc(g.note)}</div>` : ''}
        ${g.chips && g.state !== 'done' ? `<div class="gl-chips">${g.chips.map((c) => `<span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'} ${esc(c.n)}</span>`).join('')}</div>` : ''}
        ${g.state === 'done' && g.dn ? `<div class="gl-note">${esc(g.dn)}</div>` : ''}</div>`;
    const waived = goalWaived(today) ? `<div class="pt-pending" style="margin:0 0 12px"><div class="note">${boughtPass(today) ? 'Goal pass active' : 'Rest day'}: today's goal is waived, so goal-gated rewards are unlocked.</div></div>` : '';
    const doneRows = done.concat(missed);
    return `
      <div class="card"><h2>Today’s goals <small>Earned today ${sgn(td ? td.earned : 0)}</small></h2>
        ${waived}
        ${open.length ? `<div class="gl-list">${open.map(row).join('')}</div>` : '<div class="note">Everything is done for today. Nice work.</div>'}
        ${doneRows.length ? `<div class="gl-done"><button class="linkbtn" data-action="gl-toggle">${ui.rw.goalsDone ? 'Hide' : 'Show'} finished (${doneRows.length})</button>${ui.rw.goalsDone ? `<div class="gl-list" style="margin-top:10px">${doneRows.map(row).join('')}</div>` : ''}</div>` : ''}
      </div>`;
  }

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

    const tokenNotes = (() => { const n = []; const rdb = restBought(today); if (rdb) n.push(`Rest day: every reward under ${rdb.cost} points is free today (once each)`);
      redLive().filter((r) => r.special === 'shield' && (r.for || r.date) >= today).forEach((r) => n.push(`Streak shield active for ${(r.for || r.date) === today ? 'today' : fmtShort(r.for || r.date)}`));
      if (discToken(today)) n.push(`Goal discount ready: ${v.discPct}% off your next goal-gated reward today`);
      if (waiverToken()) n.push('Loan fee waiver ready: your next loan has no fee');
      return n.length ? `<div class="pt-pending" style="margin:0 0 12px">${n.map((t) => `<div class="note">${esc(t)}</div>`).join('')}</div>` : ''; })();
    const rcard = (r) => {
      const st = rewardState(r, pts), pct = st.free ? 100 : Math.min(100, pts.A / st.price * 100);
      const rise = r.rise && st.price !== r.cost ? ` <span class="note">(base ${r.cost})</span>` : '';
      return `<div class="rw-card ${st.ok ? 'ready' : ''}">
        <div class="rw-top"><b>${esc(r.name)}</b><span class="rw-cost">${st.free ? 'Free' : st.price.toLocaleString('en-IN') + ' pts'}${st.free ? ` <span class="note">(was ${st.base})</span>` : rise}</span></div>
        <div class="rw-meta">${LIMITS[r.limit || 'none']}${r.special === 'rest' ? ' · protects your streak, no penalties' : r.special === 'pass' ? ' · skips today’s goal and its penalty' : r.special === 'shield' ? ' · a missed day will not break your streak' : r.special === 'disc' ? ` · ${v.discPct}% off your next goal-gated reward today` : r.special === 'waiver' ? ' · your next loan has no fee' : ''}${st.free ? ' · free on your rest day' : ''}${r.needsGoal && !r.special && !st.free && discToken(today) ? ' · discount active' : ''}${r.needsGoal ? ' · after today’s goal' : ''}${r.allowDebt ? ' · open while in debt' : ''}${r.rise ? ` · +${r.rise}% per use` : ''}</div>
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
        ${tokenNotes}
        ${rewards.length && !rewards.some((r) => NEW_SPECIALS.includes(r.special)) ? '<div class="pt-pending" style="margin:0 0 12px"><div class="note">New special rewards are available: streak shield, goal discount and loan fee waiver. <button class="linkbtn" data-action="rw-add-specials">Add them</button></div></div>' : ''}
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
        ${hist.length ? hist.map((x) => `<div class="list-row"><div class="grow"><div class="nm">${esc(x.name)}</div><div class="meta">${fmtShort(x.date)}</div></div><b class="neg">${x.free ? 'Free' : '−' + x.cost}</b><button class="btn sm" data-action="rd-undo" data-id="${x.id}">Undo</button></div>`).join('')
          : '<div class="note">Nothing redeemed yet.</div>'}
      </div>`;

    const days = rangeCard(pts);
    const goalsCard = goalsCardHtml(pts);

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
        ${goalsCard}
        <div class="grid">
          <div class="stack">${loanCard}${shop}${history}</div>
          <div class="stack">${chart}${days}${settings}${logCard}</div>
        </div>
      </div>`;
  }

  // =====================================================================
  //  RENDER + EVENTS
  // =====================================================================
  // While a timer or stopwatch is running, everything except the timer card is blurred and cannot be used. Pausing unlocks it.
  const isStudyTimer = (t) => !!t && kindOf(t.type) === 'study';

  // =====================================================================
  //  FOCUS ROUNDS: 60 minutes of study (across all topics and blocks) is one round.
  //  A break of 8+ minutes ends it. Coming back within 15 minutes of the break
  //  earns a reward from round 2 on, growing with each round. Counted per day.
  // =====================================================================
  const ROUND_SEC = 3600, ROUND_BRK = 480, ROUND_RET = 900;
  const roundPts = (k) => { const v = ptv(); return k >= 2 && v.roundBase > 0 ? Math.min(v.roundCap, v.roundBase + v.roundStep * (k - 2)) : 0; };
  function roundsOf(sessList, tmLive) {
    const it = sessList.filter((s) => kindOf(s.type) === 'study').map((s) => ({ st: s.start, sec: s.seconds, en: s.start + (s.seconds + (s.pausedSec || 0)) * 1000 }));
    if (tmLive && kindOf(tmLive.type) === 'study') it.push({ st: tmLive.startWall, sec: Math.round(elapsedMs(tmLive) / 1000), en: Date.now() });
    it.sort((a, b) => a.st - b.st);
    let k = 1, acc = 0, last = null; const events = [];
    it.forEach((x) => {
      if (last !== null) {
        const gap = (x.st - last) / 1000;
        if (gap >= ROUND_BRK) {
          if (acc >= ROUND_SEC) { if (gap <= ROUND_RET) { const p = roundPts(k); if (p) events.push({ k, pts: p }); k++; } else k = 1; }
          acc = 0;
        }
      }
      acc += x.sec; last = x.en;
    });
    // not studying right now: a long enough time away ends the round (and resets the chain if the 15 minutes ran out)
    if (last !== null && !(tmLive && kindOf(tmLive.type) === 'study')) {
      const away = (Date.now() - last) / 1000;
      if (away >= ROUND_BRK) { if (acc >= ROUND_SEC && away > ROUND_RET) k = 1; if (acc < ROUND_SEC || away > ROUND_RET) acc = 0; }
    }
    return { k, acc, events, done: acc >= ROUND_SEC };
  }
  // routine logging: small rewards for categories that have "earn" set (meals, shower...), capped per day
  function routineInfo(sessList, tmLive) {
    const tmSec = tmLive ? Math.round(elapsedMs(tmLive) / 1000) : 0;
    return live(data.categories).filter((c) => c.earn && c.earn.pts > 0 && c.kind === 'neutral').map((c) => {
      const min = (c.earn.min || 0) * 60, have = sessList.filter((x) => x.type === c.id && x.seconds >= min).length + (tmLive && tmLive.type === c.id && tmSec >= min ? 1 : 0);
      return { c, n: Math.min(have, c.earn.max || 1), max: c.earn.max || 1 };
    });
  }
  const roundNow = () => { const t = todayStr(); return roundsOf(live(data.sessions).filter((s) => s.date === t), data.timer); };
  const rndText = () => { const r = roundNow(); return r.done ? `Round ${r.k} · break due` : `Round ${r.k} · ${Math.floor(r.acc / 60)}/60 min`; };
  function takeRoundBreak() {
    if (data.timer) stopTimer(true, { quiet: true });
    startTimer({ type: 'break', topic: 'Break', mode: 'countdown', minutes: 10, roundBreak: true });
    render();
  }
  function roundDialog(t) {
    const r = ui.round = ui.round || { snooze: 0, untilStop: null }, rs = roundNow(), nx = roundPts(rs.k);
    r.snooze = Date.now() + 600000;
    if (data.settings.sound !== false) ting();
    const btns = [];
    if (t) btns.push({ label: 'Keep going: finish this block first', fn: () => { r.untilStop = t.id; } });
    btns.push({ label: 'Ask again in 10 min', fn: () => { r.snooze = Date.now() + 600000; } });
    btns.push({ label: 'Start 10 min break', cls: 'primary', fn: takeRoundBreak });
    choiceModal(`${rs.k === 1 ? '1 hour' : 'Round ' + rs.k} of study done`, `
      <p style="line-height:1.55;margin-bottom:8px">You have studied <b>${short(rs.acc)}</b> this round. Take a <b>10 minute break</b>?</p>
      <p class="note">${nx ? `Come back within 15 minutes of the break to earn <b>+${nx}</b>.` : 'Round 1 starts your chain. Come back within 15 minutes of the break and each round after it earns a reward.'}</p>`, btns);
  }
  function nextStudyBlock() {
    const d = activePlanDate(), plan = resolvePlan(d), now = Date.now();
    const cand = sortBlocks(plan.blocks).filter((b) => kindOf(b.type) === 'study' && !plan.skipped.includes(b.id) && !(plan.completed || []).includes(b.id) && blockActual(d, b.id) < blockDur(b) * 60 * 0.9);
    return { d, b: cand.find((b) => blockTimes(d, b).endMs > now) || cand[0] || null };
  }
  function backToStudy() {
    if (data.timer) stopTimer(true, { quiet: true });
    const nb = nextStudyBlock();
    if (nb.b) { startFromBlock(nb.d, nb.b.id); return; }
    const td = todayStr(), ls = live(data.sessions).filter((x) => x.date === td && kindOf(x.type) === 'study').sort((x, y) => y.start - x.start)[0];
    startTimer({ type: ls ? ls.type : 'study', topic: ls ? ls.topic : '', mode: 'stopwatch', minutes: 0 });
  }
  function backDialog() {
    const nb = nextStudyBlock();
    choiceModal('Break over', `<p style="line-height:1.55">Back to studying to keep your round chain going?${nb.b ? `<br><span class="note">Next: ${esc(nb.b.topic)} (${nb.b.start}–${nb.b.end})</span>` : ''}</p>`,
      [{ label: 'Not yet' }, { label: 'Back to studying', cls: 'primary', fn: backToStudy }]);
  }
  function roundWatch(t, el) {
    if ($('#modal-root').innerHTML) return;
    const r = ui.round = ui.round || { snooze: 0, untilStop: null };
    if (isStudyTimer(t) && t.startedAt) {
      if (Date.now() < r.snooze || r.untilStop === t.id) return;
      if (roundNow().acc >= ROUND_SEC) roundDialog(t);
    } else if (t.roundBreak && kindOf(t.type) === 'break' && t.mode === 'countdown' && t.startedAt && el >= t.targetSec && !t.backAsked) {
      t.backAsked = true; persist(true); if (data.settings.sound !== false) ting(); backDialog();
    }
  }

  const lockKind = (t) => { const k = kindOf(t.type); return k === 'study' || (k !== 'break' && k !== 'sleep' && !!data.settings.lockOther); };
  const focusLocked = () => !!(data && data.timer && data.timer.startedAt && lockKind(data.timer));
  let lockApplied = false;
  function applyFocusLock() {
    const main = $('#main'), side = $('.side'), on = focusLocked();
    $$('.lock-dim').forEach((el) => { el.classList.remove('lock-dim'); el.inert = false; });
    document.body.classList.toggle('focus-lock', on);
    if (on) {
      const keep = $('.timer-live', main);
      if (keep) {
        let node = keep;
        while (node !== main && node.parentElement) {
          const parent = node.parentElement;
          Array.from(parent.children).forEach((sib) => { if (sib !== node) { sib.classList.add('lock-dim'); sib.inert = true; } });
          node = parent;
        }
      }
      side.classList.add('lock-dim'); side.inert = true;
      if (!lockApplied && keep) keep.scrollIntoView({ block: 'center' });
    }
    lockApplied = on;
  }
  function render() {
    if (focusLocked() && ui.page !== 'today') { ui.page = 'today'; ui.date = todayStr(); }
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
    applyFocusLock();
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
      syncStartCard();
    },
    'set-mode': (el) => { ui.form.mode = el.dataset.v; if (ui.form.mode === 'countdown' && !(ui.form.minutes > 0)) ui.form.minutes = 25; syncStartCard(); },
    'f-min-step': (el) => { ui.form.minutes = Math.min(600, Math.max(1, (parseInt(ui.form.minutes, 10) || 25) + (+el.dataset.v))); syncStartCard(); },
    'use-topic': (el) => {
      ui.form.topic = el.dataset.v;
      const hit = live(data.topics).find((x) => x.name.toLowerCase() === ui.form.topic.toLowerCase());
      if (hit && hit.priority && kindOf(ui.form.type) !== 'break' && kindOf(ui.form.type) !== 'sleep') ui.form.priority = hit.priority;
      syncStartCard(); const i = $('#f-topic'); if (i) i.focus();
    },
    'use-preset': (el) => { const p = live(data.presets).find((x) => x.id === el.dataset.id); if (p) { applyPreset(p); syncStartCard(); toast(`Preset loaded: ${p.name}`); } },
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
    'rw-add-specials': () => {
      SUGGESTED_REWARDS.filter((x) => NEW_SPECIALS.includes(x[4])).forEach(([name, cost, limit, needsGoal, special]) => { if (!live(data.rewards).some((r) => r.special === special)) data.rewards.push(touch({ id: uid(), name, cost, limit, needsGoal, rise: 0, special })); });
      ptLog('Added streak shield, goal discount and loan fee waiver rewards'); persist(true); render(); toast('Added. Edit the costs to suit you');
    },
    'rw-redeem': (el) => {
      const r = live(data.rewards).find((x) => x.id === el.dataset.id); if (!r) return;
      const pts = computePoints(), st = rewardState(r, pts);
      if (!st.ok) { toast(st.why); return; }
      const finish = (forDate) => {
        const rec = touch({ id: uid(), rewardId: r.id, name: r.name, cost: st.price, date: todayStr(), ...(r.special ? { special: r.special } : {}), ...(st.free ? { free: true } : {}) });
        if (r.special === 'shield') rec.for = forDate;
        let tok = null;
        if (r.needsGoal && !r.special && !st.free) { tok = discToken(todayStr()); if (tok) { tok.used = true; touch(tok); rec.usedDisc = tok.id; } }
        data.redemptions.push(rec); persist(true); render();
        const msg = r.special === 'rest' ? `Rest day unlocked for ${st.price} points. Today is protected`
          : r.special === 'pass' ? `Goal pass bought for ${st.price} points. Today's goal is waived`
          : r.special === 'shield' ? `Streak shield bought for ${st.price} points. ${forDate === todayStr() ? 'Today' : fmtShort(forDate)} is protected`
          : r.special === 'disc' ? `Goal discount bought. ${ptv().discPct}% off your next goal-gated reward today`
          : r.special === 'waiver' ? 'Loan fee waiver bought. Your next loan has no fee'
          : st.free ? `Enjoy "${r.name}". It is free on your rest day`
          : `Redeemed "${r.name}" for ${st.price} points${tok ? ` (${ptv().discPct}% discount used)` : ''}`;
        toast(msg, () => { rec.deleted = true; touch(rec); if (tok) { tok.used = false; touch(tok); } persist(true); render(); });
      };
      if (r.special === 'shield') {
        const t = todayStr(), y = addDays(t, -1);
        if (yesterdayShieldable(y) && !(shielded(t) || isRest(t) || pts.studyToday > 0)) {
          choiceModal('Which day should the shield protect?', `<p class="note" style="margin-bottom:14px">You did not study yesterday (${fmtShort(y)}). Protect that day, or today?</p>`, [
            { label: 'Cancel' }, { label: 'Today', fn: () => finish(t) }, { label: `Yesterday (${fmtShort(y)})`, cls: 'primary', fn: () => finish(y) }]);
        } else finish(yesterdayShieldable(y) && (shielded(t) || isRest(t) || pts.studyToday > 0) ? y : t);
        return;
      }
      finish(todayStr());
    },
    'rd-undo': (el) => { const x = live(data.redemptions).find((r) => r.id === el.dataset.id); if (x) { if (x.usedDisc) { const tk = data.redemptions.find((r) => r.id === x.usedDisc); if (tk) { tk.used = false; touch(tk); } } softDelete(x, `Returned ${x.cost} points for "${x.name}"`); } },
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
        <p class="note">${waiverToken() ? 'You have a loan fee waiver ready: this loan has <b>no fee</b>.' : `A ${v.loanFee}% fee is added once. For 500 points you would owe ${Math.round(500 * (1 + v.loanFee / 100))}.`} Your level and score do not change.</p>`, () => {
        const amt = Math.round(parseFloat($('#loan-new').value));
        if (!(amt >= 1) || amt > max) { toast(`Enter 1 to ${max}`); return false; }
        const wv = waiverToken(), fee = wv ? 0 : Math.round(amt * v.loanFee / 100);
        const rec = touch({ id: uid(), date: todayStr(), principal: amt, fee });
        if (wv) { wv.used = true; touch(wv); rec.waiver = wv.id; }
        data.loans.push(rec); ptLog(`Took a loan of ${amt} (owe ${amt + fee})${wv ? ', fee waived' : ''}`);
        persist(true); render();
        toast(`Borrowed ${amt} points. You owe ${amt + fee}${wv ? ' (fee waived)' : ''}`, () => { rec.deleted = true; touch(rec); if (wv) { wv.used = false; touch(wv); } ptLog(`Cancelled the loan of ${amt}`); persist(true); render(); });
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
    'undo-toggle': () => { ui.undoOpen = !ui.undoOpen; try { localStorage.setItem('st-undo-open', ui.undoOpen ? '1' : '0'); } catch (e) { /* ignore */ } render(); },
    'hist-undo': (el) => histUndo(el.dataset.id),
    'gl-toggle': () => { ui.rw.goalsDone = !ui.rw.goalsDone; render(); },
    'rw-mode': (el) => { ui.rw.mode = el.dataset.v; if (ui.rw.mode === 'custom') { const t = todayStr(); ui.rw.from = ui.rw.from || addDays(t, -29); ui.rw.to = ui.rw.to || t; } render(); },
    'rw-step': (el) => {
      const dir = +el.dataset.dir, today = todayStr(), r = ui.rw;
      if (r.mode === 'month') { const ym = r.month || today.slice(0, 7), d = parseYmd(ym + '-01'); d.setMonth(d.getMonth() + dir); const nm = ymd(d).slice(0, 7); r.month = nm > today.slice(0, 7) ? today.slice(0, 7) : nm; }
      else { const cur = r.date && r.date <= today ? r.date : today, nx = addDays(cur, dir * (r.mode === 'week' ? 7 : 1)); r.date = nx > today ? today : nx; }
      render();
    },
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
    'ib-toggle': () => { ui.ib.open = !ui.ib.open; try { localStorage.setItem('st-ib-open', ui.ib.open ? '1' : '0'); } catch (e) { /* ignore */ } render(); },
    'ib-add': (el) => { const it = data.important.items.find((x) => x.id === el.dataset.id); if (it) addBlock(ttDate(), { topic: it.text, priority: it.prio || 'medium' }); },
    'ib-more': (el) => {
      const it = data.important.items.find((x) => x.id === el.dataset.id); if (!it) return;
      openModal(`Add "${it.text}" to the timeline`, `
        <div class="row"><div class="field grow"><label>Length (minutes)</label><input type="number" id="ib-min" min="5" max="480" step="5" value="${defaultBlockMin()}"></div>
        <div class="field grow"><label>Start time (optional)</label><input type="time" id="ib-start"></div></div>
        <p class="note">Leave the time empty to use the first free slot.</p>`, () => {
        const m = parseInt($('#ib-min').value, 10); if (!(m >= 5)) { toast('Enter at least 5 minutes'); return false; }
        const t = $('#ib-start').value;
        addBlock(ttDate(), { topic: it.text, priority: it.prio || 'medium', minutes: m, pref: t ? offMin(t) : undefined });
      }, 'Add');
    },
    'ib-add-all': () => {
      const date = ttDate(), plan = resolvePlan(date), added = [];
      impItems().forEach((i) => {
        if (i.done || plan.blocks.some((b) => (b.topic || '').toLowerCase() === i.text.toLowerCase())) return;
        if (live(data.sessions).some((s) => s.date === date && kindOf(s.type) === 'study' && s.topic.toLowerCase() === i.text.toLowerCase())) return;
        const b = addBlock(date, { topic: i.text, priority: i.prio || 'medium' }, true); if (b) added.push(b.id);
      });
      if (!added.length) { toast('Nothing to add, or no room left'); return; }
      toast(`Added ${added.length} ${added.length === 1 ? 'topic' : 'topics'} to the timeline`, () => savePlan(date, (next) => { next.blocks = next.blocks.filter((x) => !added.includes(x.id)); }));
    },
    'ib-recent': (el) => { const e = recentBlocks(ttDate())[+el.dataset.i]; if (e) addBlock(ttDate(), { topic: e.topic, type: e.type, priority: e.priority, minutes: e.minutes, pref: offMin(e.start) }); },
    'ms-toggle': () => { ui.ms.open = !ui.ms.open; try { localStorage.setItem('st-ms-open', ui.ms.open ? '1' : '0'); } catch (e) { /* ignore */ } render(); },
    'ms-more': () => { ui.ms.all = !ui.ms.all; render(); },
    'ms-hide': (el) => { const k = el.dataset.k; setMissedHidden([k], true); toast('Removed from the list', () => setMissedHidden([k], false)); },
    'ms-clear': () => {
      const keys = missedBlocks().map((m) => m.key);
      if (keys.length && confirm(`Remove all ${keys.length} missed blocks from this list?`)) { setMissedHidden(keys, true); toast('List cleared', () => setMissedHidden(keys, false)); }
    },
    'ms-add': (el) => {
      const m = missedBlocks().find((x) => x.key === el.dataset.k); if (!m) return;
      const blk = addBlock(ttDate(), { topic: m.b.topic, type: m.b.type, priority: m.b.priority, minutes: blockDur(m.b) }, true);
      if (!blk) { toast('No room left on this day'); return; }
      const date = ttDate();
      setMissedHidden([m.key], true);
      toast(`Added ${m.b.topic}, ${blk.start}–${blk.end}`, () => { savePlan(date, (next) => { next.blocks = next.blocks.filter((x) => x.id !== blk.id); }); setMissedHidden([m.key], false); });
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
    'pause-reason': (el) => {
      const p = data.pauses.find((x) => x.id === el.dataset.id), v = el.dataset.v;
      if (p && v) { p.reason = v; touch(p); persist(true); }
      $$(`[data-action=pause-reason][data-id="${el.dataset.id}"]`).forEach((b) => b.classList.toggle('on', !!v && b.dataset.v === v));
      if (el.closest('#pask')) { hidePask(); if (v) toast('Noted'); }
    },
    'back-start': (el) => {
      const t = data.timer, m = +el.dataset.v; if (!t || !t.startedAt || t.backed || !m) return;
      t.accumulatedMs += m * 60000; t.startWall -= m * 60000; t.backed = true; data.timerUpdatedAt = Date.now(); persist(true); render();
      toast(`Counted ${m} minutes from before you pressed start`);
    },
    'switch-topic': () => {
      const t = data.timer; if (!t) return;
      const topics = live(data.topics).filter((x) => x.type === t.type);
      openModal('Switch topic', `
        <p class="note" style="margin-bottom:12px">Saves <b>${esc(t.topic || defaultLabel(t.type))}</b> (${short(Math.round(elapsedMs(t) / 1000))}) and starts the next one straight away, with no gap.</p>
        <div class="field"><label>Next topic</label><input type="text" id="sw-topic" list="sw-list" autocomplete="off" placeholder="Type a topic or pick one"><datalist id="sw-list">${topics.map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div>`, () => {
        const topic = ($('#sw-topic').value || '').trim(); if (!topic) { toast('Type the next topic'); return false; }
        const spec = { type: t.type, topic, priority: t.priority || 'medium', mode: 'stopwatch', minutes: 0 }, prev = t.topic || defaultLabel(t.type), secs = Math.round(elapsedMs(t) / 1000);
        stopTimer(true, { quiet: true }); startTimer(spec); toast(`Saved ${short(secs)} of ${prev}. Now on ${topic}`);
      }, 'Switch');
    },
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
    'bk-choose': async () => {
      try {
        const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'studytracker-backup' });
        await bkIdb('readwrite', (st) => st.put(h, 'dir'));
        BK.dir = h; BK.state = 'on'; BK.err = ''; BK.sig = '';
        const ok = await bkRun(true); toast(ok ? `Backup saved to “${h.name}”` : 'Could not write to that folder'); render();
      } catch (e) { if (!e || e.name !== 'AbortError') toast('Could not set up the backup folder'); }
    },
    'bk-allow': async () => {
      try { const p = await BK.dir.requestPermission({ mode: 'readwrite' }); if (p === 'granted') { BK.state = 'on'; BK.err = ''; await bkRun(true); toast('Automatic backup is on'); } else toast('Permission was not given'); } catch { toast('Could not ask for permission'); }
      render();
    },
    'bk-now': async () => { const ok = await bkRun(true); toast(ok ? 'Backup saved' : 'Backup failed'); render(); },
    'bk-stop': async () => { if (!confirm('Stop automatic backups? Files already in the folder stay there.')) return; try { await bkIdb('readwrite', (st) => st.delete('dir')); } catch { /* ignore */ } BK.dir = null; BK.state = 'off'; BK.last = 0; BK.files = 0; bkSaveMeta(); render(); },
    'sum-tab': (el) => { ui.sum = ui.sum || { tab: 'type', period: 'day' }; ui.sum.tab = el.dataset.v; render(); },
    'sum-period': (el) => { ui.sum = ui.sum || { tab: 'type', period: 'day' }; ui.sum.period = el.dataset.v; render(); },
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
      data = mergeData(data, inc); histRebase();
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
    'f-minutes': (el) => { ui.form.minutes = parseInt(el.value, 10) || 0; const s = $('#st-start-t'); if (s) s.textContent = startLabel(); },
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
      if (hit && kindOf(ui.form.type) !== 'break' && kindOf(ui.form.type) !== 'sleep') { ui.form.priority = hit.priority; syncStartCard(); }
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
    'rw-date': (el) => { if (el.value) { ui.rw.date = el.value > todayStr() ? todayStr() : el.value; render(); } },
    'rw-month': (el) => { if (el.value) { ui.rw.month = el.value; render(); } },
    'rw-from': (el) => { if (el.value) { ui.rw.from = el.value; render(); } },
    'rw-to': (el) => { if (el.value) { ui.rw.to = el.value; render(); } },
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
    'block-min': (el) => { data.settings.blockMin = Math.min(480, Math.max(5, parseInt(el.value, 10) || 60)); touch(data.settings); persist(true); toast('Updated'); },
    'pause-budget': (el) => { data.settings.pauseBudget = Math.min(60, Math.max(0, parseInt(el.value, 10) || 0)); touch(data.settings); persist(true); toast('Updated'); },
    'long-pause': (el) => { data.settings.longPause = Math.min(240, Math.max(0, parseInt(el.value, 10) || 0)); touch(data.settings); persist(true); toast('Updated'); },
    'lock-other': (el) => { data.settings.lockOther = !!el.checked; touch(data.settings); persist(true); render(); },
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.id === 'f-topic' && !e.isComposing) { e.preventDefault(); actions.start(); } });
  document.addEventListener('click', (e) => { if (e.target.closest('#mini')) { ui.page = 'today'; render(); } });
  document.addEventListener('input', (e) => { const f = binds[e.target.dataset && e.target.dataset.bind]; if (f) f(e.target); });
  document.addEventListener('change', (e) => { const f = changes[e.target.dataset && e.target.dataset.change]; if (f) f(e.target); });


  // =====================================================================
  //  AUTOMATIC FOLDER BACKUP (second safety net, separate from the Gist sync).
  //  Chrome / Edge on a computer: you pick a folder once and the app keeps one
  //  dated backup file per day in it (the last 30 days). Same file format as
  //  "Export backup", so "Import & merge" restores it.
  // =====================================================================
  const BK_KEEP = 30, BK_RE = /^study-tracker-backup-(\d{4}-\d{2}-\d{2})\.json$/;
  const BK = { dir: null, state: 'off', last: 0, files: 0, err: '', busy: false, sig: '', timer: null };
  const bkSupported = () => typeof window.showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';
  const bkIdb = (mode, fn) => new Promise((resolve, reject) => {
    const r = indexedDB.open('studytracker-backup', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => { const db = r.result, tx = db.transaction('kv', mode), q = fn(tx.objectStore('kv')); tx.oncomplete = () => { db.close(); resolve(q && q.result); }; tx.onerror = () => reject(tx.error); };
  });
  const bkMeta = () => { try { return JSON.parse(localStorage.getItem('st-bk-meta') || '{}'); } catch { return {}; } };
  const bkSaveMeta = () => { try { localStorage.setItem('st-bk-meta', JSON.stringify({ last: BK.last, files: BK.files })); } catch { /* ignore */ } };
  const bkStatusText = () => {
    if (!bkSupported()) return 'Needs Chrome or Edge on a computer.';
    if (BK.state === 'off') return 'Not set up.';
    const when = BK.last ? new Date(BK.last).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet';
    if (BK.err) return `Problem: ${BK.err}`;
    if (BK.state === 'needs') return `Paused. Click “Allow” so backups can continue. Last backup: ${when}.`;
    return `Saving to “${BK.dir && BK.dir.name}”. Last backup: ${when} · ${BK.files} ${BK.files === 1 ? 'file' : 'files'} kept.`;
  };
  const bkPaint = () => { const el = $('#bk-status'); if (el) el.textContent = bkStatusText(); };
  async function bkInit() {
    const m = bkMeta(); BK.last = m.last || 0; BK.files = m.files || 0;
    if (!bkSupported()) return;
    try {
      BK.dir = await bkIdb('readonly', (st) => st.get('dir')) || null;
      if (!BK.dir) { BK.state = 'off'; return; }
      const p = await BK.dir.queryPermission({ mode: 'readwrite' });
      BK.state = p === 'granted' ? 'on' : 'needs';
      if (BK.state === 'on') bkRun(true);
      else render();
    } catch (e) { BK.state = 'off'; }
    setInterval(() => bkRun(false), 15 * 60000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) bkRun(false); });
  }
  function bkSoon() { if (BK.state !== 'on') return; clearTimeout(BK.timer); BK.timer = setTimeout(() => bkRun(false), 60000); }
  async function bkRun(force) {
    if (BK.state !== 'on' || !BK.dir || BK.busy || !data) return false;
    BK.busy = true;
    try {
      const body = JSON.stringify(data, null, 2), sig = body.length + ':' + body.slice(0, 64) + body.slice(-64);
      if (!force && sig === BK.sig) return true;
      const name = `study-tracker-backup-${todayStr()}.json`;
      const fh = await BK.dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(body); await w.close();
      BK.sig = sig;
      const names = [];
      for await (const [n, h] of BK.dir.entries()) if (h.kind === 'file' && BK_RE.test(n)) names.push(n);
      names.sort().reverse();
      for (const old of names.slice(BK_KEEP)) { try { await BK.dir.removeEntry(old); } catch { /* ignore */ } }
      BK.files = Math.min(names.length, BK_KEEP); BK.last = Date.now(); BK.err = ''; bkSaveMeta();
      return true;
    } catch (e) {
      BK.err = (e && e.name === 'NotAllowedError') ? '' : String((e && e.message) || e).slice(0, 80);
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) BK.state = 'needs';
      return false;
    } finally { BK.busy = false; bkPaint(); }
  }
  function backupCard() {
    const ok = bkSupported(), st = BK.state;
    return `<div class="bk-card"><div class="lbl">Automatic backup to a folder</div>
      <p class="note" id="bk-status" style="margin:4px 0 10px">${esc(bkStatusText())}</p>
      ${!ok ? '<p class="note">On your phone, use <b>Export backup</b> above. Your data is also kept in the Gist sync.</p>'
        : `<div class="row">${st === 'off' ? '<button class="btn primary" data-action="bk-choose">Choose backup folder</button>'
          : st === 'needs' ? '<button class="btn primary" data-action="bk-allow">Allow</button><button class="btn" data-action="bk-choose">Change folder</button>'
          : '<button class="btn" data-action="bk-now">Back up now</button><button class="btn" data-action="bk-choose">Change folder</button>'}${st !== 'off' ? '<button class="btn danger" data-action="bk-stop">Stop</button>' : ''}</div>
        <p class="note" style="margin-top:8px">One file per day, the last ${BK_KEEP} days are kept. Pick a folder that OneDrive or Google Drive syncs to get a copy outside your computer. To restore, use <b>Import &amp; merge</b> and choose a file.</p>`}
    </div>`;
  }
  const bkBanner = () => BK.state === 'needs' ? `<div class="install bk-banner"><span>Automatic backup is paused until you allow it again.</span><button class="btn sm primary" data-action="bk-allow">Allow</button></div>` : '';

  // ---------- boot ----------
  (async function init() {
    data = normalize(await store.load());
    histRebase();
    // the clock may have ticked past midnight while the app was closed
    render();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
    setInterval(tick, 500);
    if (sync.token) runSync();
    bkInit();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
    // expose a small hook for automated tests
    window.__st = { get data() { return data; }, get hist() { return hist; }, persist, ui, render, computePoints, rewardState, rewardPrice, levelOf, subjectGroups, actualRaw, donutSlices, weekReview, parseQuickEntry, streak, dayStats, isRest, ting, weekStats, mergeData, todayStr, resolvePlan, blockActual, blockTimes, blockStatus, parseQuickLines, activePlanDate, ttDate, anchorMs };
  })();
})();

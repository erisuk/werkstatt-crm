// Steuert Mac-Apps über osascript (JavaScript for Automation).
// Eingaben gehen immer als Parameter an das Skript, nie in den Skripttext selbst.
// Eigenschaften werden gebündelt abgefragt (eine Anfrage pro Eigenschaft statt pro Eintrag),
// sonst wären große Kalender, Notizen oder Postfächer sehr langsam.
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const os = require('os');
const path = require('path');
const { occurrences } = require('./recurrence');

const OSASCRIPT = process.env.ZENTRALE_OSASCRIPT || '/usr/bin/osascript';
const MDFIND = process.env.ZENTRALE_MDFIND || '/usr/bin/mdfind';
const AVAILABLE = process.platform === 'darwin' || !!process.env.ZENTRALE_OSASCRIPT;

function friendlyError(stderr, app) {
  const s = String(stderr || '');
  const name = app || 'Die App';
  if (/\(-1743\)|not authori[sz]ed|not allowed to send/i.test(s)) {
    return `Die Zentrale darf ${app || 'diese App'} noch nicht steuern. Erlaube es unter Systemeinstellungen → Datenschutz & Sicherheit → Automation.`;
  }
  if (/\(-2700\)|can.t be found|kann nicht gefunden/i.test(s)) return `${name} ist auf diesem Mac nicht installiert.`;
  if (/\(-600\)|isn.t running/i.test(s)) return `${name} läuft gerade nicht.`;
  if (/\(-1728\)|can.t get/i.test(s)) return `${name} hat die Anfrage nicht verstanden.`;
  if (/\(-1712\)|timed out/i.test(s)) return `${name} hat nicht rechtzeitig geantwortet.`;
  return s.trim().split('\n').slice(-2).join(' ') || 'Unbekannter Fehler';
}

// Führt ein Skript aus. language: 'JavaScript' oder 'AppleScript'.
function runScript(script, args = [], { language = 'JavaScript', timeout = 60000, app = null } = {}) {
  return new Promise((resolve) => {
    if (!AVAILABLE) { resolve({ ok: false, error: 'Das geht nur auf dem Mac.' }); return; }
    const child = execFile(OSASCRIPT, ['-l', language, '-', ...args.map(String)], { timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: err.killed ? `${app || 'Die App'} hat nicht rechtzeitig geantwortet.` : friendlyError(stderr || err.message, app) });
        else resolve({ ok: true, out: String(stdout).trim() });
      });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

async function runJson(script, args, opts) {
  const res = await runScript(script, args, opts);
  if (!res.ok) return res;
  let data;
  try { data = JSON.parse(res.out || 'null'); } catch { return { ok: false, error: 'Unerwartete Antwort der App.' }; }
  if (data && data.error) return { ok: false, error: data.error };
  return { ok: true, data };
}

// argv[0] in jedem Skript: "1" = App darf gestartet werden, "0" = nur abfragen, wenn sie schon läuft.
const SCRIPTS = {
  calendar: `function run(argv) {
  var Cal = Application('Calendar');
  if (argv[0] !== '1' && !Cal.running()) return JSON.stringify({ notRunning: true });
  var start = new Date(Number(argv[1]));
  var end = new Date(Number(argv[2]));
  var cals = Cal.calendars;
  var names = cals.name();
  var events = [], series = [];
  for (var i = 0; i < names.length; i++) {
    try {
      var ev = cals[i].events.whose({ _and: [{ startDate: { _lessThan: end } }, { endDate: { _greaterThan: start } }] });
      var t = ev.summary(), s = ev.startDate(), e = ev.endDate(), a = ev.alldayEvent();
      for (var k = 0; k < t.length; k++) events.push({ title: t[k], start: s[k].toISOString(), end: e[k].toISOString(), allDay: a[k], calendar: names[i] });
    } catch (err) {}
    try {
      var rs = cals[i].events.whose({ _and: [{ startDate: { _lessThan: end } }, { recurrence: { _beginsWith: 'FREQ' } }] });
      var rt = rs.summary(), rst = rs.startDate(), ren = rs.endDate(), ra = rs.alldayEvent(), rr = rs.recurrence();
      var rx = [];
      try { rx = rs.excludedDates(); } catch (err) {}
      for (var j = 0; j < rt.length; j++) {
        series.push({ title: rt[j], start: rst[j].toISOString(), end: ren[j].toISOString(), allDay: ra[j], calendar: names[i], rule: rr[j],
          excluded: (rx[j] || []).map(function (d) { return d.toISOString(); }) });
      }
    } catch (err) {}
  }
  return JSON.stringify({ events: events, series: series });
}`,

  reminders: `function run(argv) {
  var R = Application('Reminders');
  if (argv[0] !== '1' && !R.running()) return JSON.stringify({ notRunning: true });
  var only = argv[1] || '';
  var names = R.lists.name();
  if (only && names.indexOf(only) < 0) return JSON.stringify({ error: 'Die Liste „' + only + '“ gibt es in Erinnerungen nicht.' });
  var out = [];
  for (var i = 0; i < names.length; i++) {
    if (only && names[i] !== only) continue;
    try {
      var rs = R.lists[i].reminders.whose({ completed: false });
      var t = rs.name(), d = rs.dueDate();
      for (var k = 0; k < t.length; k++) out.push({ title: t[k], list: names[i], due: d[k] ? d[k].toISOString() : null });
    } catch (e) {}
  }
  return JSON.stringify(out.slice(0, 200));
}`,

  addReminder: `function run(argv) {
  var R = Application('Reminders');
  var list = R.defaultList();
  if (argv[3]) {
    if (R.lists.name().indexOf(argv[3]) < 0) return JSON.stringify({ error: 'Die Liste „' + argv[3] + '“ gibt es in Erinnerungen nicht.' });
    list = R.lists.byName(argv[3]);
  }
  var props = { name: argv[1] };
  if (argv[2]) props.dueDate = new Date(Number(argv[2]));
  list.reminders.push(R.Reminder(props));
  return JSON.stringify({ ok: true });
}`,

  notesSearch: `function run(argv) {
  var N = Application('Notes');
  var q = argv[1] || '';
  var spec = q ? N.notes.whose({ _or: [{ name: { _contains: q } }, { plaintext: { _contains: q } }] }) : N.notes;
  var ids = spec.id().slice(0, 20);
  var out = [];
  ids.forEach(function (id) {
    var n = N.notes.byId(id);
    var body = '';
    try { body = n.plaintext(); } catch (e) {}
    var modified = null;
    try { modified = n.modificationDate().toISOString(); } catch (e) {}
    out.push({ title: n.name(), snippet: body.slice(0, 400), modified: modified });
  });
  return JSON.stringify(out);
}`,

  createNote: `function run(argv) {
  var N = Application('Notes');
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>'); };
  var body = '<div><h1>' + esc(argv[1]) + '</h1></div><div>' + esc(argv[2] || '') + '</div>';
  N.defaultAccount.defaultFolder().notes.push(N.Note({ body: body }));
  return JSON.stringify({ ok: true });
}`,

  mailUnread: `function run(argv) {
  var limit = parseInt(argv[1] || '10', 10);
  var M = Application('Mail');
  if (!M.running()) return JSON.stringify({ running: false });
  var count = M.inbox.unreadCount();
  var ms = M.inbox.messages.whose({ readStatus: false });
  var subj = count ? ms.subject() : [], from = count ? ms.sender() : [], date = count ? ms.dateReceived() : [];
  var list = subj.map(function (s, i) { return { subject: s, from: from[i], date: date[i] ? date[i].toISOString() : null }; });
  list.sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
  return JSON.stringify({ running: true, unread: count, messages: list.slice(0, limit) });
}`,

  outlookUnread: `function run(argv) {
  var limit = parseInt(argv[1] || '10', 10);
  var O = Application('Microsoft Outlook');
  if (!O.running()) return JSON.stringify({ running: false });
  var ms = O.inbox.messages.whose({ isRead: false });
  var subj = ms.subject();
  var from = [], date = [];
  try { from = ms.sender(); } catch (e) {}
  try { date = ms.timeReceived(); } catch (e) {}
  var list = subj.map(function (s, i) {
    var f = from[i] || {};
    return { subject: s, from: (f.name || '') + (f.address ? ' <' + f.address + '>' : ''), date: date[i] ? date[i].toISOString() : null };
  });
  list.sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
  return JSON.stringify({ running: true, unread: subj.length, messages: list.slice(0, limit) });
}`,
};

const toNumber = (x, fallback) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : fallback; };

// Termine im Zeitraum, inklusive Terminserien (die der Kalender per Skript nicht selbst auffächert).
async function calendarEvents(days = 1, { launch = true, now = new Date() } = {}) {
  const n = Math.min(Math.max(toNumber(days, 1), 1), 31);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  const res = await runJson(SCRIPTS.calendar, [launch ? '1' : '0', start.getTime(), end.getTime()], { app: 'Kalender' });
  if (!res.ok || res.data.notRunning) return res.ok ? { ok: true, data: null, notRunning: true } : res;
  return { ok: true, data: mergeEvents(res.data, start, end) };
}

function mergeEvents({ events = [], series = [] }, start, end) {
  const seen = new Set();
  const out = [];
  const add = (e) => {
    const key = `${e.calendar}|${e.title}|${new Date(e.start).getTime()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  events.forEach(add);
  for (const s of series) {
    for (const o of occurrences(s, s.rule, start, end, s.excluded || [])) {
      add({ title: s.title, start: o.start.toISOString(), end: o.end.toISOString(), allDay: s.allDay, calendar: s.calendar, recurring: true });
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}

async function reminders(list = '', { launch = true } = {}) {
  const res = await runJson(SCRIPTS.reminders, [launch ? '1' : '0', list || ''], { app: 'Erinnerungen' });
  if (res.ok && res.data && res.data.notRunning) return { ok: true, data: null, notRunning: true };
  return res;
}

// Ein reines Datum (2026-10-27) wird als 9 Uhr Ortszeit gelesen, nicht als Mitternacht UTC.
function parseDue(due) {
  if (!due) return null;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T09:00` : due;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function addReminder(title, due = '', list = '') {
  if (!title) return { ok: false, error: 'Titel fehlt.' };
  const d = parseDue(due);
  if (d === undefined) return { ok: false, error: 'Das Datum ist ungültig.' };
  return runJson(SCRIPTS.addReminder, ['1', title, d ? d.getTime() : '', list || ''], { app: 'Erinnerungen' });
}

async function searchNotes(query = '') {
  return runJson(SCRIPTS.notesSearch, ['1', query || ''], { app: 'Notizen' });
}

async function createNote(title, body = '') {
  if (!title) return { ok: false, error: 'Titel fehlt.' };
  return runJson(SCRIPTS.createNote, ['1', title, body || ''], { app: 'Notizen' });
}

async function mailUnread(limit = 10) {
  return runJson(SCRIPTS.mailUnread, ['0', toNumber(limit, 10)], { app: 'Mail' });
}

async function outlookUnread(limit = 10) {
  const res = await runJson(SCRIPTS.outlookUnread, ['0', toNumber(limit, 10)], { app: 'Outlook' });
  if (!res.ok && !/läuft gerade nicht|Automation|nicht installiert/.test(res.error)) {
    res.error = 'Outlook lässt sich so nicht lesen. Das „neue Outlook“ unterstützt keine Mac-Steuerung: '
      + 'nutze dafür Outlook im Browser über Chrome, oder stelle in Outlook auf „Legacy Outlook“ um.';
  }
  return res;
}

// Dateisuche mit Spotlight: höchstens 30 Treffer, danach wird die Suche beendet.
function spotlight(query, limit = 30) {
  return new Promise((resolve) => {
    if (!AVAILABLE) { resolve({ ok: false, error: 'Das geht nur auf dem Mac.' }); return; }
    const q = String(query || '').replace(/^-+/, '').trim();
    if (!q) { resolve({ ok: false, error: 'Suchbegriff fehlt.' }); return; }
    const found = [];
    let done = false;
    const proc = spawn(MDFIND, [q], { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); try { proc.kill(); } catch {} resolve(res); };
    const results = () => ({ ok: true, data: found.slice(0, limit) });
    const timer = setTimeout(() => finish(results()), 20000);
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (done || !line) return;
      found.push(line);
      if (found.length >= limit) finish(results());
    });
    proc.on('error', (e) => finish({ ok: false, error: e.message }));
    proc.on('close', () => finish(results()));
  });
}

function execText(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    if (!AVAILABLE) { resolve({ ok: false, error: 'Das geht nur auf dem Mac.' }); return; }
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).trim() } : { ok: true, out: String(stdout) });
    });
  });
}

// Was open() mit einem Ziel macht: Webadresse, Datei/Ordner oder App.
function openArgs(target) {
  let t = String(target || '').trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return [t];
  if (t === '~' || t.startsWith('~/')) t = path.join(os.homedir(), t.slice(1));
  if (t.startsWith('/')) return [t];
  if (t.includes('/')) return [path.join(os.homedir(), t)];
  return ['-a', t];
}

async function open(target) {
  const args = openArgs(target);
  if (!args) return { ok: false, error: 'Ziel fehlt.' };
  const res = await execText('/usr/bin/open', args);
  return res.ok ? { ok: true, data: { opened: args[args.length - 1] } } : res;
}

async function runUserScript(script, language = 'AppleScript') {
  if (!script) return { ok: false, error: 'Skript fehlt.' };
  const lang = /^javascript$/i.test(language) ? 'JavaScript' : 'AppleScript';
  const res = await runScript(script, [], { language: lang, timeout: 120000 });
  return res.ok ? { ok: true, data: res.out } : res;
}

// Alles für die "Heute"-Ansicht. launch: false fragt nur Apps ab, die schon laufen –
// so öffnet die regelmäßige Aktualisierung keine Programme ungefragt.
async function today({ launch = false } = {}) {
  const [events, todo, mail, outlook] = await Promise.all([
    calendarEvents(1, { launch }), reminders('', { launch }), mailUnread(5), outlookUnread(5)]);
  return { events, reminders: todo, mail, outlook };
}

module.exports = {
  AVAILABLE, SCRIPTS, runScript, friendlyError, mergeEvents, parseDue, openArgs,
  calendarEvents, reminders, addReminder, searchNotes, createNote, mailUnread, outlookUnread,
  spotlight, open, runUserScript, today,
};

// Steuert Mac-Apps über osascript (JavaScript for Automation).
// Eingaben gehen immer als Parameter an das Skript, nie in den Skripttext selbst.
const { execFile } = require('child_process');

const OSASCRIPT = process.env.ZENTRALE_OSASCRIPT || '/usr/bin/osascript';
const AVAILABLE = process.platform === 'darwin' || !!process.env.ZENTRALE_OSASCRIPT;

function friendlyError(stderr, app) {
  const s = String(stderr || '');
  if (/-1743|not authori[sz]ed/i.test(s)) {
    return `Die Zentrale darf ${app || 'diese App'} noch nicht steuern. Erlaube es unter Systemeinstellungen → Datenschutz & Sicherheit → Automation.`;
  }
  if (/-600|isn.t running|application isn.t running/i.test(s)) return `${app || 'Die App'} läuft gerade nicht.`;
  if (/-1728|can.t get/i.test(s)) return `${app || 'Die App'} hat die Anfrage nicht verstanden.`;
  if (/-1712|timed out/i.test(s)) return `${app || 'Die App'} hat nicht rechtzeitig geantwortet.`;
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
  try { return { ok: true, data: JSON.parse(res.out || 'null') }; } catch { return { ok: false, error: 'Unerwartete Antwort der App.' }; }
}

const SCRIPTS = {
  calendar: `function run(argv) {
  var days = parseInt(argv[0] || '1', 10);
  var start = new Date(); start.setHours(0, 0, 0, 0);
  var end = new Date(start.getTime() + days * 86400000);
  var Cal = Application('Calendar');
  var out = [];
  Cal.calendars().forEach(function (c) {
    try {
      c.events.whose({ _and: [{ startDate: { _greaterThanEquals: start } }, { startDate: { _lessThan: end } }] })().forEach(function (e) {
        out.push({ title: e.summary(), start: e.startDate().toISOString(), end: e.endDate().toISOString(), allDay: e.alldayEvent(), calendar: c.name() });
      });
    } catch (err) {}
  });
  out.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  return JSON.stringify(out);
}`,

  reminders: `function run(argv) {
  var R = Application('Reminders');
  var only = argv[0] || '';
  var out = [];
  R.lists().forEach(function (l) {
    if (only && l.name() !== only) return;
    try {
      l.reminders.whose({ completed: false })().forEach(function (r) {
        var due = null;
        try { var d = r.dueDate(); if (d) due = d.toISOString(); } catch (e) {}
        out.push({ title: r.name(), list: l.name(), due: due });
      });
    } catch (e) {}
  });
  return JSON.stringify(out.slice(0, 200));
}`,

  addReminder: `function run(argv) {
  var R = Application('Reminders');
  var list = argv[2] ? R.lists.byName(argv[2]) : R.defaultList();
  var props = { name: argv[0] };
  if (argv[1]) props.dueDate = new Date(argv[1]);
  list.reminders.push(R.Reminder(props));
  return JSON.stringify({ ok: true });
}`,

  notesSearch: `function run(argv) {
  var N = Application('Notes');
  var q = (argv[0] || '').toLowerCase();
  var out = [];
  N.notes().some(function (n) {
    var name = n.name();
    var body = '';
    try { body = n.plaintext(); } catch (e) {}
    if (!q || name.toLowerCase().indexOf(q) >= 0 || body.toLowerCase().indexOf(q) >= 0) {
      out.push({ title: name, snippet: body.slice(0, 400), modified: n.modificationDate().toISOString() });
    }
    return out.length >= 20;
  });
  return JSON.stringify(out);
}`,

  createNote: `function run(argv) {
  var N = Application('Notes');
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>'); };
  N.make({ new: 'note', withProperties: { body: '<h1>' + esc(argv[0]) + '</h1>' + esc(argv[1] || '') } });
  return JSON.stringify({ ok: true });
}`,

  mailUnread: `function run(argv) {
  var limit = parseInt(argv[0] || '10', 10);
  var M = Application('Mail');
  if (!M.running()) return JSON.stringify({ running: false });
  var msgs = M.inbox.messages.whose({ readStatus: false })();
  return JSON.stringify({ running: true, unread: msgs.length, messages: msgs.slice(0, limit).map(function (m) {
    return { from: m.sender(), subject: m.subject(), date: m.dateReceived().toISOString() };
  }) });
}`,

  outlookUnread: `function run(argv) {
  var limit = parseInt(argv[0] || '10', 10);
  var O = Application('Microsoft Outlook');
  if (!O.running()) return JSON.stringify({ running: false });
  var msgs = O.inbox.messages.whose({ isRead: false })();
  return JSON.stringify({ running: true, unread: msgs.length, messages: msgs.slice(0, limit).map(function (m) {
    var from = '';
    try { var s = m.sender(); from = (s.name || '') + (s.address ? ' <' + s.address + '>' : ''); } catch (e) {}
    var date = null;
    try { date = m.timeReceived().toISOString(); } catch (e) {}
    return { from: from, subject: m.subject(), date: date };
  }) });
}`,

  notify: `function run(argv) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayNotification(argv[1] || '', { withTitle: argv[0] || 'Zentrale' });
  return JSON.stringify({ ok: true });
}`,
};

async function calendarEvents(days = 1) {
  return runJson(SCRIPTS.calendar, [Math.min(Math.max(parseInt(days, 10) || 1, 1), 31)], { app: 'Kalender' });
}

async function reminders(list = '') {
  return runJson(SCRIPTS.reminders, [list || ''], { app: 'Erinnerungen' });
}

async function addReminder(title, due = '', list = '') {
  if (!title) return { ok: false, error: 'Titel fehlt.' };
  if (due && Number.isNaN(new Date(due).getTime())) return { ok: false, error: 'Das Datum ist ungültig.' };
  return runJson(SCRIPTS.addReminder, [title, due || '', list || ''], { app: 'Erinnerungen' });
}

async function searchNotes(query = '') {
  return runJson(SCRIPTS.notesSearch, [query || ''], { app: 'Notizen' });
}

async function createNote(title, body = '') {
  if (!title) return { ok: false, error: 'Titel fehlt.' };
  return runJson(SCRIPTS.createNote, [title, body || ''], { app: 'Notizen' });
}

async function mailUnread(limit = 10) {
  return runJson(SCRIPTS.mailUnread, [limit], { app: 'Mail' });
}

async function outlookUnread(limit = 10) {
  const res = await runJson(SCRIPTS.outlookUnread, [limit], { app: 'Outlook' });
  if (!res.ok && !/läuft gerade nicht|Automation/.test(res.error)) {
    res.error = 'Outlook lässt sich so nicht lesen. Das „neue Outlook“ unterstützt keine Mac-Steuerung: '
      + 'nutze dafür Outlook im Browser über Chrome, oder stelle in Outlook auf „Legacy Outlook“ um.';
  }
  return res;
}

async function notify(title, message) {
  return runJson(SCRIPTS.notify, [title || 'Zentrale', message || ''], { app: 'Mitteilungen', timeout: 15000 });
}

function execText(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    if (!AVAILABLE) { resolve({ ok: false, error: 'Das geht nur auf dem Mac.' }); return; }
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).trim() } : { ok: true, out: String(stdout) });
    });
  });
}

async function spotlight(query) {
  if (!query) return { ok: false, error: 'Suchbegriff fehlt.' };
  const res = await execText('/usr/bin/mdfind', [query]);
  if (!res.ok) return res;
  return { ok: true, data: res.out.split('\n').filter(Boolean).slice(0, 30) };
}

// Öffnet eine Webadresse, Datei oder App.
async function open(target) {
  if (!target) return { ok: false, error: 'Ziel fehlt.' };
  const isPath = target.startsWith('/') || target.startsWith('~');
  const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(target);
  const args = isPath || isUrl ? [target] : ['-a', target];
  const res = await execText('/usr/bin/open', args);
  return res.ok ? { ok: true, data: { opened: target } } : res;
}

async function runUserScript(script, language = 'AppleScript') {
  if (!script) return { ok: false, error: 'Skript fehlt.' };
  const lang = /^javascript$/i.test(language) ? 'JavaScript' : 'AppleScript';
  const res = await runScript(script, [], { language: lang, timeout: 120000 });
  return res.ok ? { ok: true, data: res.out } : res;
}

// Alles für die "Heute"-Ansicht auf einmal; Fehler einzelner Apps stören die anderen nicht.
async function today() {
  const [events, todo, mail, outlook] = await Promise.all([calendarEvents(1), reminders(), mailUnread(5), outlookUnread(5)]);
  return { events, reminders: todo, mail, outlook };
}

module.exports = {
  AVAILABLE, SCRIPTS, runScript, friendlyError,
  calendarEvents, reminders, addReminder, searchNotes, createNote, mailUnread, outlookUnread,
  notify, spotlight, open, runUserScript, today,
};

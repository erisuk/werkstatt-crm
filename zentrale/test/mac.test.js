// Tests für die Mac-Anbindung mit nachgebildetem osascript und mdfind.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'osa-'));
const LOG = path.join(DIR, 'osa.log');
process.env.ZENTRALE_OSASCRIPT = path.join(__dirname, 'fake-osascript.js');
process.env.FAKE_OSA_LOG = LOG;
// mdfind-Nachbildung: gibt endlos Pfade aus, damit das Abbrechen nach 30 Treffern geprüft wird.
const MDFIND = path.join(DIR, 'mdfind');
fs.writeFileSync(MDFIND, '#!/bin/sh\necho "ARGS:$*"\ni=0; while true; do i=$((i+1)); echo "/Users/test/Datei$i.txt"; done\n');
fs.chmodSync(MDFIND, 0o755);
process.env.ZENTRALE_MDFIND = MDFIND;

const test = require('node:test');
const assert = require('node:assert');
const mac = require('../src/mac');
const { occurrences, parseUntil, nthWeekday } = require('../src/recurrence');
const { TOOLS, READ_ONLY_TOOLS } = require('../src/mcp/mac-server');

const MONDAY = new Date(2026, 9, 26, 12, 0); // Montag, 26.10.2026

// ---------- Serientermine ----------

const day = (y, m, d) => new Date(y, m - 1, d);
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const starts = (list) => list.map((o) => `${o.start.getDate()}.${o.start.getMonth() + 1}. ${o.start.getHours()}:${String(o.start.getMinutes()).padStart(2, '0')}`);

test('wöchentliche Serie erscheint an den richtigen Tagen', () => {
  const master = { start: at(2026, 1, 5, 10), end: at(2026, 1, 5, 11) };
  assert.deepStrictEqual(starts(occurrences(master, 'FREQ=WEEKLY;BYDAY=MO', day(2026, 10, 26), day(2026, 10, 27))), ['26.10. 10:00']);
  assert.deepStrictEqual(occurrences(master, 'FREQ=WEEKLY;BYDAY=MO', day(2026, 10, 27), day(2026, 10, 28)), []);
  assert.deepStrictEqual(starts(occurrences(master, 'FREQ=WEEKLY;BYDAY=MO,WE', day(2026, 10, 26), day(2026, 11, 2))), ['26.10. 10:00', '28.10. 10:00']);
  assert.deepStrictEqual(occurrences(master, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', day(2026, 1, 12), day(2026, 1, 13)), []);
  assert.strictEqual(occurrences(master, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', day(2026, 1, 19), day(2026, 1, 20)).length, 1);
});

test('Serie über die Zeitumstellung behält die Uhrzeit', () => {
  const master = { start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 10) };
  assert.deepStrictEqual(starts(occurrences(master, 'FREQ=DAILY', day(2026, 3, 30), day(2026, 3, 31))), ['30.3. 9:00']);
});

test('tägliche, monatliche und jährliche Serien', () => {
  const m = { start: at(2026, 1, 31, 8), end: at(2026, 1, 31, 9) };
  assert.strictEqual(occurrences(m, 'FREQ=DAILY;INTERVAL=3', day(2026, 2, 3), day(2026, 2, 4)).length, 1);
  assert.strictEqual(occurrences(m, 'FREQ=DAILY;INTERVAL=3', day(2026, 2, 4), day(2026, 2, 5)).length, 0);
  // Am 31. gibt es im Februar keinen Termin
  assert.deepStrictEqual(starts(occurrences(m, 'FREQ=MONTHLY', day(2026, 2, 1), day(2026, 4, 1))), ['31.3. 8:00']);
  const second = { start: at(2026, 1, 13, 18), end: at(2026, 1, 13, 19) }; // 2. Dienstag
  assert.deepStrictEqual(starts(occurrences(second, 'FREQ=MONTHLY;BYDAY=2TU', day(2026, 10, 1), day(2026, 11, 1))), ['13.10. 18:00']);
  const last = { start: at(2026, 1, 30, 15), end: at(2026, 1, 30, 16) };
  assert.deepStrictEqual(starts(occurrences(last, 'FREQ=MONTHLY;BYDAY=-1FR', day(2026, 10, 1), day(2026, 11, 1))), ['30.10. 15:00']);
  const bday = { start: at(2020, 10, 26, 0), end: at(2020, 10, 27, 0) };
  assert.strictEqual(occurrences(bday, 'FREQ=YEARLY', day(2026, 10, 26), day(2026, 10, 27)).length, 1);
});

test('Ende, Anzahl und ausgenommene Tage werden beachtet', () => {
  const master = { start: at(2026, 10, 5, 10), end: at(2026, 10, 5, 11) };
  assert.strictEqual(occurrences(master, 'FREQ=WEEKLY;COUNT=3', day(2026, 10, 19), day(2026, 10, 20)).length, 1);
  assert.strictEqual(occurrences(master, 'FREQ=WEEKLY;COUNT=3', day(2026, 10, 26), day(2026, 10, 27)).length, 0);
  assert.strictEqual(occurrences(master, 'FREQ=WEEKLY;UNTIL=20261019', day(2026, 10, 26), day(2026, 10, 27)).length, 0);
  assert.strictEqual(occurrences(master, 'FREQ=WEEKLY;UNTIL=20261026T235959Z', day(2026, 10, 26), day(2026, 10, 27)).length, 1);
  assert.strictEqual(occurrences(master, 'FREQ=WEEKLY', day(2026, 10, 26), day(2026, 10, 27), [at(2026, 10, 26, 10).toISOString()]).length, 0);
});

test('mehrtägige Termine und unbekannte Regeln', () => {
  const trip = { start: at(2026, 10, 25, 18), end: at(2026, 10, 27, 12) };
  assert.strictEqual(occurrences(trip, 'FREQ=YEARLY', day(2026, 10, 26), day(2026, 10, 27)).length, 1);
  assert.deepStrictEqual(occurrences(trip, 'FREQ=SECONDLY', day(2026, 10, 26), day(2026, 10, 27)), []);
  assert.deepStrictEqual(occurrences({ start: 'kaputt', end: 'x' }, 'FREQ=DAILY', day(2026, 1, 1), day(2026, 1, 2)), []);
});

test('Hilfsfunktionen für Regeln', () => {
  assert.strictEqual(nthWeekday(2026, 9, 2, 2), 13);
  assert.strictEqual(nthWeekday(2026, 9, 5, -1), 30);
  assert.strictEqual(nthWeekday(2026, 1, 1, 5), null); // kein 5. Montag im Februar 2026
  assert.strictEqual(parseUntil('20261231').getHours(), 23);
  assert.strictEqual(parseUntil('quatsch'), null);
});

// ---------- Mac-Apps ----------

test('Kalender liefert Termine samt Serien für heute', async () => {
  const cal = await mac.calendarEvents(1, { now: MONDAY });
  assert.strictEqual(cal.ok, true);
  assert.deepStrictEqual(cal.data.map((e) => e.title), ['Zahnarzt', 'Teamrunde']);
  assert.strictEqual(cal.data[1].recurring, true);
});

test('geschlossene Apps werden bei der automatischen Aktualisierung nicht gestartet', async () => {
  process.env.FAKE_OSA_CLOSED = '1';
  try {
    const t = await mac.today({ launch: false });
    assert.strictEqual(t.events.notRunning, true);
    assert.strictEqual(t.reminders.notRunning, true);
    const forced = await mac.today({ launch: true });
    assert.strictEqual(forced.events.ok, true);
    assert.ok(Array.isArray(forced.events.data));
  } finally {
    delete process.env.FAKE_OSA_CLOSED;
  }
});

test('Erinnerungen lesen und unbekannte Liste melden', async () => {
  const rem = await mac.reminders();
  assert.deepStrictEqual(rem.data, [{ title: 'Milch kaufen', list: 'Einkauf', due: null }]);
  const missing = await mac.reminders('Gibtsnicht');
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /gibt es in Erinnerungen nicht/);
});

test('Eingaben gehen als Parameter, nie in den Skripttext', async () => {
  fs.writeFileSync(LOG, '');
  const evil = '"); Application("Finder").delete(); ("';
  const res = await mac.addReminder(evil, '2026-10-27T09:00', 'Einkauf');
  assert.strictEqual(res.ok, true);
  const params = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
  assert.deepStrictEqual(params, ['1', evil, String(new Date('2026-10-27T09:00').getTime()), 'Einkauf']);
  assert.ok(!mac.SCRIPTS.addReminder.includes('Finder'));
});

test('reines Datum wird 9 Uhr Ortszeit, ungültige Eingaben werden abgelehnt', async () => {
  const d = mac.parseDue('2026-10-27');
  assert.deepStrictEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 9, 27, 9]);
  assert.strictEqual(mac.parseDue(''), null);
  assert.strictEqual((await mac.addReminder('')).ok, false);
  assert.match((await mac.addReminder('x', 'kein datum')).error, /ungültig/);
  assert.strictEqual((await mac.createNote('')).ok, false);
});

test('Fehlercodes werden verständlich erklärt', async () => {
  process.env.FAKE_OSA_DENY = '1';
  try {
    const res = await mac.calendarEvents(1);
    assert.match(res.error, /Kalender noch nicht steuern.*Automation/);
  } finally {
    delete process.env.FAKE_OSA_DENY;
  }
  assert.match(mac.friendlyError("Application can't be found. (-2700)", 'Outlook'), /nicht installiert/);
  assert.match(mac.friendlyError('Fehler (-6000)', 'X'), /-6000/); // nicht mit -600 verwechseln
});

test('Outlook ohne Mac-Steuerung bekommt einen Hinweis auf den Browser-Weg', async () => {
  const res = await mac.outlookUnread(5);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /neue Outlook.*Chrome/);
});

test('open: Webadressen, Pfade mit ~ und Apps', () => {
  assert.deepStrictEqual(mac.openArgs('https://outlook.com'), ['https://outlook.com']);
  assert.deepStrictEqual(mac.openArgs('~/Dokumente/a.pdf'), [path.join(os.homedir(), 'Dokumente/a.pdf')]);
  assert.deepStrictEqual(mac.openArgs('Dokumente/a.pdf'), [path.join(os.homedir(), 'Dokumente/a.pdf')]);
  assert.deepStrictEqual(mac.openArgs('/Applications'), ['/Applications']);
  assert.deepStrictEqual(mac.openArgs('Microsoft Outlook'), ['-a', 'Microsoft Outlook']);
  assert.strictEqual(mac.openArgs('  '), null);
});

test('Spotlight hört nach 30 Treffern auf und ignoriert führende Striche', async () => {
  const res = await mac.spotlight('--live Rechnung');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.length, 30);
  assert.strictEqual(res.data[0], 'ARGS:live Rechnung');
  assert.strictEqual((await mac.spotlight('---')).ok, false);
});

// ---------- MCP-Server ----------

test('MCP-Server: Lese-Werkzeuge ohne Rückfrage, Aktionen mit Rückfrage', () => {
  assert.deepStrictEqual([...READ_ONLY_TOOLS].sort(), ['calendar_events', 'mail_unread', 'music_now_playing', 'notes_search', 'outlook_unread', 'reminders_list', 'spotlight_search']);
  for (const t of TOOLS) assert.ok(t.inputSchema && t.inputSchema.type === 'object', t.name);
});

test('MCP-Server spricht JSON-RPC über stdin/stdout', async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'mac-server.js')], { env: process.env });
  const replies = new Map();
  readline.createInterface({ input: proc.stdout }).on('line', (l) => { const m = JSON.parse(l); replies.set(m.id, m); });
  const send = (m) => proc.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'reminders_list', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gibtsnicht' } });
  send({ jsonrpc: '2.0', id: 5, method: 'gibtsnicht' });
  const end = Date.now() + 5000;
  while (replies.size < 5 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  proc.kill();
  assert.strictEqual(replies.get(1).result.serverInfo.name, 'zentrale-mac');
  assert.strictEqual(replies.get(2).result.tools.length, TOOLS.length);
  assert.match(replies.get(3).result.content[0].text, /Milch kaufen/);
  assert.strictEqual(replies.get(3).result.isError, false);
  assert.strictEqual(replies.get(4).error.code, -32602);
  assert.strictEqual(replies.get(5).error.code, -32601);
});

test('Jährliche Serien mit Monat und Wochentag (echte Feiertagsregeln)', () => {
  const { occurrences } = require('../src/recurrence');
  const at = (rule, startIso, year) => occurrences({ start: startIso, end: startIso }, rule,
    new Date(year, 0, 1), new Date(year + 1, 0, 1)).map((o) => `${o.start.getMonth() + 1}/${o.start.getDate()}`);
  // Muttertag: 2. Sonntag im Mai
  assert.deepStrictEqual(at('FREQ=YEARLY;INTERVAL=1;COUNT=6;BYMONTH=5;BYDAY=2SU', '2024-05-12T00:00:00', 2026), ['5/10']);
  // Ende der Sommerzeit: letzter Sonntag im Oktober – 2026 der 25., nicht der 27.
  assert.deepStrictEqual(at('FREQ=YEARLY;INTERVAL=1;COUNT=6;BYMONTH=10;BYDAY=-1SU', '2024-10-27T00:00:00', 2026), ['10/25']);
  // Erntedank: 1. Sonntag im Oktober
  assert.deepStrictEqual(at('FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', '2024-10-06T00:00:00', 2026), ['10/4']);
  // Ohne BYDAY bleibt es beim festen Datum
  assert.deepStrictEqual(at('FREQ=YEARLY;INTERVAL=1;COUNT=6', '2024-12-25T00:00:00', 2026), ['12/25']);
  // COUNT=6 ab 2024: 2030 gibt es nicht mehr
  assert.deepStrictEqual(at('FREQ=YEARLY;COUNT=6;BYMONTH=5;BYDAY=2SU', '2024-05-12T00:00:00', 2030), []);
  // Monatlich ohne Zahl: jeder Montag im Monat (Oktober 2026: 5., 12., 19., 26.)
  assert.deepStrictEqual(at('FREQ=MONTHLY;BYDAY=MO', '2026-10-05T09:00:00', 2026).filter((d) => d.startsWith('10/')), ['10/5', '10/12', '10/19', '10/26']);
});

test('Kalender: mit vollem Zugriff der schnelle Weg über EventKit, sortiert', async () => {
  process.env.FAKE_EK_ACCESS = '1';
  try {
    const cal = await mac.calendarEvents(1, { now: MONDAY });
    assert.strictEqual(cal.ok, true);
    assert.deepStrictEqual(cal.data.map((e) => e.title), ['Früh', 'Spät']);
    assert.deepStrictEqual(await mac.requestCalendarAccess(), { ok: true, granted: true, status: 3 });
  } finally {
    delete process.env.FAKE_EK_ACCESS;
  }
  assert.deepStrictEqual(await mac.requestCalendarAccess(), { ok: true, granted: false, status: 4 });
});

test('Musik: was läuft, Länge in Sekunden, Steuern nur mit gültigen Angaben', async () => {
  const music = require('../src/music');
  const now = await music.nowPlaying();
  assert.strictEqual(now.data.current.app, 'spotify');
  assert.strictEqual(now.data.current.playing, true);
  assert.strictEqual(Math.round(now.data.current.track.duration), 121); // Spotify liefert Millisekunden
  assert.strictEqual(now.data.apps.find((a) => a.app === 'music').running, false);
  assert.strictEqual((await music.control('spotify', 'next')).ok, true);
  assert.strictEqual((await music.control('winamp', 'next')).ok, false);
  assert.strictEqual((await music.control('spotify', 'rm -rf')).ok, false);
  assert.match((await music.control('music', 'next')).error, /nicht geöffnet/);
  process.env.FAKE_MUSIC_OFF = '1';
  try { assert.strictEqual((await music.nowPlaying()).data.current, null); } finally { delete process.env.FAKE_MUSIC_OFF; }
  assert.deepStrictEqual(music.normalize('music', { running: true, state: 'paused', track: { title: 'A', duration: 200 } }).track.duration, 200);
});

test('Musik-Werkzeuge: Abfragen ohne Rückfrage, Steuern mit Freigabe', () => {
  const { READ_ONLY_TOOLS } = require('../src/mcp/mac-server');
  const { describeApproval } = require('../src/claude');
  assert.ok(READ_ONLY_TOOLS.includes('music_now_playing'));
  assert.ok(!READ_ONLY_TOOLS.includes('music_control'));
  const a = describeApproval('mcp__mac__music_control', { app: 'spotify', action: 'next' });
  assert.strictEqual(a.title, 'Musik steuern');
  assert.strictEqual(a.detail, 'Spotify: Nächster Titel');
});

test('Serien: mehrere Monate sortiert, BYSETPOS, ganztägig über die Zeitumstellung', () => {
  const { occurrences } = require('../src/recurrence');
  const days = (rule, start, end, from, to) => occurrences({ start, end }, rule, from, to).map((o) => `${o.start.getMonth() + 1}/${o.start.getDate()}`);
  // Oktober und März, COUNT=3: Okt 2026, Mär 2027, Okt 2027 – in dieser Reihenfolge, nicht März 2026 zuerst
  assert.deepStrictEqual(days('FREQ=YEARLY;BYMONTH=10,3;COUNT=3', '2026-10-01T09:00:00', '2026-10-01T10:00:00', new Date(2026, 0, 1), new Date(2028, 0, 1)), ['10/1', '3/1', '10/1']);
  // Letzter Werktag im Monat
  assert.deepStrictEqual(days('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2026-10-30T09:00:00', '2026-10-30T10:00:00', new Date(2026, 9, 1), new Date(2027, 0, 1)), ['10/30', '11/30', '12/31']);
  // Ganztägiger Termin am Tag der Zeitumstellung (29.03.2026) endet am selben Tag um Mitternacht, nicht am 30. um 01:00
  const [o] = occurrences({ start: '2025-03-29T00:00:00', end: '2025-03-30T00:00:00' }, 'FREQ=YEARLY', new Date(2026, 2, 29), new Date(2026, 2, 30));
  assert.strictEqual(o.end.getDate(), 30);
  assert.strictEqual(o.end.getHours(), 0);
  assert.strictEqual(occurrences({ start: '2025-03-29T00:00:00', end: '2025-03-30T00:00:00' }, 'FREQ=YEARLY', new Date(2026, 2, 30), new Date(2026, 2, 31)).length, 0);
});

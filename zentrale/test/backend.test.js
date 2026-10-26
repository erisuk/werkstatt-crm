const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProjects, readMessages, isRealPrompt, shortTitle } = require('../src/sessions');
const { isDue, dayKey, TaskScheduler } = require('../src/tasks');
const { simplify, describeTool, describeApproval, approvalKey, parseMcpList, cleanEnv, ClaudeChat, runTask } = require('../src/claude');
const { Settings } = require('../src/settings');

const FAKE = path.join(__dirname, 'fake-claude.js');
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const root = tmp('zentrale-');
  const dir = path.join(root, '-Users-eris-werkstatt-crm');
  fs.mkdirSync(dir);
  const lines = [
    { type: 'queue-operation', content: 'x' },
    { type: 'user', cwd: '/Users/eris/werkstatt-crm', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', cwd: '/Users/eris/werkstatt-crm', message: { role: 'user', content: 'Baue mir ein CRM\nmit Details' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Mache ich.' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fertig.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'Subagent' } },
  ];
  fs.writeFileSync(path.join(dir, 'aaa.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"kaputt');
  const dir2 = path.join(root, '-Users-eris-world-desk');
  fs.mkdirSync(dir2);
  fs.writeFileSync(path.join(dir2, 'bbb.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'Mein Titel' }) + '\n'
    + JSON.stringify({ type: 'user', cwd: '/Users/eris/world-desk', message: { content: 'Hallo' } }) + '\n');
  fs.writeFileSync(path.join(dir2, 'notes.txt'), 'ignorieren');
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(dir2, 'bbb.jsonl'), old, old);
  return root;
}

// ---------- Sitzungen ----------

test('listProjects gruppiert nach Ordner und findet Titel', () => {
  const root = fixture();
  const projects = listProjects(root, new Map());
  assert.strictEqual(projects.length, 2);
  assert.strictEqual(projects[0].name, 'werkstatt-crm');
  assert.strictEqual(projects[0].path, '/Users/eris/werkstatt-crm');
  assert.strictEqual(projects[0].sessions[0].title, 'Baue mir ein CRM');
  assert.strictEqual(projects[1].sessions[0].title, 'Mein Titel');
});

test('listProjects ohne Ordner gibt leere Liste', () => {
  assert.deepStrictEqual(listProjects('/gibt/es/nicht', new Map()), []);
});

test('listProjects nutzt den Zwischenspeicher und vergisst gelöschte Dateien', () => {
  const root = fixture();
  const cache = new Map();
  listProjects(root, cache);
  assert.strictEqual(cache.size, 2);
  const file = path.join(root, '-Users-eris-world-desk', 'bbb.jsonl');
  cache.get(file).session.title = 'aus dem Speicher';
  assert.strictEqual(listProjects(root, cache)[1].sessions[0].title, 'aus dem Speicher');
  fs.rmSync(path.dirname(file), { recursive: true });
  assert.strictEqual(listProjects(root, cache).length, 1);
  assert.strictEqual(cache.size, 1);
});

test('readMessages liefert nur echte Nachrichten und fasst Antworten zusammen', () => {
  const root = fixture();
  const msgs = readMessages(path.join(root, '-Users-eris-werkstatt-crm', 'aaa.jsonl'));
  assert.deepStrictEqual(msgs, [
    { role: 'user', text: 'Baue mir ein CRM\nmit Details' },
    { role: 'assistant', text: 'Mache ich.\n\nFertig.' },
  ]);
});

test('shortTitle kürzt am Wort mit Auslassungszeichen', () => {
  assert.strictEqual(shortTitle('Kurz\nzweite Zeile'), 'Kurz');
  const long = 'also ich will eine Zentrale bauen in der ich dich bedienen kann aber in meinem eigenen stil';
  assert.strictEqual(shortTitle(long), 'also ich will eine Zentrale bauen in der ich dich bedienen kann aber in meinem …');
});

test('isRealPrompt filtert Befehle', () => {
  assert.strictEqual(isRealPrompt('<x>'), false);
  assert.strictEqual(isRealPrompt('  '), false);
  assert.strictEqual(isRealPrompt('Hallo'), true);
});

// ---------- Tägliche Aufgaben ----------

const newScheduler = (runner = async () => ({ ok: true, text: 'erledigt' })) =>
  new TaskScheduler(path.join(tmp('tasks-'), 'tasks.json'), runner);

test('isDue beachtet Uhrzeit, Schalter, letzten Lauf und übersprungene Tage', () => {
  const now = new Date(2026, 9, 26, 9, 0);
  assert.strictEqual(isDue({ enabled: true, time: '08:30' }, now), true);
  assert.strictEqual(isDue({ enabled: true, time: '09:30' }, now), false);
  assert.strictEqual(isDue({ enabled: false, time: '08:30' }, now), false);
  assert.strictEqual(isDue({ enabled: true, time: '08:30', lastRunDay: dayKey(now) }, now), false);
  assert.strictEqual(isDue({ enabled: true, time: '08:30', skipDay: dayKey(now) }, now), false);
  assert.strictEqual(isDue({ enabled: true, time: 'quatsch' }, now), false);
});

test('TaskScheduler speichert, führt aus und merkt sich das Ergebnis', async () => {
  const calls = [];
  const s = newScheduler(async (t) => { calls.push(t.name); return { ok: true, text: 'erledigt' }; });
  s.upsert({ name: 'News', time: '07:00', prompt: 'Neuigkeiten' }, new Date(2026, 9, 26, 6, 0));
  const id = s.list()[0].id;
  await s.run(id, { now: new Date(2026, 9, 26, 8, 0), scheduled: true });
  assert.deepStrictEqual(calls, ['News']);
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'))[0];
  assert.strictEqual(saved.lastStatus, 'ok');
  assert.strictEqual(saved.lastRunDay, '2026-10-26');
  assert.strictEqual(saved.runningSince, undefined);
  s.toggle(id);
  assert.strictEqual(s.list()[0].enabled, false);
  s.remove(id);
  assert.strictEqual(s.list().length, 0);
});

test('neue Aufgabe mit schon vergangener Uhrzeit läuft erst morgen', () => {
  const s = newScheduler();
  const noon = new Date(2026, 9, 26, 12, 0);
  s.upsert({ name: 'Früh', time: '08:00', prompt: 'x' }, noon);
  s.upsert({ name: 'Spät', time: '18:00', prompt: 'x' }, noon);
  const [early, late] = s.list();
  assert.strictEqual(isDue(early, noon), false);
  assert.strictEqual(isDue(early, new Date(2026, 9, 27, 8, 1)), true);
  assert.strictEqual(isDue(late, new Date(2026, 9, 26, 18, 1)), true);
  s.toggle(late.id, noon);
  s.toggle(late.id, new Date(2026, 9, 26, 19, 0));
  assert.strictEqual(isDue(s.list()[1], new Date(2026, 9, 26, 19, 1)), false);
});

test('Uhrzeit später stellen hebt das Überspringen wieder auf', () => {
  const s = newScheduler();
  const noon = new Date(2026, 9, 26, 12, 0);
  s.upsert({ name: 'A', time: '08:00', prompt: 'x' }, noon);
  const id = s.list()[0].id;
  s.upsert({ id, name: 'A', time: '18:00', prompt: 'x' }, noon);
  assert.strictEqual(isDue(s.list()[0], new Date(2026, 9, 26, 18, 1)), true);
});

test('"Jetzt ausführen" verbraucht den geplanten Lauf nicht', async () => {
  const s = newScheduler();
  s.upsert({ name: 'A', time: '08:00', prompt: 'x' }, new Date(2026, 9, 26, 6, 0));
  const id = s.list()[0].id;
  await s.run(id, { now: new Date(2026, 9, 26, 7, 0) });
  assert.strictEqual(isDue(s.list()[0], new Date(2026, 9, 26, 8, 1)), true);
});

test('ein Fehler im Ablauf hinterlässt keine hängende Aufgabe', async () => {
  const s = newScheduler(async () => { throw new Error('kaputt'); });
  s.upsert({ name: 'A', time: '08:00', prompt: 'x' });
  const id = s.list()[0].id;
  await s.run(id);
  const t = s.list()[0];
  assert.strictEqual(t.running, false);
  assert.strictEqual(t.lastStatus, 'error');
  assert.strictEqual(t.lastText, 'kaputt');
});

test('kaputte Aufgaben-Datei wird gesichert statt überschrieben', () => {
  const dir = tmp('tasks-');
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, '[{"id":"a", "name":');
  const s = new TaskScheduler(file, async () => ({ ok: true }));
  assert.deepStrictEqual(s.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('tasks.json.kaputt-')));
  fs.writeFileSync(file, '{}');
  assert.deepStrictEqual(new TaskScheduler(file, async () => ({ ok: true })).list(), []);
});

test('beim Beenden unterbrochene Aufgabe wird als Fehler angezeigt', () => {
  const file = path.join(tmp('tasks-'), 'tasks.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', time: '08:00', enabled: true, runningSince: 123 }]));
  const t = new TaskScheduler(file, async () => ({ ok: true })).list()[0];
  assert.strictEqual(t.lastStatus, 'error');
  assert.strictEqual(t.runningSince, undefined);
  assert.match(t.lastText, /Unterbrochen/);
});

// ---------- Claude-Anbindung ----------

test('simplify übersetzt stream-json Ereignisse', () => {
  assert.deepStrictEqual(simplify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }),
    [{ kind: 'init', sessionId: 's1', model: 'm' }]);
  assert.deepStrictEqual(simplify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la\nzweite' } }] } }),
  [{ kind: 'text', text: 'Hi' }, { kind: 'tool', text: 'Bash · ls -la' }]);
  assert.deepStrictEqual(simplify({ type: 'result', is_error: true, result: 'kaputt' }),
    [{ kind: 'error', text: 'Claude hat einen Fehler gemeldet.', details: 'kaputt' }]);
  assert.deepStrictEqual(simplify({ type: 'result', is_error: false }), []);
  assert.deepStrictEqual(simplify({ type: 'user' }), []);
  assert.strictEqual(describeTool('Read', {}), 'Read');
});

test('cleanEnv entfernt Variablen einer umgebenden Claude-Sitzung', () => {
  const env = cleanEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.deepStrictEqual(env, { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1' });
});

function collect(chat) {
  const events = [];
  chat.on('event', (e) => events.push(e));
  return events;
}

test('Chat: neue Sitzung hat sofort eine ID und antwortet', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: process.env, cwd: os.tmpdir() });
  const id = chat.sessionId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const events = collect(chat);
  assert.strictEqual(await chat.send('hallo'), true);
  assert.strictEqual(chat.status, 'busy');
  await wait(400);
  assert.strictEqual(chat.status, 'ready');
  assert.ok(events.some((e) => e.kind === 'text' && e.text.endsWith(':hallo')));
  assert.strictEqual(chat.sessionId, id);
  await chat.stop();
  assert.strictEqual(chat.status, 'stopped');
});

test('Chat: nach Stoppen kommt keine alte Antwort mehr an', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_DELAY: '600' }, cwd: os.tmpdir() });
  const events = collect(chat);
  await chat.send('erste');
  const firstPid = chat.proc.pid;
  await wait(100);
  await chat.stop({ interrupt: true });
  await chat.send('zweite');
  await wait(1200);
  const texts = events.filter((e) => e.kind === 'text').map((e) => e.text);
  assert.deepStrictEqual(texts.filter((t) => t.includes(`:${firstPid}:`)), []);
  assert.ok(texts.some((t) => t.endsWith(':zweite')));
  assert.strictEqual(chat.status, 'ready');
  await chat.stop();
});

test('Chat: fehlendes Programm meldet Fehler statt ewig zu arbeiten', async () => {
  const chat = new ClaudeChat({ bin: '/gibt/es/nicht/claude', env: process.env, cwd: os.tmpdir() });
  const events = collect(chat);
  await chat.send('hallo');
  await wait(300);
  assert.strictEqual(chat.status, 'error');
  assert.ok(events.some((e) => e.kind === 'error'));
});

test('Chat: abgestürzter Prozess wird verständlich gemeldet und Senden stürzt nicht ab', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_FAIL: '1' }, cwd: os.tmpdir(), resume: 'abc' });
  const events = collect(chat);
  chat.start();
  await wait(400);
  assert.strictEqual(chat.status, 'error');
  assert.strictEqual(events[0].text, 'Dieses Gespräch konnte nicht fortgesetzt werden.');
  await chat.send('noch mal');
  await wait(400);
  assert.strictEqual(chat.status, 'error');
});

test('Chat: bleibt "arbeitet", bis alle Nachrichten beantwortet sind', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_DELAY: '500' }, cwd: os.tmpdir() });
  await chat.send('eins');
  await wait(200);
  await chat.send('zwei');
  await wait(400); // erste Antwort ist da, zweite noch nicht
  assert.strictEqual(chat.status, 'busy');
  await wait(500);
  assert.strictEqual(chat.status, 'ready');
  await chat.stop();
});

test('Chat: ersetzter Chat startet nie wieder', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: process.env, cwd: os.tmpdir() });
  chat.start();
  const disposing = chat.dispose();
  const sent = chat.send('geheim');
  await disposing;
  assert.strictEqual(await sent, false);
  assert.strictEqual(chat.proc, null);
});

test('Chat: ungespeicherte Sitzung wird neu angelegt statt fortgesetzt', async () => {
  const log = path.join(tmp('args-'), 'args.log');
  const root = tmp('projects-');
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_ARGS_LOG: log, FAKE_DELAY: '2000' }, cwd: os.tmpdir(), projectsRoot: root });
  const runs = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  try {
    await chat.send('erste');
    await wait(300);
    await chat.stop({ interrupt: true }); // gestoppt, bevor Claude Code etwas gespeichert hat
    await chat.send('zweite');
    await wait(300);
    assert.deepStrictEqual(runs().map((a) => a.includes('--session-id')), [true, true]);
    // Sobald Claude Code die Sitzung gespeichert hat, wird fortgesetzt.
    fs.mkdirSync(path.join(root, 'p'));
    fs.writeFileSync(path.join(root, 'p', `${chat.sessionId}.jsonl`), '');
    await chat.stop();
    await chat.send('dritte');
    await wait(300);
    assert.ok(runs()[2].includes('--resume'));
  } finally {
    await chat.stop();
  }
});


// ---------- Freigaben ----------

test('describeApproval beschreibt Aktionen in einfachen Worten', () => {
  assert.deepStrictEqual(describeApproval('Bash', { command: 'rm -rf x' }), { title: 'Einen Befehl im Terminal ausführen', detail: 'rm -rf x' });
  assert.strictEqual(describeApproval('mcp__mac__reminders_add', { title: 'Milch', due: '2026-10-27' }).detail, 'Milch · fällig 2026-10-27');
  const mail = describeApproval('mcp__claude_ai_Gmail__send_message', { to: ['a@b.de'], subject: 'Hallo', body: 'Text' });
  assert.strictEqual(mail.title, 'Eine E-Mail senden');
  assert.strictEqual(mail.detail, 'An: a@b.de\nBetreff: Hallo\n\nText');
  assert.strictEqual(describeApproval('mcp__x__thing', { a: 1 }, null).title, 'Werkzeug „x · thing“ benutzen');
  assert.ok(describeApproval('Bash', { command: 'x'.repeat(5000) }).detail.length < 2100);
});

test('approvalKey: "immer erlauben" gilt bei Befehlen nur für genau diesen Befehl', () => {
  assert.notStrictEqual(approvalKey('Bash', { command: 'ls' }), approvalKey('Bash', { command: 'rm -rf /' }));
  assert.strictEqual(approvalKey('mcp__mac__open', { target: 'a' }), approvalKey('mcp__mac__open', { target: 'b' }));
});

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(20); }
  return false;
}

test('Chat: Freigabe erlauben, ablehnen und "immer erlauben"', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: process.env, cwd: os.tmpdir() });
  const events = collect(chat);
  const texts = () => events.filter((e) => e.kind === 'text').map((e) => e.text);
  try {
    await chat.send('FREIGABE:ls');
    assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
    const a = chat.pendingApprovals()[0];
    assert.strictEqual(a.title, 'Einen Befehl im Terminal ausführen');
    assert.strictEqual(a.detail, 'ls');
    assert.strictEqual(chat.status, 'busy');
    assert.strictEqual(chat.respond(a.id, 'allow'), true);
    assert.strictEqual(chat.respond(a.id, 'allow'), false); // nur einmal
    assert.ok(await waitFor(() => texts().includes('erlaubt:ls')));

    await chat.send('FREIGABE:rm x');
    assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
    chat.respond(chat.pendingApprovals()[0].id, 'deny');
    assert.ok(await waitFor(() => texts().includes('abgelehnt')));

    await chat.send('FREIGABE:date');
    assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
    chat.respond(chat.pendingApprovals()[0].id, 'always');
    assert.ok(await waitFor(() => texts().filter((t) => t === 'erlaubt:date').length === 1));
    await chat.send('FREIGABE:date');
    assert.ok(await waitFor(() => texts().filter((t) => t === 'erlaubt:date').length === 2));
    assert.strictEqual(chat.pendingApprovals().length, 0);
  } finally {
    await chat.stop();
  }
});

test('Chat: offene Freigaben verschwinden beim Stoppen', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: process.env, cwd: os.tmpdir() });
  let changes = 0;
  chat.on('approvals', () => { changes += 1; });
  await chat.send('FREIGABE:ls');
  assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
  await chat.stop();
  assert.strictEqual(chat.pendingApprovals().length, 0);
  assert.strictEqual(changes, 2);
});

test('Chat: zusätzliche Startoptionen werden beim (Neu-)Start gelesen', async () => {
  const log = path.join(tmp('args-'), 'args.log');
  let extra = ['--chrome'];
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_ARGS_LOG: log }, cwd: os.tmpdir(), extraArgs: () => extra });
  chat.start();
  await wait(300);
  await chat.stop();
  extra = ['--mcp-config=/x.json'];
  chat.start();
  await wait(300);
  await chat.stop();
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(runs[0].includes('--chrome') && runs[0].includes('--permission-prompt-tool'));
  assert.ok(runs[1].includes('--mcp-config=/x.json') && !runs[1].includes('--chrome'));
});

// ---------- Tägliche Aufgaben über Claude ----------

test('runTask liefert die letzte Antwort', async () => {
  const res = await runTask({ bin: FAKE, env: process.env, cwd: os.tmpdir(), prompt: '- Fasse zusammen' });
  assert.strictEqual(res.ok, true);
  assert.match(res.text, /:- Fasse zusammen$/);
});

test('runTask meldet Freigaben und läuft danach weiter', async () => {
  let asked = 0;
  const res = await runTask({ bin: FAKE, env: process.env, cwd: os.tmpdir(), prompt: 'FREIGABE:ls',
    onApproval: (chat) => { for (const a of chat.pendingApprovals()) { asked += 1; chat.respond(a.id, 'allow'); } } });
  assert.strictEqual(asked, 1);
  assert.deepStrictEqual(res, { ok: true, text: 'erlaubt:ls' });
});

test('runTask: zu lange Aufgabe wird abgebrochen', async () => {
  const res = await runTask({ bin: FAKE, env: { ...process.env, FAKE_DELAY: '5000' }, cwd: os.tmpdir(), prompt: 'x', timeoutMs: 300 });
  assert.strictEqual(res.ok, false);
  assert.match(res.text, /30 Minuten/);
});

test('runTask: fehlendes Programm', async () => {
  const res = await runTask({ bin: '/gibt/es/nicht', env: process.env, cwd: os.tmpdir(), prompt: 'x' });
  assert.strictEqual(res.ok, false);
});

// ---------- Verbindungen und Einstellungen ----------

test('parseMcpList erkennt Namen und Status', () => {
  const list = parseMcpList('Checking MCP server health…\n\n'
    + 'claude.ai Gmail: https://g/mcp (HTTP) - ✓ Connected\n'
    + 'plugin:marketing:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication\n'
    + 'plugin:marketing:hubspot: https://h (HTTP) - × Failed to connect — Incompatible auth server\n'
    + 'plugin:marketing:gmail:  (HTTP) - - Not configured\n'
    + 'mac: /usr/bin/node /x/mac-server.js - ✓ Connected\n');
  assert.deepStrictEqual(list.map((c) => [c.name, c.status]), [
    ['claude.ai Gmail', 'connected'], ['plugin:marketing:slack', 'auth'], ['plugin:marketing:hubspot', 'failed'],
    ['plugin:marketing:gmail', 'off'], ['mac', 'connected']]);
  assert.strictEqual(list[1].statusText, 'Needs authentication');
});

test('Settings speichert nur gültige Werte', () => {
  const file = path.join(tmp('settings-'), 'settings.json');
  const s = new Settings(file);
  assert.deepStrictEqual(s.get(), { theme: 'system', connections: { mac: false, chrome: false } });
  s.update({ theme: 'dark', connections: { mac: true, boese: true } });
  s.update({ theme: 'lila', connections: { chrome: 'ja' } });
  assert.deepStrictEqual(new Settings(file).get(), { theme: 'dark', connections: { mac: true, chrome: false } });
  fs.writeFileSync(file, 'kaputt');
  assert.strictEqual(new Settings(file).get().theme, 'system');
});

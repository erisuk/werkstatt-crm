const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProjects, readMessages, isRealPrompt } = require('../src/sessions');
const { isDue, dayKey, TaskScheduler } = require('../src/tasks');
const { simplify, describeTool } = require('../src/claude');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-'));
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

test('listProjects gruppiert nach Ordner und findet Titel', () => {
  const root = fixture();
  const projects = listProjects(root);
  assert.strictEqual(projects.length, 2);
  assert.strictEqual(projects[0].name, 'werkstatt-crm');
  assert.strictEqual(projects[0].path, '/Users/eris/werkstatt-crm');
  assert.strictEqual(projects[0].sessions[0].title, 'Baue mir ein CRM');
  assert.strictEqual(projects[1].sessions[0].title, 'Mein Titel');
});

test('listProjects ohne Ordner gibt leere Liste', () => {
  assert.deepStrictEqual(listProjects('/gibt/es/nicht'), []);
});

test('readMessages liefert nur echte Nachrichten und fasst Antworten zusammen', () => {
  const root = fixture();
  const msgs = readMessages(path.join(root, '-Users-eris-werkstatt-crm', 'aaa.jsonl'));
  assert.deepStrictEqual(msgs, [
    { role: 'user', text: 'Baue mir ein CRM\nmit Details' },
    { role: 'assistant', text: 'Mache ich.\n\nFertig.' },
  ]);
});

test('isRealPrompt filtert Befehle', () => {
  assert.strictEqual(isRealPrompt('<x>'), false);
  assert.strictEqual(isRealPrompt('  '), false);
  assert.strictEqual(isRealPrompt('Hallo'), true);
});

test('isDue beachtet Uhrzeit, Schalter und letzten Lauf', () => {
  const now = new Date(2026, 9, 26, 9, 0);
  assert.strictEqual(isDue({ enabled: true, time: '08:30' }, now), true);
  assert.strictEqual(isDue({ enabled: true, time: '09:30' }, now), false);
  assert.strictEqual(isDue({ enabled: false, time: '08:30' }, now), false);
  assert.strictEqual(isDue({ enabled: true, time: '08:30', lastRunDay: dayKey(now) }, now), false);
  assert.strictEqual(isDue({ enabled: true, time: 'quatsch' }, now), false);
});

test('TaskScheduler speichert, führt aus und merkt sich das Ergebnis', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'tasks.json');
  const calls = [];
  const s = new TaskScheduler(file, async (t) => { calls.push(t.name); return { ok: true, text: 'erledigt' }; });
  s.upsert({ name: 'News', time: '07:00', prompt: 'Neuigkeiten' });
  const id = s.list()[0].id;
  await s.run(id, new Date(2026, 9, 26, 8, 0));
  assert.deepStrictEqual(calls, ['News']);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  assert.strictEqual(saved.lastStatus, 'ok');
  assert.strictEqual(saved.lastRunDay, '2026-10-26');
  s.toggle(id);
  assert.strictEqual(s.list()[0].enabled, false);
  s.remove(id);
  assert.strictEqual(s.list().length, 0);
});

test('neue Aufgabe mit schon vergangener Uhrzeit läuft erst morgen', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'tasks.json');
  const s = new TaskScheduler(file, async () => ({ ok: true }));
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
  s.upsert({ id: early.id, name: 'Früh', time: '08:00', prompt: 'neu' }, noon);
  assert.strictEqual(s.list()[0].prompt, 'neu');
});

test('simplify übersetzt stream-json Ereignisse', () => {
  assert.deepStrictEqual(simplify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }),
    [{ kind: 'init', sessionId: 's1', model: 'm' }]);
  assert.deepStrictEqual(simplify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la\nzweite' } }] } }),
  [{ kind: 'text', text: 'Hi' }, { kind: 'tool', text: 'Bash · ls -la' }]);
  assert.strictEqual(simplify({ type: 'result', is_error: true, result: 'kaputt' })[0].text, 'kaputt');
  assert.deepStrictEqual(simplify({ type: 'user' }), []);
  assert.strictEqual(describeTool('Read', {}), 'Read');
});

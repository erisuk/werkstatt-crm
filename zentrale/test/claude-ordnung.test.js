// Ordnung wie in der Claude-App: angeheftet und Gruppen aus deren Einstellungen (nur lesen), Einmal-Läufe erkennen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { desktopSidebar } = require('../src/desktop-meta');
const { parseSession } = require('../src/sessions');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordnung-'));

test('Claude-App: angeheftet und eigene Gruppen mit Mitgliedern, ausgeblendete Gruppen nicht', () => {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ preferences: { epitaxyPrefs: {
    'starred-local-code-sessions': ['local_a'],
    'dframe-code-sections': { 'x/y': { sections: [
      { id: 'pinned', kind: 'pinned', order: 0 },
      { id: 'cg-2', kind: 'manual', name: 'Zweite', order: 3, shown: true, members: ['local_c'] },
      { id: 'cg-1', kind: 'manual', name: 'Konzepte', order: 2, shown: true, members: ['local_b', 5] },
      { id: 'cg-3', kind: 'manual', name: 'Aus', order: 4, shown: false, members: [] },
      { id: 'sessions', kind: 'sessions', order: 5 }] } } } } }));
  assert.deepStrictEqual(desktopSidebar(file), { pinned: ['local_a'], groups: [
    { id: 'cg-1', name: 'Konzepte', members: ['local_b'] }, { id: 'cg-2', name: 'Zweite', members: ['local_c'] }] });
  assert.deepStrictEqual(desktopSidebar(path.join(dir, 'fehlt.json')), { pinned: [], groups: [] });
  fs.writeFileSync(path.join(dir, 'kaputt.json'), '{kaputt');
  assert.deepStrictEqual(desktopSidebar(path.join(dir, 'kaputt.json')), { pinned: [], groups: [] });
});

test('Gespräche: Herkunft und Zahl der echten Eingaben (automatische Läufe haben genau eine)', () => {
  const line = (o) => JSON.stringify(o);
  const auto = path.join(dir, 'auto.jsonl');
  fs.writeFileSync(auto, [line({ type: 'user', entrypoint: 'sdk-cli', cwd: '/x', message: { role: 'user', content: 'Erstelle das Tagesvideo' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })].join('\n'));
  const chat = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(chat, [line({ type: 'user', entrypoint: 'sdk-cli', cwd: '/x', message: { role: 'user', content: 'Hallo' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } }),
    line({ type: 'user', message: { role: 'user', content: 'Und weiter' } })].join('\n'));
  assert.deepStrictEqual([parseSession(auto).entrypoint, parseSession(auto).prompts], ['sdk-cli', 1]);
  assert.strictEqual(parseSession(chat).prompts, 2);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

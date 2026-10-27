// Tests für das Gehirn (Obsidian-Vault) mit einem Test-Vault.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findVaults, listNotes, search, readNote, addNote, obsidianUrl } = require('../src/vault');

function fakeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-vault-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('Projekte/Zentrale.md', '# Zentrale\nKommandozentrale für Claude Code mit n8n und Web-Tabs.');
  w('Wissen/Godot.md', '# Godot\nSpiele-Engine.');
  w('.obsidian/workspace.md', 'intern');
  w('Bild.png', 'x');
  return root;
}

test('Vaults aus der Obsidian-Einstellung, der geöffnete zuerst', () => {
  const a = fakeVault(); const b = fakeVault();
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-')), 'obsidian.json');
  fs.writeFileSync(cfg, JSON.stringify({ vaults: { x: { path: a, ts: 1 }, y: { path: b, ts: 2, open: true }, z: { path: '/gibt/es/nicht' } } }));
  assert.deepStrictEqual(findVaults(cfg).map((v) => v.path), [b, a]);
  assert.deepStrictEqual(findVaults('/fehlt.json'), []);
});

test('Notizen auflisten (ohne .obsidian und ohne Bilder) und durchsuchen', () => {
  const v = fakeVault();
  assert.deepStrictEqual(listNotes(v).data.map((n) => n.rel).sort(), ['Projekte/Zentrale.md', 'Wissen/Godot.md']);
  const hits = search(v, 'n8n').data;
  assert.strictEqual(hits.length, 1);
  assert.match(hits[0].snippet, /n8n und Web-Tabs/);
  assert.strictEqual(search(v, 'godot').data[0].title, 'Godot'); // Treffer im Titel
  assert.strictEqual(search(v, 'gibtsnicht').data.length, 0);
});

test('Lesen nur im Vault: kein Weg hinaus, auch nicht über Verknüpfungen', () => {
  const v = fakeVault();
  assert.match(readNote(v, 'Projekte/Zentrale.md').data.text, /Kommandozentrale/);
  for (const bad of ['../../etc/passwd', '/etc/hosts', 'Projekte/../../x.md', '', null]) assert.strictEqual(readNote(v, bad).ok, false, String(bad));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'draussen-'));
  fs.writeFileSync(path.join(outside, 'geheim.md'), 'geheim');
  fs.symlinkSync(outside, path.join(v, 'Link'));
  assert.strictEqual(readNote(v, 'Link/geheim.md').ok, false);
});

test('Schnell merken: neue Notiz im Eingang, nie überschreiben, sichere Dateinamen', () => {
  const v = fakeVault();
  const now = new Date(2026, 9, 28, 9, 5);
  const res = addNote(v, 'Idee: Shop/Video #1', 'Text der Idee', now);
  assert.strictEqual(res.data.rel, path.join('Eingang', '2026-10-28 0905 Idee  Shop Video  1.md'.replace(/\s+/g, ' ')));
  assert.match(fs.readFileSync(path.join(v, res.data.rel), 'utf8'), /^# Idee  ?Shop Video 1|^# Idee/);
  assert.strictEqual(addNote(v, 'Idee: Shop/Video #1', 'nochmal', now).ok, false);
  assert.strictEqual(addNote(v, '', '', now).ok, false);
  assert.ok(addNote(v, '../../x', 'y', now).data.rel.startsWith('Eingang'));
});

test('Obsidian-Link öffnet die Notiz im richtigen Vault', () => {
  assert.strictEqual(obsidianUrl('/Users/x/Documents/Claude-Vault', 'Projekte/Zentrale.md'), 'obsidian://open?vault=Claude-Vault&file=Projekte%2FZentrale');
});

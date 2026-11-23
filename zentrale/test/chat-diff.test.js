// Änderungen ansehen: nicht committete Dateien mit +/− und der Diff einer Datei – an einem echten Mini-Repository.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { changes, fileDiff, parseStatus } = require('../src/chat-diff');

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-')));
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });

test.before(() => {
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'eins\nzwei\ndrei\n');
  fs.writeFileSync(path.join(repo, 'weg.txt'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'start');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'eins\nZWEI\ndrei\nvier\n');
  fs.rmSync(path.join(repo, 'weg.txt'));
  fs.mkdirSync(path.join(repo, 'neu'));
  fs.writeFileSync(path.join(repo, 'neu', 'b.txt'), 'hallo\nwelt');
  fs.writeFileSync(path.join(repo, 'neu', 'c.txt'), 'x\ny\n');
  fs.writeFileSync(path.join(repo, 'neu', 'leer.txt'), '');
});

test('Änderungen: geändert, gelöscht und neu mit Zahlen', async () => {
  const r = await changes(repo);
  assert.strictEqual(r.git, true);
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.deepStrictEqual([by['a.txt'].status, by['a.txt'].plus, by['a.txt'].minus], ['geändert', 2, 1]);
  assert.strictEqual(by['weg.txt'].status, 'gelöscht');
  assert.deepStrictEqual([by['neu/b.txt'].status, by['neu/b.txt'].plus], ['neu', 2]);
  assert.strictEqual(by['neu/c.txt'].plus, 2, 'Zeilenumbruch am Ende zählt nicht als eigene Zeile');
  assert.strictEqual(by['neu/leer.txt'].plus, 0);
});

test('Änderungen: eingebettete Git-Ordner stehen als Ordner am Ende', async () => {
  const sub = path.join(repo, 'agent');
  fs.mkdirSync(sub);
  execFileSync('git', ['init', '-q'], { cwd: sub });
  fs.writeFileSync(path.join(sub, 'x.txt'), 'x');
  const r = await changes(repo);
  const last = r.files[r.files.length - 1];
  assert.deepStrictEqual([last.path, last.ordner], ['agent/', true]);
  fs.rmSync(sub, { recursive: true, force: true });
});

test('Diff: geänderte und neue Datei, nichts außerhalb des Projekts', async () => {
  const a = await fileDiff(repo, 'a.txt');
  assert.match(a.data.diff, /^-zwei$/m);
  assert.match(a.data.diff, /^\+ZWEI$/m);
  const b = await fileDiff(repo, 'neu/b.txt');
  assert.match(b.data.diff, /^\+hallo$/m);
  const c = await fileDiff(repo, 'neu/c.txt');
  assert.deepStrictEqual(c.data.diff.split('\n').slice(1), ['+x', '+y'], 'keine leere +-Zeile am Ende');
  assert.strictEqual((await fileDiff(repo, '../../etc/hosts')).ok, false);
  assert.strictEqual((await fileDiff(os.tmpdir(), 'x')).ok, false, 'kein Git-Projekt');
});

test('Status: Umbenennungen überspringen den alten Namen', () => {
  assert.deepStrictEqual(parseStatus('R  neu.txt\0alt.txt\0?? x.js\0 M y.js\0'),
    [{ path: 'neu.txt', status: 'umbenannt' }, { path: 'x.js', status: 'neu' }, { path: 'y.js', status: 'geändert' }]);
});

test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

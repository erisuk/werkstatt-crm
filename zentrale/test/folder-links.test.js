// Ordner und Projekte verbinden: welche Ordner erlaubt sind, Verknüpfungen in beide Richtungen, --add-dir beim Start.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fl = require('../src/folder-links');
const { ClaudeChat } = require('../src/claude');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordner-home-')));
const dir = (rel) => { const p = path.join(home, rel); fs.mkdirSync(p, { recursive: true }); return p; };

test('Ordner: nur echte Ordner im Benutzerordner, nie versteckte und nie der Benutzerordner selbst', () => {
  const esa = dir('ESA Büro');
  assert.strictEqual(fl.cleanDir(esa, home), esa);
  assert.strictEqual(fl.cleanDir(home, home), null);
  assert.strictEqual(fl.cleanDir(dir('.ssh'), home), null);
  assert.strictEqual(fl.cleanDir(dir('projekt/.git'), home), null);
  assert.strictEqual(fl.cleanDir(os.tmpdir(), home), null);
  assert.strictEqual(fl.cleanDir(path.join(home, 'gibtsnicht'), home), null);
  assert.strictEqual(fl.cleanDir('relativ/pfad', home), null);
  fs.writeFileSync(path.join(home, 'datei.txt'), 'x');
  assert.strictEqual(fl.cleanDir(path.join(home, 'datei.txt'), home), null);
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'link-zu-ssh'));
  assert.strictEqual(fl.cleanDir(path.join(home, 'link-zu-ssh'), home), null, 'Verknüpfung in einen versteckten Ordner');
});

test('Projekte verknüpfen: in beide Richtungen, ohne Doppelte, Lösen räumt auf, alte Liste bleibt unverändert', () => {
  const empty = {};
  const a = fl.link(empty, '/u/esa', '/u/steuer');
  assert.deepStrictEqual(empty, {});
  assert.deepStrictEqual(fl.linked(a, '/u/esa'), ['/u/steuer']);
  assert.deepStrictEqual(fl.linked(a, '/u/steuer'), ['/u/esa']);
  assert.deepStrictEqual(fl.link(a, '/u/esa', '/u/steuer'), a);
  assert.deepStrictEqual(fl.unlink(a, '/u/steuer', '/u/esa'), {});
  assert.deepStrictEqual(fl.link(a, '/u/esa', '/u/esa'), a, 'nicht mit sich selbst');
  assert.deepStrictEqual(fl.mergeDirs('/u/esa', ['/u/steuer', '/u/esa'], ['/u/steuer', '/u/x']), ['/u/steuer', '/u/x']);
});

test('Projekte verknüpfen: Speichern und Laden, kaputte Datei = keine Verknüpfungen', () => {
  const file = path.join(home, 'daten', 'links.json');
  fl.save(file, fl.link({}, '/u/a', '/u/b'));
  assert.deepStrictEqual(fl.load(file), { '/u/a': ['/u/b'], '/u/b': ['/u/a'] });
  fs.writeFileSync(file, '{kaputt');
  assert.deepStrictEqual(fl.load(file), {});
  fs.writeFileSync(file, JSON.stringify({ '/u/a': 'kein array', '/u/b': ['/u/a', 5] }));
  assert.deepStrictEqual(fl.load(file), { '/u/b': ['/u/a'] });
});

test('Chat: weitere Ordner gehen als --add-dir an Claude, Ändern gilt ab der nächsten Nachricht', async () => {
  const log = path.join(home, 'args.log');
  const FAKE = path.join(__dirname, 'fake-claude.js');
  const a = dir('ESA Büro'); const b = dir('steuer');
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_ARGS_LOG: log }, cwd: os.tmpdir(), addDirs: [a] });
  try {
    chat.start();
    await new Promise((r) => setTimeout(r, 300));
    let args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.strictEqual(args[args.indexOf('--add-dir') + 1], a);
    chat.setAddDirs([a, b]);
    assert.strictEqual(chat.needsRestart, true);
    await chat.send('hallo');
    await new Promise((r) => setTimeout(r, 400));
    args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.deepStrictEqual(args.filter((x, i) => args[i - 1] === '--add-dir'), [a, b]);
  } finally {
    await chat.stop();
  }
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

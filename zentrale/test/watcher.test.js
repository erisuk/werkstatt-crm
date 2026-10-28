// Tests für den Ordner-Wächter: Muster, Regeln prüfen, einsortieren ohne Überschreiben, rückgängig.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Eigener „Benutzerordner“ für die Tests, damit nichts Echtes angefasst wird.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-home-')));
process.env.HOME = home;
const { FolderWatcher, patternToRegex, cleanRule, freeName } = require('../src/watcher');

const dirs = () => {
  const src = fs.mkdtempSync(path.join(home, 'quelle-'));
  const dst = fs.mkdtempSync(path.join(home, 'ziel-'));
  return { src, dst, file: path.join(fs.mkdtempSync(path.join(home, 'daten-')), 'watcher.json') };
};

test('Muster: * und ?, Groß/klein egal, Sonderzeichen wörtlich', () => {
  const re = patternToRegex('*Rechnung*.pdf');
  assert.ok(re.test('2026-10 rechnung ESA.PDF'));
  assert.ok(!re.test('Rechnung.pdf.zip'));
  assert.ok(patternToRegex('IMG_????.jpg').test('IMG_1234.jpg'));
  assert.ok(patternToRegex('a(1).txt').test('a(1).txt'));
  assert.strictEqual(patternToRegex(''), null);
  assert.strictEqual(patternToRegex('x'.repeat(81)), null);
});

test('Regeln: nur Ordner im Benutzerordner, keine versteckten, Quelle ≠ Ziel', () => {
  const { src, dst } = dirs();
  assert.ok(cleanRule({ folder: src, pattern: '*.pdf', target: dst }).ok);
  assert.strictEqual(cleanRule({ folder: os.tmpdir(), pattern: '*.pdf', target: dst }).ok, false);
  fs.mkdirSync(path.join(home, '.geheim'), { recursive: true });
  assert.strictEqual(cleanRule({ folder: src, pattern: '*.pdf', target: path.join(home, '.geheim') }).ok, false);
  assert.strictEqual(cleanRule({ folder: src, pattern: '*.pdf', target: src }).ok, false);
  assert.strictEqual(cleanRule({ folder: src, pattern: '', target: dst }).ok, false);
  // Ziel darf noch fehlen (wird angelegt), aber nur im Benutzerordner und nicht versteckt
  assert.ok(cleanRule({ folder: src, pattern: '*.pdf', target: path.join(home, 'gibtsnicht') }).ok);
  assert.strictEqual(cleanRule({ folder: src, pattern: '*.pdf', target: path.join(home, 'gibtsnicht', '.versteckt') }).ok, false);
  assert.strictEqual(cleanRule({ folder: src, pattern: '*.pdf', target: '/tmp/zentrale-gibtsnicht/x' }).ok, false);
});

test('Freie Namen: nie überschreiben', () => {
  const { dst } = dirs();
  fs.writeFileSync(path.join(dst, 'R.pdf'), '1');
  fs.writeFileSync(path.join(dst, 'R (2).pdf'), '2');
  assert.strictEqual(freeName(dst, 'R.pdf'), path.join(dst, 'R (3).pdf'));
  assert.strictEqual(freeName(dst, 'neu.pdf'), path.join(dst, 'neu.pdf'));
});

test('Einsortieren mit Protokoll, gleicher Name bekommt (2), rückgängig holt zurück', () => {
  const { src, dst, file } = dirs();
  const w = new FolderWatcher(file);
  assert.ok(w.saveRule({ folder: src, pattern: '*Rechnung*', target: dst }).ok);
  const moved = [];
  w.on('moved', (m) => moved.push(m));
  fs.writeFileSync(path.join(dst, 'Rechnung.pdf'), 'alt');
  fs.writeFileSync(path.join(src, 'Rechnung.pdf'), 'neu');
  const entry = w.handle(src, 'Rechnung.pdf');
  assert.strictEqual(entry.to, path.join(dst, 'Rechnung (2).pdf'));
  assert.strictEqual(fs.readFileSync(path.join(dst, 'Rechnung.pdf'), 'utf8'), 'alt');
  assert.strictEqual(moved.length, 1);
  // Ohne passende Regel: nur gemeldet, nicht bewegt
  fs.writeFileSync(path.join(src, 'Foto.jpg'), 'x');
  assert.strictEqual(w.handle(src, 'Foto.jpg'), null);
  assert.ok(fs.existsSync(path.join(src, 'Foto.jpg')));
  assert.strictEqual(w.get().unsorted[0].name, 'Foto.jpg');
  w.dismiss(path.join(src, 'Foto.jpg'));
  assert.strictEqual(w.get().unsorted.length, 0);
  // Rückgängig – und die zurückgeholte Datei wird nicht gleich wieder einsortiert
  assert.ok(w.undo(entry.id).ok);
  assert.strictEqual(fs.readFileSync(path.join(src, 'Rechnung.pdf'), 'utf8'), 'neu');
  assert.strictEqual(w.handle(src, 'Rechnung.pdf'), null);
  assert.strictEqual(w.undo(entry.id).ok, false);
  // Nach dem Neustart: Regel und Protokoll noch da
  const again = new FolderWatcher(file);
  assert.strictEqual(again.get().rules.length, 1);
  assert.strictEqual(again.get().log[0].undone, true);
  w.stop();
});

test('Echte Dateien: der Wächter sortiert, sobald die Datei fertig ist', async () => {
  const { src, dst, file } = dirs();
  const w = new FolderWatcher(file);
  w.saveRule({ folder: src, pattern: '*.mp4', target: dst });
  const done = new Promise((resolve) => w.once('moved', resolve));
  fs.writeFileSync(path.join(src, 'Bit.mp4.part'), 'lädt');
  fs.writeFileSync(path.join(src, 'Bit.mp4'), 'video');
  const m = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 8000))]);
  w.stop();
  assert.ok(m, 'nicht einsortiert');
  assert.ok(fs.existsSync(path.join(dst, 'Bit.mp4')));
  assert.ok(fs.existsSync(path.join(src, 'Bit.mp4.part')));
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('Regel mit noch fehlendem Zielordner bleibt erhalten; nie überschreiben', () => {
  const { src, file } = dirs();
  const target = path.join(home, 'neu-erst-spaeter', 'Rechnungen');
  const w = new FolderWatcher(file);
  assert.ok(w.saveRule({ folder: src, pattern: '*.pdf', target }).ok);
  assert.strictEqual(new FolderWatcher(file).get().rules.length, 1);
  fs.writeFileSync(path.join(src, 'a.pdf'), 'neu');
  const e = w.handle(src, 'a.pdf');
  assert.strictEqual(e.to, path.join(fs.realpathSync(home), 'neu-erst-spaeter', 'Rechnungen', 'a.pdf'));
  fs.writeFileSync(path.join(src, 'a.pdf'), 'zweite');
  assert.strictEqual(w.handle(src, 'a.pdf').to, path.join(fs.realpathSync(home), 'neu-erst-spaeter', 'Rechnungen', 'a (2).pdf'));
  assert.strictEqual(fs.readFileSync(e.to, 'utf8'), 'neu');
  // Verknüpfungen werden nicht angefasst
  fs.symlinkSync('/etc/hosts', path.join(src, 'link.pdf'));
  w.settle(src, 'link.pdf', -1);
  assert.ok(fs.lstatSync(path.join(src, 'link.pdf')).isSymbolicLink());
  w.stop();
});

// Tests für die Härtung nach der Fehlersuche: rekursives Lesen, Aufwach-Pause, kaputte Dateien, Vault-Grenzen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isReadOnlyCommand } = require('../src/claude');
const { TaskScheduler } = require('../src/tasks');
const kommentare = require('../src/kommentare');

test('Rekursives Lesen braucht immer eine Freigabe (würde .env und .git lesen)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-ro-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x');
  for (const c of ['grep -rn TOKEN .', 'grep -R key', 'grep -r key', 'grep --recursive x', 'grep -d recurse x .', 'ls -R', 'ls -laR']) assert.strictEqual(isReadOnlyCommand(c, cwd), false, c);
  for (const c of ['grep -n x a.txt', 'ls -la', 'cat a.txt', 'wc -l a.txt']) assert.strictEqual(isReadOnlyCommand(c, cwd), true, c);
});

test('Nach dem Aufwachen wartet der Zeitplan kurz', () => {
  const s = new TaskScheduler(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-t-')), 'tasks.json'), async () => ({ ok: true }));
  let runs = 0;
  s.run = () => { runs += 1; };
  s.tasks = [{ id: 'a', enabled: true, time: '00:00', lastRunDay: null }];
  s.pause(60000);
  s.tick(new Date());
  assert.strictEqual(runs, 0, 'während der Pause kein Lauf');
  s.pausedUntil = 0;
  s.tick(new Date());
  assert.strictEqual(runs, 1, 'danach läuft die fällige Aufgabe');
});

test('Kommentare: eine unlesbare Datei wird nie mit einer leeren Liste überschrieben', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-k-')), 'k.json');
  fs.writeFileSync(file, '{kaputt');
  const d = kommentare.load(file);
  assert.throws(() => kommentare.save(file, { ...d, konto: 'x' }), /nicht überschrieben/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{kaputt');
  const neu = path.join(path.dirname(file), 'neu.json');
  kommentare.save(neu, kommentare.load(neu)); // gibt es noch nicht → darf angelegt werden
  assert.ok(fs.existsSync(neu));
});

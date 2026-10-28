const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('../src/backup');
const { Settings } = require('../src/settings');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-backup-'));
  const userData = path.join(home, 'Library/Application Support/Zentrale');
  fs.mkdirSync(path.join(userData, 'privat'), { recursive: true });
  fs.mkdirSync(path.join(userData, 'Partitions/portale'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), '{}');
  fs.writeFileSync(path.join(userData, 'planer.json'), '[]');
  fs.writeFileSync(path.join(userData, 'mcp-mac.json'), '{}');
  fs.writeFileSync(path.join(userData, 'privat/finanzen.enc'), 'verschluesselt');
  fs.writeFileSync(path.join(userData, 'Partitions/portale/Cookies'), 'geheim');
  const disk = path.join(home, 'Platte');
  fs.mkdirSync(disk);
  return { home, userData, disk: fs.realpathSync(disk) };
}

test('sichert nur eigene Daten – keine Caches, keine Anmeldungen, keine mcp-Dateien', async () => {
  const { home, userData, disk } = tmpHome();
  const r = await backup.runBackup({ userData, target: disk, home, trash: async () => {} });
  assert.strictEqual(r.ok, true, r.error);
  const files = fs.readdirSync(r.dir).sort();
  assert.deepStrictEqual(files, ['LIESMICH.txt', 'planer.json', 'privat', 'settings.json']);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'privat/finanzen.enc'), 'utf8'), 'verschluesselt');
  assert.ok(!fs.existsSync(path.join(r.dir, 'Partitions')));
});

test('lehnt iCloud, Dropbox und gespiegelte Dokumente ab', () => {
  const { home, userData } = tmpHome();
  for (const d of ['Library/Mobile Documents/com~apple~CloudDocs/Documents', 'Dropbox/x', 'Library/CloudStorage/GoogleDrive-a', 'Documents']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  for (const d of ['Dropbox/x', 'Library/CloudStorage/GoogleDrive-a', 'Documents', 'Library/Mobile Documents/com~apple~CloudDocs']) {
    const t = backup.checkTarget(path.join(home, d), { userData, home });
    assert.strictEqual(t.ok, false, d);
    assert.match(t.error, /Cloud/);
  }
});

test('Dokumente sind erlaubt, wenn iCloud sie nicht spiegelt', () => {
  const { home, userData } = tmpHome();
  fs.mkdirSync(path.join(home, 'Documents'));
  assert.strictEqual(backup.checkTarget(path.join(home, 'Documents'), { userData, home }).ok, true);
});

test('lehnt Datenordner selbst, relative Pfade und fehlende Platten ab', () => {
  const { home, userData } = tmpHome();
  assert.strictEqual(backup.checkTarget(path.join(userData, 'privat'), { userData, home }).ok, false);
  assert.strictEqual(backup.checkTarget('Platte', { userData, home }).ok, false);
  const gone = backup.checkTarget('/Volumes/GibtsNicht-123', { userData, home });
  assert.strictEqual(gone.ok, false);
  assert.strictEqual(gone.missing, true);
});

test('behält die 7 neuesten Sicherungen, ältere gehen in den Papierkorb', async () => {
  const { home, userData, disk } = tmpHome();
  const trashed = [];
  for (let i = 0; i < 9; i++) {
    const r = await backup.runBackup({ userData, target: disk, home, now: new Date(2026, 9, 1 + i, 8, 0), trash: async (p) => { trashed.push(path.basename(p)); fs.rmSync(p, { recursive: true }); } });
    assert.strictEqual(r.ok, true);
  }
  const left = backup.listBackups(disk).map((b) => b.name);
  assert.strictEqual(left.length, 7);
  assert.strictEqual(left[0], '2026-10-09_08-00');
  assert.deepStrictEqual(trashed, ['2026-10-01_08-00', '2026-10-02_08-00']);
});

test('Automatik: einmal am Tag, nur mit Ordner und eingeschaltet', () => {
  const now = new Date(2026, 9, 28, 10, 0);
  assert.strictEqual(backup.isDue({ dir: '/Volumes/X', auto: true }, null, now), true);
  assert.strictEqual(backup.isDue({ dir: '/Volumes/X', auto: true }, '2026-10-28', now), false);
  assert.strictEqual(backup.isDue({ dir: '/Volumes/X', auto: false }, null, now), false);
  assert.strictEqual(backup.isDue({ dir: null, auto: true }, null, now), false);
});

test('Firewall-Befehl fragt macOS nach dem Admin-Passwort und enthält nur feste Befehle', () => {
  const s = backup.firewallScript(true);
  assert.match(s, /with administrator privileges$/);
  assert.match(s, /--setglobalstate on && .*--setstealthmode on/);
  assert.doesNotMatch(backup.firewallScript(false), /stealth/);
});

test('Einstellungen: Sicherungs-Ordner nur absolut, Automatik nur mit Ordner', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-set-')), 'settings.json');
  const s = new Settings(file);
  assert.deepStrictEqual(s.get().backup, { dir: null, auto: false });
  assert.deepStrictEqual(s.update({ backup: { auto: true } }).backup, { dir: null, auto: false });
  assert.deepStrictEqual(s.update({ backup: { dir: 'relativ' } }).backup, { dir: null, auto: false });
  assert.deepStrictEqual(s.update({ backup: { dir: '/Volumes/Platte' } }).backup, { dir: '/Volumes/Platte', auto: false });
  assert.deepStrictEqual(s.update({ backup: { auto: true } }).backup, { dir: '/Volumes/Platte', auto: true });
  assert.deepStrictEqual(new Settings(file).get().backup, { dir: '/Volumes/Platte', auto: true });
});

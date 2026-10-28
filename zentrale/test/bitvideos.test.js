// Tests für die Seite „Bit-Videos“ mit einem Test-Studio-Ordner.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const b = require('../src/bitvideos');

function fakeStudio() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-studio-'));
  const w = (rel, daten) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof daten === 'string' ? daten : JSON.stringify(daten));
  };
  w('videos/015-mods/skript.json', { thema: 'Claude Code hat Mods bekommen', format: 'superkraft' });
  w('videos/016-zentrale/skript.json', { thema: 'Bit stellt seine Zentrale vor', format: 'raum' });
  w('videos/901-test/skript.json', { thema: 'Testvideo' });
  w('gedaechtnis/veroeffentlichung.json', { v015: { status: 'freigegeben', gepostet: ['insta'] }, v016: { status: 'wartet' } });
  w('gedaechtnis/themen_gesperrt.json', ['WordArt']);
  w('gedaechtnis/recherche/2026-10-25.json', { themen: [{ thema: 'Alt', summe: 10 }] });
  w('gedaechtnis/recherche/2026-10-26.json', { themen: [
    { thema: 'Claude Code hat Mods bekommen', format: 'superkraft', hook: 'Mods!', summe: 20, quellen: ['https://a'] },
    { thema: 'WordArt', format: 'top-liste', summe: 12 },
    { thema: 'Neu', format: 'github-fund', summe: 18 }] });
  return root;
}

test('Übersicht: Videos ohne Testvideos, Status, neuestes Radar mit „gemacht“ und „gesperrt“', () => {
  const d = b.uebersicht(fakeStudio()).data;
  assert.deepStrictEqual(d.videos.map((v) => [v.nr, v.status]), [[16, 'wartet'], [15, 'freigegeben']]);
  assert.strictEqual(d.radar.datum, '2026-10-26');
  assert.deepStrictEqual(d.radar.themen.map((t) => [t.thema, t.gemacht, t.gesperrt]),
    [['Claude Code hat Mods bekommen', true, false], ['WordArt', false, true], ['Neu', false, false]]);
  assert.deepStrictEqual(d.einstellungen, b.STANDARD);
  assert.strictEqual(d.pauseBis, null);
});

test('Fehlender Studio-Ordner gibt eine verständliche Meldung', () => {
  const r = b.uebersicht('/gibt/es/nicht');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /nicht gefunden/);
});

test('Pause: nur Zukunftsdatum, leer hebt sie auf', () => {
  const s = fakeStudio();
  assert.ok(b.pauseSetzen('2099-01-01', s).ok);
  assert.strictEqual(b.uebersicht(s).data.pauseBis, '2099-01-01');
  assert.ok(!b.pauseSetzen('2000-01-01', s).ok);
  assert.ok(!b.pauseSetzen('morgen', s).ok);
  assert.ok(b.pauseSetzen(null, s).ok);
  assert.strictEqual(b.uebersicht(s).data.pauseBis, null);
});

test('Suchradius: Quellen, Subreddits, GitHub-Takt und Fokus werden geprüft gespeichert', () => {
  const s = fakeStudio();
  assert.ok(b.einstellen({ quellen_aus: ['heise', 'myspace'], reddit_subs: 'r/ClaudeAI, OpenAI  ClaudeAI', github_alle: 0, fokus: ' Bild-KI ' }, s).ok);
  assert.deepStrictEqual(b.einstellungen(s), { quellen_aus: ['heise'], reddit_subs: ['ClaudeAI', 'OpenAI'], github_alle: 0, fokus: 'Bild-KI' });
  assert.ok(!b.einstellen({ reddit_subs: 'gut, schlecht/../x' }, s).ok);
  assert.ok(!b.einstellen({ reddit_subs: '' }, s).ok);
  assert.ok(!b.einstellen({ github_alle: 11 }, s).ok);
  assert.ok(!b.einstellen({ quellen_aus: b.QUELLEN_IDS }, s).ok);
  assert.deepStrictEqual(b.einstellungen(s).reddit_subs, ['ClaudeAI', 'OpenAI']);
});

test('Wunschthemen: anlegen, Link prüfen, nach vorn holen, entfernen', () => {
  const s = fakeStudio();
  assert.ok(b.wunschHinzu('Erstes', '', s).ok);
  assert.ok(b.wunschHinzu('Zweites', 'https://www.anthropic.com/news/x', s).ok);
  assert.ok(!b.wunschHinzu('', '', s).ok);
  assert.ok(!b.wunschHinzu('Böse', 'javascript:alert(1)', s).ok);
  let liste = b.uebersicht(s).data.wuensche;
  assert.deepStrictEqual(liste.map((w) => w.thema), ['Erstes', 'Zweites']);
  assert.ok(b.wunschVor(liste[1].id, s).ok);
  liste = b.uebersicht(s).data.wuensche;
  assert.deepStrictEqual(liste.map((w) => w.thema), ['Zweites', 'Erstes']);
  b.wunschEntfernen(liste[0].id, s);
  assert.deepStrictEqual(b.uebersicht(s).data.wuensche.map((w) => w.thema), ['Erstes']);
});

test('Sperren und wieder freigeben', () => {
  const s = fakeStudio();
  b.sperren('Neu', true, s);
  assert.ok(b.uebersicht(s).data.radar.themen.find((t) => t.thema === 'Neu').gesperrt);
  b.sperren('WordArt', false, s);
  assert.deepStrictEqual(b.uebersicht(s).data.gesperrt, ['Neu']);
});

test('Keine halb geschriebenen Dateien', () => {
  const s = fakeStudio();
  b.wunschHinzu('X', '', s);
  assert.ok(!fs.readdirSync(path.join(s, 'gedaechtnis')).some((n) => n.endsWith('.tmp')));
});

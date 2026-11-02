const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bp = require('../src/bit-posten');
const { dateiAus, bereich } = require('../src/bit-medien');
const { videoResource } = require('../src/youtube');

// Ein kleines Studio wie ~/ki-creator/studio
function studio() {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-studio-'));
  fs.mkdirSync(path.join(s, 'gedaechtnis'));
  fs.mkdirSync(path.join(s, 'out'));
  const video = (ordner, thema, mitDatei = true) => {
    fs.mkdirSync(path.join(s, 'videos', ordner), { recursive: true });
    fs.writeFileSync(path.join(s, 'videos', ordner, 'skript.json'), JSON.stringify({ thema, kommentar_wort: 'TEAM' }));
    fs.writeFileSync(path.join(s, 'videos', ordner, 'post.json'), JSON.stringify({ ki_label: true,
      tiktok: { beschreibung: 'TT Text', hashtags: ['#KI', '#Claude'] }, instagram: { beschreibung: 'IG Text', hashtags: ['#KI'] },
      youtube: { titel: 'YT Titel #Shorts', beschreibung: 'YT Text', hashtags: ['#KI'] } }));
    if (mitDatei) fs.writeFileSync(path.join(s, 'out', `v${ordner.slice(0, 3)}.mp4`), 'video');
  };
  video('017-advisor', 'Advisor');
  video('018-team', 'Claude leitet ein Team');
  video('020-ohne-datei', 'Noch im Bau', false);
  video('021-erstes', 'Mika');
  video('021-zweites', 'Schnitt');
  fs.writeFileSync(path.join(s, 'gedaechtnis', 'veroeffentlichung.json'), JSON.stringify({
    v017: { status: 'abgelehnt', zeit: '2026-10-30 09:00', grund: 'langweilig' },
    v018: { status: 'freigegeben', zeit: '2026-11-01 10:00', gepostet: ['insta'], gepostet_insta: '2026-11-01 12:00', notiz: 'bleibt' },
  }));
  return s;
}

test('Bit-Posten: Liste mit Stand, Texten, Datei und doppelter Nummer', () => {
  const s = studio();
  const l = bp.liste(s);
  const v18 = l.find((v) => v.id === 'v018');
  assert.deepStrictEqual(v18.gepostet, ['insta']);
  assert.strictEqual(v18.gepostetAm.insta, '2026-11-01 12:00');
  assert.strictEqual(v18.texte.tiktok.text, 'TT Text\n\n#KI #Claude');
  assert.strictEqual(v18.texte.youtube.titel, 'YT Titel #Shorts');
  assert.ok(v18.datei.endsWith('out/v018.mp4'));
  assert.strictEqual(v18.kiLabel, true);
  assert.deepStrictEqual(l.filter((v) => v.doppelt).map((v) => v.ordner).sort(), ['021-erstes', '021-zweites']);
  fs.rmSync(s, { recursive: true, force: true });
});

test('Bit-Posten: Abhaken ändert nur Felder – Zeitstempel, Rückgängig, abgelehnt bleibt abgelehnt', () => {
  const s = studio();
  assert.strictEqual(bp.gepostetSetzen('v018', ['tiktok', 'youtube'], true, { youtube_url: 'https://youtu.be/x' }, s).ok, true);
  let e = JSON.parse(fs.readFileSync(path.join(s, 'gedaechtnis', 'veroeffentlichung.json'), 'utf8')).v018;
  assert.deepStrictEqual(e.gepostet, ['insta', 'tiktok', 'youtube'], 'alphabetisch wie sorted() im Telegram-Bot');
  assert.strictEqual(e.gepostet_insta, '2026-11-01 12:00', 'alter Zeitstempel bleibt');
  assert.match(e.gepostet_tiktok, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.strictEqual(e.notiz, 'bleibt');
  assert.strictEqual(e.youtube_url, 'https://youtu.be/x');
  assert.strictEqual(bp.gepostetSetzen('v018', ['tiktok'], false, {}, s).ok, true);
  e = JSON.parse(fs.readFileSync(path.join(s, 'gedaechtnis', 'veroeffentlichung.json'), 'utf8')).v018;
  assert.deepStrictEqual(e.gepostet, ['insta', 'youtube']);
  bp.gepostetSetzen('v017', ['insta'], true, {}, s);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s, 'gedaechtnis', 'veroeffentlichung.json'), 'utf8')).v017.status, 'abgelehnt');
  assert.strictEqual(bp.gepostetSetzen('v018', ['facebook'], true, {}, s).ok, false);
  assert.strictEqual(bp.gepostetSetzen('../x', ['insta'], true, {}, s).ok, false);
  assert.strictEqual(bp.gepostetSetzen('v021', ['insta'], true, {}, s).ok, false, 'doppelte Nummer wird nie abgehakt');
  fs.rmSync(s, { recursive: true, force: true });
});

test('Bit-Posten: was das Posten verhindert', () => {
  const s = studio();
  const l = bp.liste(s);
  const v = (id, ordner) => l.find((x) => x.id === id && (!ordner || x.ordner === ordner));
  assert.strictEqual(bp.hindernis(v('v018'), ['tiktok']), null);
  assert.match(bp.hindernis(v('v017'), ['tiktok']), /abgelehnt/);
  assert.match(bp.hindernis(v('v020'), ['tiktok']), /Videodatei fehlt/);
  assert.match(bp.hindernis(v('v021', '021-erstes'), ['tiktok']), /zweimal/);
  fs.rmSync(s, { recursive: true, force: true });
});

test('Bit-Posten: Auftrag an Claude – Kontoprüfung, KI-Label, Texte als Daten, nie MURIS-Tabs', () => {
  const s = studio();
  const v = bp.liste(s).find((x) => x.id === 'v018');
  const tabs = bp.bitTabs([
    { id: '1', name: 'Shop · Instagram', url: 'https://www.instagram.com/', title: 'shop.muris' },
    { id: '2', name: 'Bit · Instagram', url: 'https://www.instagram.com/' },
    { id: '3', name: 'Bit · TikTok', url: 'https://www.tiktok.com/', title: 'MURIS' },
  ]);
  assert.strictEqual(tabs.insta.id, '2');
  assert.strictEqual(tabs.tiktok, null, 'Tab mit MURIS im Titel wird nie benutzt');
  const a = bp.auftrag(v, ['insta'], { insta: tabs.insta });
  assert.match(a, /@bit\.ai\.ger, @bitainews, @bitainews_de/);
  assert.match(a, /MURIS/);
  assert.match(a, /KI-Label/);
  assert.match(a, /"IG Text\\n\\n#KI"/);
  assert.match(a, /"Bit · Instagram"/);
  assert.match(a, /bit_gepostet/);
  assert.doesNotMatch(a, /TikTok –/);
  fs.rmSync(s, { recursive: true, force: true });
});

test('Abspiel-Protokoll: nur fertige Videos und Titelbilder aus studio/out, mit Bereichen', () => {
  const s = studio();
  fs.writeFileSync(path.join(s, 'out', 'v018_cover.png'), 'png');
  fs.writeFileSync(path.join(s, 'geheim.txt'), 'x');
  assert.ok(dateiAus('bitvideo://out/v018.mp4', s).endsWith('out/v018.mp4'));
  assert.ok(dateiAus('bitvideo://out/v018_cover.png', s));
  assert.strictEqual(dateiAus('bitvideo://out/../geheim.txt', s), null);
  assert.strictEqual(dateiAus('bitvideo://out/%2e%2e%2fgeheim.txt', s), null);
  assert.strictEqual(dateiAus('bitvideo://andere/v018.mp4', s), null);
  assert.strictEqual(dateiAus('bitvideo://out/v999.mp4', s), null);
  assert.deepStrictEqual(bereich('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepStrictEqual(bereich('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepStrictEqual(bereich('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(bereich('bytes=90-500', 100), { start: 90, end: 99 });
  assert.strictEqual(bereich('bytes=200-', 100), null);
  assert.strictEqual(bereich('kaputt', 100), null);
  fs.rmSync(s, { recursive: true, force: true });
});

test('YouTube: KI-Label als „synthetische Inhalte“, sonst nicht gesetzt', () => {
  assert.strictEqual(videoResource({ title: 't', description: 'd', aiLabel: true }).status.containsSyntheticMedia, true);
  assert.strictEqual('containsSyntheticMedia' in videoResource({ title: 't', description: 'd' }).status, false);
});

// Bildschirmsteuerung: Schutzregeln greifen, bevor irgendein Klick oder Tastendruck rausgeht.
// Der Mac wird hier nachgestellt – es wird nichts wirklich geklickt oder getippt.
const test = require('node:test');
const assert = require('node:assert');
const { Bildschirm, gesperrt, SKRIPTE } = require('../src/bildschirm');
const { toolStep } = require('../src/tool-steps');

function mac({ apps, vorneNach = (id) => id, passwort = false } = {}) {
  const log = [];
  let vorne = { name: 'Zentrale', id: 'de.werkstatt.zentrale' };
  const liste = apps || [{ name: 'Labelnize', id: 'com.nelko.labelnize' }, { name: 'Google Chrome', id: 'com.google.Chrome' },
    { name: 'Zentrale', id: 'de.werkstatt.zentrale' }, { name: 'MetaTrader 5', id: 'net.metaquotes.MetaTrader5' }];
  const run = async (script, args = []) => {
    if (script === SKRIPTE.apps) return JSON.stringify(liste.map((a) => ({ ...a, vorne: a.id === vorne.id })));
    if (script === SKRIPTE.vorne) return JSON.stringify(vorne);
    if (script === SKRIPTE.aktivieren) { const id = vorneNach(args[0]); vorne = liste.find((a) => a.id === id) || vorne; return 'ok'; }
    if (script === SKRIPTE.passwortfeld) return passwort ? 'AXSecureTextField' : 'AXTextField';
    log.push({ script: Object.keys(SKRIPTE).find((k) => SKRIPTE[k] === script) || 'kombi', args, vorne: vorne.id });
    return 'ok';
  };
  return { run, log };
}
const neu = (m, { ja = true } = {}) => {
  const gefragt = [];
  const b = new Bildschirm({ run: m.run, warte: async () => {}, foto: async () => null, fragen: async (a) => { gefragt.push(a.name); return ja; } });
  return { b, gefragt };
};

test('Bildschirm: Klick nur nach Freigabe und nur, wenn die App wirklich vorne ist', async () => {
  const m = mac();
  const { b, gefragt } = neu(m);
  const r = await b.klick({ app: 'Labelnize', x: 100, y: 200 });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(gefragt, ['Labelnize']);
  assert.deepStrictEqual(m.log, [{ script: 'klick', args: [100, 200, 'links', 1], vorne: 'com.nelko.labelnize' }]);
  await b.klick({ app: 'labelnize', x: 1, y: 1, doppelt: true });
  assert.deepStrictEqual(gefragt, ['Labelnize'], 'nur einmal fragen');
  assert.deepStrictEqual(m.log[1].args, [1, 1, 'links', 2]);
});

test('Bildschirm: kommt die App nicht nach vorn, passiert gar nichts (kein Tippen in die Zentrale)', async () => {
  const m = mac({ vorneNach: () => 'de.werkstatt.zentrale' });
  const { b } = neu(m);
  const r = await b.tippen({ app: 'Labelnize', text: '/Users/x/datei.png' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /nicht nach vorn/);
  assert.deepStrictEqual(m.log, []);
});

test('Bildschirm: gesperrte Apps, abgelehnte Freigabe, Passwortfelder, fehlende Apps', async () => {
  const m = mac();
  assert.match((await neu(m).b.klick({ app: 'Zentrale', x: 1, y: 1 })).error, /Zentrale selbst/);
  assert.match((await neu(m).b.klick({ app: 'Google Chrome', x: 1, y: 1 })).error, /Chrome-Erweiterung/);
  assert.match((await neu(m).b.taste({ app: 'MetaTrader 5', taste: 'enter' })).error, /Trading/);
  const nein = neu(m, { ja: false });
  assert.match((await nein.b.klick({ app: 'Labelnize', x: 1, y: 1 })).error, /nicht erlaubt/);
  assert.match((await neu(m).b.klick({ app: 'Gibtsnicht', x: 1, y: 1 })).error, /läuft nicht/);
  const pw = mac({ passwort: true });
  assert.match((await neu(pw).b.tippen({ app: 'Labelnize', text: 'geheim' })).error, /Passwortfeld/);
  assert.deepStrictEqual([...m.log, ...pw.log], [], 'nichts wurde geklickt oder getippt');
  assert.strictEqual(gesperrt('com.anthropic.claudefordesktop') !== null, true);
  assert.strictEqual(gesperrt('com.apple.systempreferences') !== null, true);
  assert.strictEqual(gesperrt('com.nelko.labelnize'), null);
});

test('Bildschirm: Eingaben werden geprüft', async () => {
  const m = mac();
  const { b } = neu(m);
  assert.strictEqual((await b.klick({ app: 'Labelnize', x: -5, y: 1 })).ok, false);
  assert.strictEqual((await b.klick({ app: 'Labelnize', x: 'a', y: 1 })).ok, false);
  assert.strictEqual((await b.tippen({ app: 'Labelnize', text: '' })).ok, false);
  assert.strictEqual((await b.tippen({ app: 'Labelnize', text: 'x'.repeat(2001) })).ok, false);
  assert.strictEqual((await b.taste({ app: 'Labelnize', taste: 'xyz' })).ok, false);
  assert.strictEqual((await b.taste({ app: 'Labelnize', taste: 'v' })).ok, false, 'Buchstabe ohne cmd → tippen benutzen');
  assert.strictEqual((await b.taste({ app: 'Labelnize', taste: 'v', mit: ['cmd'] })).ok, true);
  assert.strictEqual((await b.taste({ app: 'Labelnize', taste: 'enter' })).ok, true);
  assert.deepStrictEqual(m.log.map((l) => l.args), [['v', 'command down'], [36]]);
});

test('Bildschirm: Klick/Tippen sperren das Chatfeld, Foto und App-Liste nicht', () => {
  assert.strictEqual(toolStep('mcp__bildschirm__bildschirm_tippen', { app: 'x', text: 'y' }).screen, true);
  assert.strictEqual(toolStep('mcp__bildschirm__bildschirm_klick', { app: 'x', x: 1, y: 1 }).screen, true);
  assert.strictEqual(toolStep('mcp__bildschirm__bildschirm_foto', {}).screen, undefined);
});

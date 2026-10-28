// Tests für Data Layer, blinde Flecken, Simulation (Notfall-Probe, Probelauf) und App-Sperre-Einstellung.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DataLayer } = require('../src/data-layer');
const { blindSpots } = require('../src/blind-spots');
const simulation = require('../src/simulation');
const { Settings } = require('../src/settings');

const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-kr-')), n);

test('Data Layer: misst IPC-Kanäle, Fehler ohne Inhalte, private Kanäle ohne Fehlertext', async () => {
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const dl = new DataLayer({ file: null });
  dl.wrapIpc(ipc);
  ipc.handle('ok', async () => ({ ok: true }));
  ipc.handle('kaputt', async () => ({ ok: false, error: 'Nicht gefunden: /Users/x/geheim.txt' }));
  ipc.handle('fin-save', async () => ({ ok: false, error: 'Konto 1234 abgelehnt' }));
  ipc.handle('wirft', async () => { throw new TypeError('x'); });
  await handlers.ok(); await handlers.kaputt(); await handlers['fin-save']();
  await assert.rejects(handlers.wirft());
  const r = dl.report();
  assert.strictEqual(r.total, 4);
  const err = Object.fromEntries(r.failing.map((x) => [x.name, x.lastError]));
  assert.strictEqual(err['ipc:kaputt'], 'Nicht gefunden'); // nur bis zum Doppelpunkt – kein Pfad
  assert.strictEqual(err['ipc:fin-save'], 'Fehler'); // privat: kein Text
  assert.strictEqual(err['ipc:wirft'], 'TypeError');
});

test('Data Layer: Zwischenspeicher teilt gleichzeitige Läufe, hält ttl, invalidate lädt neu', async () => {
  let now = 1000;
  const dl = new DataLayer({ file: null, now: () => now });
  let runs = 0;
  const get = dl.source('x', async () => { runs += 1; return runs; }, { ttl: 3000 });
  const [a, b] = await Promise.all([get(), get()]);
  assert.strictEqual(a, 1); assert.strictEqual(b, 1); assert.strictEqual(runs, 1);
  now += 1000; assert.strictEqual(await get(), 1);
  now += 5000; assert.strictEqual(await get(), 2);
  get.invalidate(); assert.strictEqual(await get(), 3);
  assert.strictEqual(await get(true), 4);
});

test('Data Layer: Seitenaufrufe werden gezählt und gespeichert', () => {
  const file = tmp('d.json');
  const dl = new DataLayer({ file });
  dl.trackView('planner'); dl.trackView('planner'); dl.trackView('../böse');
  dl.stop();
  const again = new DataLayer({ file });
  assert.strictEqual(again.report().views.planner.visits, 2);
  assert.strictEqual(Object.keys(again.report().views).length, 1);
  again.stop();
});

test('Blinde Flecken: dringend zuerst, Bit-Logins, nie benutzte Seiten', () => {
  const now = Date.now();
  const s = blindSpots({ claudeFound: true, n8n: { running: true, hasKey: false }, connections: { mac: true, web: true }, online: true,
    logins: [{ id: 'a', name: 'Bit · TikTok', loggedIn: false }, { id: 'b', name: 'Bit · Instagram', loggedIn: true }],
    disk: { ok: true, free: 5 }, data: { slowest: [], failing: [], views: { overview: { visits: 3 } }, since: now - 5 * 86400000 } }, now);
  assert.strictEqual(s[0].level, 'rot');
  assert.ok(s.some((x) => x.title === 'n8n nicht verbunden'));
  assert.ok(s.some((x) => x.title === 'Bit · TikTok: nicht angemeldet'));
  assert.ok(!s.some((x) => /Instagram/.test(x.title)));
  assert.ok(s.some((x) => x.title === 'Nie benutzt' && /Planer/.test(x.detail)));
});

test('Notfall-Probe: alle Störungen werden erkannt', async () => {
  const p = await simulation.emergencyProbe();
  assert.ok(p.length >= 9);
  assert.deepStrictEqual(p.filter((x) => !x.covered).map((x) => x.title), []);
});

test('Probelauf: schreibende Werkzeuge führen nichts aus, lesende schon', async () => {
  const calls = [];
  const ops = { read: async () => { calls.push('read'); return { ok: true }; }, click: async () => { calls.push('click'); return { ok: true }; } };
  let dry = true;
  const w = simulation.dryRunOps(ops, simulation.DRY_BROWSER, () => dry, 'Web-Tab');
  await w.read({});
  const r = await w.click({ ref: 'e12' });
  assert.deepStrictEqual(calls, ['read']);
  assert.ok(r.probelauf && /PROBELAUF/.test(r.data) && /e12/.test(r.data));
  dry = false;
  await w.click({ ref: 'e12' });
  assert.deepStrictEqual(calls, ['read', 'click']);
  assert.match(simulation.dryRunPrompt('n8n', 'BIT Tagesvideo'), /Knoten für Knoten/);
  assert.match(simulation.bitPreviewPrompt(''), /Baue NICHTS/);
});

test('App-Sperre: standardmäßig an, nur erlaubte Minuten', () => {
  const file = tmp('s.json');
  const s = new Settings(file);
  assert.deepStrictEqual(s.get().appLock, { enabled: true, minutes: 15 });
  s.update({ appLock: { minutes: 7 } });
  assert.strictEqual(s.get().appLock.minutes, 15);
  s.update({ appLock: { enabled: false, minutes: 5 } });
  assert.deepStrictEqual(new Settings(file).get().appLock, { enabled: false, minutes: 5 });
});

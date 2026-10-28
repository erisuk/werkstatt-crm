// Tests für das Morgen-Cockpit: Fälligkeit der Mitteilung, Lage zusammenfassen, Einstellungen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDue, cockpit, summaryText, dayKey } = require('../src/morning');
const { Settings } = require('../src/settings');

test('Morgen-Mitteilung: einmal am Tag ab der Uhrzeit, höchstens drei Stunden nachgeholt', () => {
  const at = (h, m) => new Date(2026, 9, 28, h, m);
  assert.strictEqual(isDue(at(7, 59), '08:00', null), false);
  assert.strictEqual(isDue(at(8, 0), '08:00', null), true);
  assert.strictEqual(isDue(at(10, 30), '08:00', '2026-10-27'), true);
  assert.strictEqual(isDue(at(11, 1), '08:00', null), false);
  assert.strictEqual(isDue(at(8, 5), '08:00', dayKey(at(8, 0))), false);
  assert.strictEqual(isDue(at(8, 5), '8 Uhr', null), false);
});

test('Lage: Ungelesenes ohne localhost, nur Fehler und Einsortiertes der letzten 24 Stunden', () => {
  const now = Date.now();
  const c = cockpit({
    portals: [{ id: 'a', name: 'Gmail', url: 'https://mail.google.com/', unread: 3 }, { id: 'b', name: 'App', url: 'http://localhost:3000/', unread: 2 },
      { id: 'c', name: 'Outlook', url: 'https://outlook.live.com/', unread: 0 }],
    alerts: [{ at: now - 1000, body: 'x' }, { at: now - 2 * 86400000, body: 'alt' }],
    watcherLog: [{ at: now - 5000, undone: false }, { at: now - 5000, undone: true }],
    unsorted: [{}, {}], servers: [{ system: false }, { system: true }], now,
  });
  assert.deepStrictEqual(c.web.map((p) => p.name), ['Gmail']);
  assert.strictEqual(c.alerts.length, 1);
  assert.strictEqual(c.sorted, 1);
  assert.strictEqual(c.unsorted, 2);
  assert.strictEqual(c.servers, 1);
  assert.strictEqual(summaryText(c, [{}, {}]), '2 Termine heute · 3 ungelesen (Gmail) · 1 Fehler seit gestern · 2 neue Dateien ohne Platz · 1 Server läuft');
  assert.strictEqual(summaryText(cockpit({}), null), '0 Server laufen');
});

test('Einstellungen: Morgen-Mitteilung speichern, ungültige Uhrzeit bleibt beim alten Wert', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-morgen-')), 'settings.json');
  const s = new Settings(file);
  assert.deepStrictEqual(s.get().morning, { enabled: false, time: '08:00' });
  s.update({ morning: { enabled: true, time: '07:30' } });
  s.update({ morning: { time: '25:00' } });
  s.update({ theme: 'dark' });
  assert.deepStrictEqual(new Settings(file).get().morning, { enabled: true, time: '07:30' });
});

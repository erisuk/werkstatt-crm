// Tests für die Webseiten-Tabs: Adressen prüfen, speichern, Ungelesene, Browser-Kennung.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PortalStore, normalizeUrl, unreadFromTitle, chromeUserAgent, chromeOverride, sanitize, MAX_PORTALS } = require('../src/portals');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-portale-')), 'portals.json');

test('Adressen: https wird ergänzt, nur echte Webadressen kommen durch', () => {
  assert.strictEqual(normalizeUrl('outlook.com'), 'https://outlook.com/');
  assert.strictEqual(normalizeUrl(' https://mail.google.com/mail/u/0 '), 'https://mail.google.com/mail/u/0');
  assert.strictEqual(normalizeUrl('http://localhost:3000'), 'http://localhost:3000/');
  for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'mail.google .com', 'ftp://x.de', 'nurwort',
    'https://ich:geheim@bank.de', `https://${'a'.repeat(2100)}.de`, null]) {
    assert.strictEqual(normalizeUrl(bad), null, String(bad).slice(0, 40));
  }
});

test('Ungelesene werden aus dem Seitentitel gelesen', () => {
  assert.strictEqual(unreadFromTitle('Posteingang (3) - eris@gmail.com - Gmail'), 3);
  assert.strictEqual(unreadFromTitle('(12) WhatsApp'), 12);
  assert.strictEqual(unreadFromTitle('Outlook'), 0);
  assert.strictEqual(unreadFromTitle(undefined), 0);
});

test('Browser-Kennung ohne Electron und App-Namen, damit Google und Microsoft die Anmeldung erlauben', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) zentrale/0.2.0 Chrome/146.0.7680.31 Electron/44.9.1 Safari/537.36';
  const clean = chromeUserAgent(ua);
  assert.ok(!/Electron|zentrale/i.test(clean));
  assert.match(clean, /Chrome\/146\.0\.7680\.31 Safari\/537\.36$/);
});

test('Seiten anlegen, umbenennen, entfernen – und nach dem Neustart wieder da', () => {
  const file = tmpFile();
  const store = new PortalStore(file);
  const a = store.add('Gmail', 'https://mail.google.com/');
  const b = store.add('', 'outlook.com');
  assert.ok(a.ok && b.ok);
  assert.strictEqual(b.portal.name, 'outlook.com');
  assert.strictEqual(store.get().active, b.portal.id);
  assert.strictEqual(store.add('X', 'kaputt').ok, false);
  store.rename(a.portal.id, 'Mail privat');
  store.setActive(a.portal.id);
  const again = new PortalStore(file);
  assert.deepStrictEqual(again.get().portals.map((p) => p.name), ['Mail privat', 'outlook.com']);
  assert.strictEqual(again.get().active, a.portal.id);
  again.remove(a.portal.id);
  assert.strictEqual(new PortalStore(file).get().active, b.portal.id);
});

test('Die zuletzt besuchte Stelle wird gemerkt – aber nur auf derselben Website', () => {
  const file = tmpFile();
  const store = new PortalStore(file);
  const { portal } = store.add('Outlook', 'https://outlook.live.com/mail/');
  store.remember(portal.id, 'https://outlook.live.com/mail/0/inbox');
  store.remember(portal.id, 'https://login.live.com/oauth?x=1'); // Anmeldeseite einer anderen Website
  store.save();
  assert.strictEqual(new PortalStore(file).get().portals[0].lastUrl, 'https://outlook.live.com/mail/0/inbox');
});

test('Kaputte oder fremde Daten in der Datei richten keinen Schaden an', () => {
  const list = sanitize([null, 'x', { url: 'javascript:alert(1)' }, { id: '../../x', name: 'A'.repeat(99), url: 'https://a.de' },
    { url: 'https://b.de', lastUrl: 'https://evil.de/x' }]);
  assert.strictEqual(list.length, 2);
  assert.notStrictEqual(list[0].id, '../../x');
  assert.strictEqual(list[0].name.length, 40);
  assert.strictEqual(list[1].lastUrl, null);
  assert.strictEqual(sanitize(Array.from({ length: 50 }, (_, i) => ({ url: `https://s${i}.de` }))).length, MAX_PORTALS);
  const file = tmpFile();
  fs.writeFileSync(file, '{kaputt');
  assert.deepStrictEqual(new PortalStore(file).get(), { portals: [], active: null });
});

test('Mehrere Konten: eigener Speicher je Konto, alte Tabs bleiben im Standard-Konto', () => {
  const { partitionFor, profileOf } = require('../src/portals');
  assert.strictEqual(partitionFor('standard'), 'persist:portale');
  assert.strictEqual(partitionFor('konto-2'), 'persist:portale-konto-2');
  assert.strictEqual(profileOf('../böse'), 'standard');
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ portals: [{ id: 'alt', name: 'Gmail', url: 'https://mail.google.com/' }] }));
  const store = new PortalStore(file);
  assert.strictEqual(store.get().portals[0].profile, 'standard');
  assert.strictEqual(store.nextProfile(), 'konto-2');
  const res = store.add('Gmail', 'https://mail.google.com/', 'konto-2');
  assert.strictEqual(res.portal.profile, 'konto-2');
  assert.strictEqual(res.portal.name, 'Gmail');
  assert.deepStrictEqual(store.profiles(), ['standard', 'konto-2']);
  assert.strictEqual(store.nextProfile(), 'konto-3');
});

test('BIT AI News: eigenes Konto „bit“, getrennter Anmelde-Speicher', () => {
  const { BIT_TABS, BIT_PROFILE, partitionFor } = require('../src/portals');
  assert.strictEqual(partitionFor(BIT_PROFILE), 'persist:portale-bit');
  const store = new PortalStore(tmpFile());
  for (const t of BIT_TABS) assert.ok(store.add(t.name, t.url, BIT_PROFILE).ok);
  assert.deepStrictEqual(store.get().portals.map((p) => p.profile), ['bit', 'bit', 'bit']);
  assert.ok(store.profiles().includes('bit'));
  assert.strictEqual(store.nextProfile(), 'konto-2');
});

test('chromeOverride: Marken wie ein echtes Chrome (sonst sperrt Google die Anmeldung)', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36';
  const o = chromeOverride(ua);
  assert.strictEqual(o.userAgent, ua);
  assert.deepStrictEqual(o.userAgentMetadata.brands.map((b) => b.brand), ['Google Chrome', 'Chromium', 'Not?A_Brand']);
  assert.strictEqual(o.userAgentMetadata.brands[0].version, '152');
  assert.strictEqual(o.userAgentMetadata.fullVersion, '152.0.7977.167');
  assert.strictEqual(o.userAgentMetadata.platform, 'macOS');
  assert.strictEqual(o.userAgentMetadata.mobile, false);
});

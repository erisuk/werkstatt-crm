// Konten: erkannte Anmeldungen, eigene Angaben, und welche Konten ein Chat benutzt. Nie Passwörter.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const k = require('../src/konten');
const { chatKonten } = require('../src/renderer/konten-view');

const tabs = [
  { id: 't1', name: 'Gmail', url: 'https://mail.google.com/', profile: 'standard', title: 'Posteingang (3) - eris@example.com - Gmail' },
  { id: 't2', name: 'Bit · Instagram', url: 'https://www.instagram.com/', profile: 'bit', title: 'Instagram' },
  { id: 't3', name: 'muris69.myshopify.com', url: 'https://muris69.myshopify.com/', profile: 'standard', title: '' },
];
const mcp = [{ name: 'claude.ai Gmail', status: 'connected' }, { name: 'higgsfield', status: 'needs-auth' }, { name: 'google-workspace', status: 'connected' }];

test('Konten: Claude, Konnektoren, YouTube, n8n und Web-Tabs – E-Mail aus dem Tab-Titel erkannt', () => {
  const list = k.collect({ claude: { email: 'eris@example.com', org: 'Privat' }, tabs, mcp, youtube: { title: 'BIT AI News', handle: '@bitainews_de' }, n8n: true });
  const by = (key) => list.find((x) => x.key === key);
  assert.strictEqual(by('claude').konto, 'eris@example.com');
  assert.strictEqual(by('mcp:higgsfield').stand, 'anmelden');
  assert.strictEqual(by('mcp:claude.ai Gmail').dienst, 'Gmail');
  assert.strictEqual(by('youtube').konto, 'BIT AI News · @bitainews_de');
  assert.strictEqual(by('tab:t1').konto, 'eris@example.com');
  assert.strictEqual(by('tab:t1').stand, 'angemeldet');
  assert.strictEqual(by('tab:t2').stand, 'unbekannt');
  assert.match(by('tab:t2').wo, /Anmelde-Speicher „bit“/);
  assert.strictEqual(by('tab:t3').dienst, 'Shopify');
  assert.ok(list.every((x) => !/pass|token|secret/i.test(Object.keys(x).join(' '))), 'keine Geheimnis-Felder');
});

test('Konten: eigene Zuordnung und eigene Einträge – speichern, laden, entfernen, alte Daten bleiben unverändert', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'konten-')), 'konten.json');
  const empty = k.load(file);
  const a = k.assign(empty, 'tab:t2', '  @bit.ai.ger ');
  assert.deepStrictEqual(empty.zuordnung, {});
  const b = k.addOwn(a, { dienst: 'ElevenLabs', konto: 'eris@example.com', notiz: 'Starter-Abo' }, 'id1');
  assert.strictEqual(k.addOwn(b, { dienst: '  ' }, 'x'), b, 'ohne Dienst nichts');
  k.save(file, b);
  const loaded = k.load(file);
  assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600');
  const list = k.collect({ tabs, data: loaded });
  assert.strictEqual(list.find((x) => x.key === 'tab:t2').konto, '@bit.ai.ger');
  assert.strictEqual(list.find((x) => x.key === 'eigen:id1').wo, 'Starter-Abo');
  assert.deepStrictEqual(k.removeOwn(loaded, 'id1').eigene, []);
  assert.deepStrictEqual(k.assign(loaded, 'tab:t2', '').zuordnung, {}, 'leer = Zuordnung löschen');
  fs.writeFileSync(file, '{kaputt');
  assert.deepStrictEqual(k.load(file), { zuordnung: {}, eigene: [] });
});

test('Konten im Chat: Claude-Konto immer, dazu genau die benutzten Konnektoren und Web-Tabs', () => {
  const list = k.collect({ claude: { email: 'eris@example.com' }, tabs, mcp });
  const used = chatKonten([
    { tool: 'Bash' }, { tool: 'mcp__claude_ai_Gmail__search_threads' }, { tool: 'mcp__claude_ai_Gmail__get_thread' },
    { tool: 'mcp__web__zentrale_web_read', tab: 't2' }, { tool: 'mcp__chats__chats_liste' }, { tool: 'mcp__google-workspace__send_email' },
  ], list);
  assert.deepStrictEqual(used.map((x) => x.key), ['claude', 'mcp:claude.ai Gmail', 'tab:t2', 'mcp:google-workspace']);
  assert.deepStrictEqual(chatKonten([{ tool: 'mcp__web__zentrale_web_read' }], list).map((x) => x.key), ['claude', 'web']);
});

test('Konten: Dienst aus der Adresse, E-Mail aus Text', () => {
  assert.strictEqual(k.serviceOf('https://studio.youtube.com/'), 'YouTube');
  assert.strictEqual(k.serviceOf('https://business.facebook.com/'), 'Meta Business');
  assert.strictEqual(k.serviceOf('https://beispiel.de/x'), 'beispiel.de');
  assert.strictEqual(k.serviceOf('kein link'), null);
  assert.strictEqual(k.emailIn('Inbox – a.b+c@firma.co.uk – Outlook'), 'a.b+c@firma.co.uk');
  assert.strictEqual(k.emailIn('Instagram'), '');
});

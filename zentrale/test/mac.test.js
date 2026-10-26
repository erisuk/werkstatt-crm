// Tests für die Mac-Anbindung mit nachgebildetem osascript.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

process.env.ZENTRALE_OSASCRIPT = path.join(__dirname, 'fake-osascript.js');
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osa-')), 'osa.log');
process.env.FAKE_OSA_LOG = LOG;

const test = require('node:test');
const assert = require('node:assert');
const mac = require('../src/mac');
const { TOOLS, READ_ONLY_TOOLS } = require('../src/mcp/mac-server');

test('Kalender und Erinnerungen werden gelesen', async () => {
  const cal = await mac.calendarEvents(1);
  assert.strictEqual(cal.ok, true);
  assert.strictEqual(cal.data[0].title, 'Zahnarzt');
  const rem = await mac.reminders();
  assert.deepStrictEqual(rem.data, [{ title: 'Milch kaufen', list: 'Einkauf', due: null }]);
});

test('Eingaben gehen als Parameter, nie in den Skripttext', async () => {
  fs.writeFileSync(LOG, '');
  const evil = '"); Application("Finder").delete(); ("';
  const res = await mac.addReminder(evil, '2026-10-27T09:00', 'Einkauf');
  assert.strictEqual(res.ok, true);
  const params = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
  assert.deepStrictEqual(params, [evil, '2026-10-27T09:00', 'Einkauf']);
  assert.ok(!mac.SCRIPTS.addReminder.includes('Finder'));
});

test('ungültige Eingaben werden abgelehnt', async () => {
  assert.strictEqual((await mac.addReminder('')).ok, false);
  assert.match((await mac.addReminder('x', 'kein datum')).error, /ungültig/);
  assert.strictEqual((await mac.createNote('')).ok, false);
});

test('fehlende Mac-Rechte werden verständlich erklärt', async () => {
  process.env.FAKE_OSA_DENY = '1';
  try {
    const res = await mac.calendarEvents(1);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Kalender noch nicht steuern.*Automation/);
  } finally {
    delete process.env.FAKE_OSA_DENY;
  }
});

test('Outlook ohne Mac-Steuerung bekommt einen Hinweis auf den Browser-Weg', async () => {
  const res = await mac.outlookUnread(5);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /neue Outlook.*Chrome/);
});

test('today() sammelt alles, auch wenn einzelne Apps scheitern', async () => {
  const t = await mac.today();
  assert.strictEqual(t.events.ok, true);
  assert.strictEqual(t.mail.data.running, false);
  assert.strictEqual(t.outlook.ok, false);
});

test('MCP-Server: Lese-Werkzeuge ohne Rückfrage, Aktionen mit Rückfrage', () => {
  assert.deepStrictEqual(READ_ONLY_TOOLS.sort(), ['calendar_events', 'mail_unread', 'notes_search', 'notify', 'outlook_unread', 'reminders_list', 'spotlight_search']);
  for (const t of TOOLS) assert.ok(t.inputSchema && t.inputSchema.type === 'object', t.name);
});

test('MCP-Server spricht JSON-RPC über stdin/stdout', async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'mac-server.js')], { env: process.env });
  const replies = new Map();
  readline.createInterface({ input: proc.stdout }).on('line', (l) => { const m = JSON.parse(l); replies.set(m.id, m); });
  const send = (m) => proc.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'reminders_list', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gibtsnicht' } });
  send({ jsonrpc: '2.0', id: 5, method: 'gibtsnicht' });
  const end = Date.now() + 5000;
  while (replies.size < 5 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  proc.kill();
  assert.strictEqual(replies.get(1).result.serverInfo.name, 'zentrale-mac');
  assert.strictEqual(replies.get(2).result.tools.length, TOOLS.length);
  assert.match(replies.get(3).result.content[0].text, /Milch kaufen/);
  assert.strictEqual(replies.get(3).result.isError, false);
  assert.strictEqual(replies.get(4).error.code, -32602);
  assert.strictEqual(replies.get(5).error.code, -32601);
});

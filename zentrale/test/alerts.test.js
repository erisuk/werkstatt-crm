// Tests für die Fehler-Meldungen: ausgefallene Server und fehlgeschlagene n8n-Workflows.
const test = require('node:test');
const assert = require('node:assert');
const { AlertWatch, isWatched } = require('../src/alerts');

const srv = (port, extra = {}) => ({ port, pid: port * 10, proc: 'node', title: `App ${port}`, system: false, ...extra });

test('Nur wichtige Server werden beobachtet', () => {
  assert.ok(isWatched(srv(3000, { startedByZentrale: true })));
  assert.ok(isWatched(srv(4310, { launchd: true })));
  assert.ok(isWatched(srv(8788)));
  assert.ok(!isWatched(srv(5173)));
  assert.ok(!isWatched(srv(54627, { launchd: true, self: true })), 'eigene Anmelde-Rückleitung der Zentrale ist kein Server');
  assert.ok(!isWatched(srv(5000, { system: true, launchd: true })));
});

test('Server-Ausfall wird erst beim zweiten Fehlen gemeldet, bewusstes Stoppen gar nicht', async () => {
  let list = [srv(4310, { launchd: true }), srv(3000, { startedByZentrale: true }), srv(5173)];
  const sent = [];
  const a = new AlertWatch({ listServers: async () => list, notify: (t, b, v) => sent.push({ t, b, v }) });
  await a.checkServers();
  list = [srv(5173)];
  a.expectStop(3000);
  await a.checkServers();
  assert.strictEqual(sent.length, 0, 'nach einmal Fehlen noch kein Alarm');
  await a.checkServers();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].b, /App 4310 auf Port 4310/);
  assert.strictEqual(sent[0].v, 'projects');
  await a.checkServers();
  assert.strictEqual(sent.length, 1, 'nur einmal melden');
  assert.strictEqual(a.get().length, 1);
});

test('Kurzer Neustart (neue Prozess-ID, gleicher Port) ist kein Ausfall', async () => {
  let list = [srv(4310, { launchd: true })];
  const sent = [];
  const a = new AlertWatch({ listServers: async () => list, notify: (t) => sent.push(t) });
  await a.checkServers();
  list = [];
  await a.checkServers();
  list = [srv(4310, { launchd: true, pid: 999 })];
  await a.checkServers();
  list = [];
  await a.checkServers();
  assert.strictEqual(sent.length, 0);
});

test('n8n: alte Fehler beim Start nicht melden, neue Fehler mit Workflow-Namen', async () => {
  let execs = [{ id: '1', workflowId: 'w1', status: 'error' }, { id: '2', workflowId: 'w1', status: 'success' }];
  const sent = [];
  const a = new AlertWatch({ listServers: async () => [], listExecutions: async () => ({ ok: true, data: execs }),
    listWorkflows: async () => ({ ok: true, data: [{ id: 'w1', name: 'Bit Tagesvideo' }] }), notify: (t, b, v) => sent.push({ t, b, v }) });
  await a.checkN8n();
  assert.strictEqual(sent.length, 0);
  execs = [{ id: '3', workflowId: 'w1', status: 'error' }, { id: '4', workflowId: 'w2', status: 'success' }, ...execs];
  await a.checkN8n();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].b, /Bit Tagesvideo/);
  assert.strictEqual(sent[0].v, 'automations');
  await a.checkN8n();
  assert.strictEqual(sent.length, 1);
});

test('Ohne n8n-Schlüssel oder wenn n8n nicht läuft: still', async () => {
  const sent = [];
  const a = new AlertWatch({ listServers: async () => { throw new Error('lsof'); }, listExecutions: async () => ({ ok: false, error: 'aus' }),
    listWorkflows: async () => ({ ok: false }), notify: (t) => sent.push(t) });
  await a.check();
  const b = new AlertWatch({ listServers: async () => [], listExecutions: async () => null, notify: (t) => sent.push(t) });
  await b.check();
  assert.strictEqual(sent.length, 0);
});

test('n8n: ein Lauf, der beim ersten Blick noch läuft und dann scheitert, wird gemeldet', async () => {
  let execs = [{ id: '9', workflowId: 'w1', status: 'running' }];
  const sent = [];
  const a = new AlertWatch({ listServers: async () => [], listExecutions: async () => ({ ok: true, data: execs }),
    listWorkflows: async () => ({ ok: true, data: [] }), notify: (t) => sent.push(t) });
  await a.checkN8n();
  execs = [{ id: '9', workflowId: 'w1', status: 'error' }];
  await a.checkN8n();
  assert.strictEqual(sent.length, 1);
});

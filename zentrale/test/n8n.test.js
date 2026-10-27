// Tests für die n8n-Anbindung mit einem nachgebauten n8n (kein Netz, kein echtes n8n).
const test = require('node:test');
const assert = require('node:assert');
const { N8n, normalizeBase, cleanDefinition } = require('../src/n8n');
const { READ_ONLY_TOOLS } = require('../src/mcp/n8n-server');
const { describeApproval } = require('../src/claude');

// Merkt sich jede Anfrage und antwortet wie n8n.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const key = `${opts.method || 'GET'} ${new URL(url).pathname}`;
    const r = routes[key];
    if (r instanceof Error) throw r;
    const [status, body] = r || [404, { message: 'not found' }];
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

test('n8n: Workflows lesen, mit Schlüssel im Kopf', async () => {
  const fetchImpl = fakeFetch({ 'GET /api/v1/workflows': [200, { data: [
    { id: 'a1', name: 'Täglicher Witz', active: false, updatedAt: '2026-07-18T10:00:00Z', nodes: [{}, {}], tags: [{ name: 'Spaß' }] },
    { id: 'b2', name: 'Workflow-Builder', active: true, nodes: [] }] }] });
  const n = new N8n({ apiKey: 'k1', fetchImpl });
  const res = await n.listWorkflows();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.data[0], { id: 'a1', name: 'Täglicher Witz', active: false, updatedAt: '2026-07-18T10:00:00Z', nodes: 2, tags: ['Spaß'] });
  assert.strictEqual(fetchImpl.calls[0].headers['X-N8N-API-KEY'], 'k1');
  assert.strictEqual(fetchImpl.calls[0].url, 'http://localhost:5678/api/v1/workflows?limit=250');
});

test('n8n: verständliche Fehler ohne Schlüssel, bei falschem Schlüssel und wenn n8n nicht läuft', async () => {
  assert.match((await new N8n({ fetchImpl: fakeFetch({}) }).listWorkflows()).error, /Kein n8n-API-Schlüssel/);
  assert.match((await new N8n({ apiKey: 'x', fetchImpl: fakeFetch({ 'GET /api/v1/workflows': [401, {}] }) }).listWorkflows()).error, /lehnt den API-Schlüssel ab/);
  assert.match((await new N8n({ apiKey: 'x', fetchImpl: fakeFetch({ 'GET /api/v1/workflows': new Error('ECONNREFUSED') }) }).listWorkflows()).error, /nicht erreichbar/);
  assert.strictEqual((await new N8n({ fetchImpl: fakeFetch({ 'GET /healthz': [200, { status: 'ok' }] }) }).health()).ok, true);
  assert.strictEqual((await new N8n({ fetchImpl: fakeFetch({ 'GET /healthz': new Error('x') }) }).health()).ok, false);
});

test('n8n: neue Workflows werden nie eingeschaltet angelegt', async () => {
  const fetchImpl = fakeFetch({ 'POST /api/v1/workflows': [200, { id: 'n9', name: 'Neu' }] });
  const n = new N8n({ apiKey: 'k', fetchImpl });
  const res = await n.createWorkflow({ name: 'Neu', active: true, nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger' }], id: 'fremd', connections: {} });
  assert.strictEqual(res.ok, true);
  const body = fetchImpl.calls[0].body;
  assert.ok(!('active' in body) && !('id' in body));
  assert.deepStrictEqual(Object.keys(body).sort(), ['connections', 'name', 'nodes', 'settings']);
  assert.strictEqual((await n.createWorkflow({ name: '', nodes: [{}] })).ok, false);
  assert.strictEqual((await n.createWorkflow({ name: 'Leer', nodes: [] })).ok, false);
});

test('n8n: Ein-/Ausschalten und ungültige IDs', async () => {
  const fetchImpl = fakeFetch({ 'POST /api/v1/workflows/a1/activate': [200, { id: 'a1', active: true }], 'POST /api/v1/workflows/a1/deactivate': [200, {}] });
  const n = new N8n({ apiKey: 'k', fetchImpl });
  assert.strictEqual((await n.setActive('a1', true)).ok, true);
  assert.strictEqual((await n.setActive('a1', false)).ok, true);
  for (const bad of ['../x', 'a/b', '', null, 'x'.repeat(80)]) assert.strictEqual((await n.setActive(bad, true)).ok, false, String(bad));
  assert.strictEqual(fetchImpl.calls.length, 2);
});

test('n8n: Adresse prüfen, Editor-Link', () => {
  assert.strictEqual(normalizeBase('http://localhost:5678/home'), 'http://localhost:5678');
  assert.strictEqual(normalizeBase('javascript:alert(1)'), null);
  assert.strictEqual(normalizeBase('http://user:pw@x.de'), null);
  const n = new N8n({ baseUrl: 'https://n8n.example.de/' });
  assert.strictEqual(n.editorUrl('a1'), 'https://n8n.example.de/workflow/a1');
  assert.strictEqual(n.editorUrl(), 'https://n8n.example.de/home/workflows');
  assert.strictEqual(cleanDefinition(null).ok, false);
});

test('n8n-Werkzeuge: Lesen ohne Rückfrage, Anlegen/Ändern/Einschalten mit Freigabe und klarer Beschreibung', () => {
  assert.deepStrictEqual([...READ_ONLY_TOOLS].sort(), ['n8n_get_workflow', 'n8n_list_executions', 'n8n_list_workflows']);
  const create = describeApproval('mcp__n8n__n8n_create_workflow', { workflow: { name: 'Wetter', nodes: [
    { name: 'Jeden Morgen', type: 'n8n-nodes-base.scheduleTrigger' }, { name: 'Telegram', type: 'n8n-nodes-base.telegram' }] } });
  assert.strictEqual(create.title, 'Einen n8n-Workflow anlegen (ausgeschaltet)');
  assert.match(create.detail, /Name: Wetter\n2 Knoten: Jeden Morgen \(scheduleTrigger\), Telegram \(telegram\)/);
  const on = describeApproval('mcp__n8n__n8n_set_active', { id: 'a1', active: true });
  assert.strictEqual(on.title, 'Einen n8n-Workflow einschalten');
  assert.strictEqual(on.canAlways, false);
});

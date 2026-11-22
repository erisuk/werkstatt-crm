// Claude verwalten: Versionen vergleichen, Plugins lesen/suchen, nur gültige Plugin-Namen an die Kommandozeile.
const test = require('node:test');
const assert = require('node:assert');
const { createClaudeAdmin, older, parseVersion } = require('../src/claude-admin');

function fakeExec(answers) {
  const calls = [];
  const exec = async (bin, args) => { calls.push([bin, ...args].join(' ')); const k = Object.keys(answers).find((x) => [bin, ...args].join(' ').includes(x)); return answers[k] || { ok: true, out: '', err: '' }; };
  return { exec, calls };
}

test('Versionen: Update erkannt, gleich = aktuell, ohne Netz kein falscher Alarm', async () => {
  assert.strictEqual(older('2.1.329', '2.1.330'), true);
  assert.strictEqual(older('2.2.0', '2.1.999'), false);
  assert.strictEqual(parseVersion('2.1.329 (Claude Code)'), '2.1.329');
  const f = fakeExec({ '--version': { ok: true, out: '2.1.329 (Claude Code)' }, 'view': { ok: true, out: '2.1.330\n' } });
  const a = createClaudeAdmin({ claude: () => 'claude', env: () => ({}), exec: f.exec });
  const v = await a.versions();
  assert.deepStrictEqual([v.installed, v.latest, v.update], ['2.1.329', '2.1.330', true]);
  const off = createClaudeAdmin({ claude: () => 'claude', env: {}, exec: fakeExec({ '--version': { ok: true, out: '2.1.329' }, 'view': { ok: false, out: '', err: 'offline' } }).exec });
  const w = await off.versions();
  assert.deepStrictEqual([w.update, w.offline], [false, true]);
});

test('Plugins: Liste, Suche im Marktplatz, Aktionen nur mit gültigem Namen', async () => {
  const f = fakeExec({
    'list --json --available': { ok: true, out: JSON.stringify({ installed: [], available: [{ pluginId: 'telegram@official', name: 'telegram', description: 'Chat' }, { pluginId: 'figma@official', name: 'figma', description: 'Design' }] }) },
    'list --json': { ok: true, out: JSON.stringify([{ id: 'wix@synced', version: '1.0', enabled: false, scope: 'synced' }]) },
  });
  const a = createClaudeAdmin({ claude: () => 'claude', env: {}, exec: f.exec });
  assert.deepStrictEqual((await a.plugins()).data, [{ id: 'wix@synced', version: '1.0', enabled: false, scope: 'synced' }]);
  assert.deepStrictEqual((await a.search('tele')).data.map((p) => p.id), ['telegram@official']);
  assert.strictEqual((await a.action('enable', 'wix@synced')).ok, true);
  assert.ok(f.calls.includes('claude plugin enable wix@synced'));
  assert.strictEqual((await a.action('enable', 'x; rm -rf ~')).ok, false, 'kein Befehl im Namen');
  assert.strictEqual((await a.action('löschen', 'wix@synced')).ok, false, 'unbekannte Aktion');
});

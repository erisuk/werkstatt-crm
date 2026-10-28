// Tests für „Projekte & Server“: Erkennen, Schutz, Starten und Stoppen (mit einem echten Mini-Server).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const S = require('../src/servers');

test('lsof-Ausgabe: Ports je Prozess, v4/v6 nur einmal', () => {
  const out = S.parseLsof('p100\ncnode\nn127.0.0.1:3000\nn[::1]:3000\np200\ncPython\nn*:8788\n');
  assert.deepStrictEqual(out.map((x) => `${x.pid}:${x.proc}:${x.port}`), ['100:node:3000', '200:Python:8788']);
});

test('Projekt aus Ordner oder Befehl, Laufzeit lesbar', () => {
  const home = os.homedir();
  assert.strictEqual(S.projectOf(`${home}/gold-desk`, 'python -m x').name, 'gold-desk');
  assert.strictEqual(S.projectOf(home, `/usr/local/bin/node ${home}/steuer-assistent/src/server.ts`).name, 'steuer-assistent');
  assert.strictEqual(S.etimeToText('05:10'), '5 Min.');
  assert.strictEqual(S.etimeToText('2-03:00:00'), '2 Tage');
  assert.strictEqual(S.etimeToText('03:00:00'), '3 Std.');
});

test('Geschützt: Trading-Port, Handelsbrücke, Claude und die Zentrale selbst', () => {
  assert.match(S.protectedReason({ pid: 5, port: 8788, proc: 'Python', cmd: 'x' }), /Trading-Bot/);
  assert.ok(S.protectedReason({ pid: 5, port: 9000, proc: 'wine', cmd: 'terminal64.exe mt5' }));
  assert.ok(S.protectedReason({ pid: 5, port: 9001, proc: 'node', cmd: '/x/claude --mcp' }));
  assert.match(S.protectedReason({ pid: 42, port: 9002, proc: 'x', cmd: 'y' }, [42]), /Zentrale selbst/);
  assert.strictEqual(S.protectedReason({ pid: 5, port: 3000, proc: 'node', cmd: 'vite' }), null);
});

test('Startbefehl-Vorschläge aus dem Projekt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'node .' } }));
  assert.deepStrictEqual(S.suggestCommands(dir), ['npm run dev', 'npm run start']);
});

test('Starten prüft Eingaben', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
  assert.strictEqual(S.startServer({ dir: '/gibt/es/nicht', command: 'x', logDir }).ok, false);
  assert.strictEqual(S.startServer({ dir: os.tmpdir(), command: '', logDir }).ok, false);
  assert.strictEqual(S.startServer({ dir: os.tmpdir(), command: 'a\nrm -rf x', logDir }).ok, false);
  assert.strictEqual(S.startServer({ dir: os.tmpdir(), command: 'x', port: 80, logDir }).ok, false);
  assert.match(S.startServer({ dir: os.tmpdir(), command: 'x', port: 8788, logDir }).error, /Trading-Bot/);
});

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('Echter Server: starten, in der Liste finden, genau diesen Prozess stoppen', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<title>Mini-Testserver</title>ok');
  const port = await freePort();
  const res = S.startServer({ dir, command: `python3 -m http.server ${port} --bind 127.0.0.1`, env: process.env, logDir: path.join(dir, 'logs') });
  assert.strictEqual(res.ok, true);
  let found = null;
  for (let i = 0; i < 40 && !found; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    found = (await S.listServers({})).find((s) => s.port === port);
  }
  assert.ok(found, 'Server nicht gefunden');
  assert.strictEqual(found.title, 'Mini-Testserver');
  assert.strictEqual(found.project, path.basename(fs.realpathSync(dir)));
  assert.strictEqual(found.protected, null);
  const stop = await S.stopServer(found);
  assert.strictEqual(stop.ok, true);
  assert.ok(!(await S.listServers({})).some((s) => s.port === port));
  assert.match(S.readLog(res.data.log).data, /Serving HTTP|GET \//);
});

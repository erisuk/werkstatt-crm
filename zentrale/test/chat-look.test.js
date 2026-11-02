const test = require('node:test');
const assert = require('node:assert');
const { stepSummary, lastImage, serverName } = require('../src/renderer/step-summary');
const { parseCommits, parsePr, createChatEnv } = require('../src/chat-env');

test('Schritte als Satz wie in der Claude-App', () => {
  assert.strictEqual(stepSummary([{ tool: 'Bash' }, { tool: 'Bash', error: true }]), 'Ausgeführt 2 Befehle (1 fehlgeschlagen)');
  assert.strictEqual(stepSummary([{ tool: 'Bash' }, { tool: 'Read', detail: 'v19_ui.png' }]), 'Ausgeführt einen Befehl, las v19_ui.png');
  assert.strictEqual(stepSummary([{ tool: 'Read', detail: 'a.js' }, { tool: 'Read', detail: 'b.js' }, { tool: 'Read', detail: 'c.js' }]), 'Las 3 Dateien');
  assert.strictEqual(stepSummary([{ tool: 'Edit', detail: 'app.js' }, { tool: 'Edit', detail: 'app.js' }]), 'Bearbeitete app.js');
  assert.strictEqual(stepSummary([{ tool: 'Grep', detail: 'TODO' }]), 'Suchte nach „TODO“');
  assert.strictEqual(stepSummary([{ tool: 'mcp__claude_ai_Gmail__search_threads' }, { tool: 'mcp__mac__calendar_events' }, { tool: 'mcp__mac__run_applescript' }]),
    'Nutzte Gmail, nutzte Mac (2×)');
  assert.strictEqual(stepSummary([]), '');
});

test('Bildvorschau: nur das zuletzt gelesene Bild', () => {
  assert.strictEqual(lastImage([{ tool: 'Read', path: '/a/x.png' }, { tool: 'Read', path: '/a/b.js' }, { tool: 'Read', path: '/a/y.JPG' }]), '/a/y.JPG');
  assert.strictEqual(lastImage([{ tool: 'Write', path: '/a/x.png' }]), null);
  assert.strictEqual(serverName('mcp__google-workspace__list_events'), 'Google Workspace');
  assert.strictEqual(serverName('mcp__plugin_wix_wix-mcp__X'), 'Wix Mcp');
});

test('Umgebung: Commits, PR und Zwischenspeicher', async () => {
  assert.deepStrictEqual(parseCommits('abc123 feat: neu\ndef456 fix: alt\n'), [{ hash: 'abc123', subject: 'feat: neu' }, { hash: 'def456', subject: 'fix: alt' }]);
  assert.strictEqual(parsePr('{"number":13,"title":"t","url":"https://evil.example/x"}'), null);
  assert.deepStrictEqual(parsePr('{"number":13,"title":"t","url":"https://github.com/a/b/pull/13","state":"OPEN"}'),
    { number: 13, title: 't', url: 'https://github.com/a/b/pull/13', state: 'OPEN' });
  let calls = 0;
  let clock = 0;
  const answers = { 'rev-parse --show-toplevel': '/x/repo', 'rev-parse --abbrev-ref HEAD': 'main', 'log --oneline -3': 'a1 eins' };
  const env = createChatEnv({ now: () => clock, exec: async (bin, args) => { calls += 1; return bin === 'gh' ? null : answers[args.join(' ')] ?? null; } });
  const first = await env('/x/repo/src');
  assert.strictEqual(first.branch, 'main');
  assert.strictEqual(first.repo, 'repo');
  assert.deepStrictEqual(first.commits, [{ hash: 'a1', subject: 'eins' }]);
  const n = calls;
  await env('/x/repo/src');
  assert.strictEqual(calls, n, 'innerhalb einer Minute aus dem Zwischenspeicher');
  clock = 61000;
  await env('/x/repo/src');
  assert.ok(calls > n);
  const none = createChatEnv({ exec: async () => null });
  assert.deepStrictEqual(await none('/tmp/kein-git'), { cwd: '/tmp/kein-git', folder: 'kein-git', git: false });
});

test('Füllstand eines gespeicherten Gesprächs: letzte Antwort des Hauptchats, Unteragenten zählen nicht', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { lastContext } = require('../src/sessions');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuellstand-'));
  const file = path.join(dir, 's.jsonl');
  const usage = (n) => ({ input_tokens: 1, cache_read_input_tokens: n, cache_creation_input_tokens: 0 });
  fs.writeFileSync(file, [
    { type: 'assistant', message: { content: [], usage: usage(1000) } },
    { type: 'assistant', message: { content: [], usage: usage(5000) } },
    { type: 'assistant', isSidechain: true, message: { content: [], usage: usage(99999) } },
    { type: 'user', message: { content: 'weiter' } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  assert.strictEqual(lastContext(file), 5001);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'nur Frage' } }));
  assert.strictEqual(lastContext(file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

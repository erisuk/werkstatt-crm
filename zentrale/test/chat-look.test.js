const test = require('node:test');
const assert = require('node:assert');
const { stepSummary, lastImage, serverName } = require('../src/renderer/step-summary');
const { parseCommits, parsePr, createChatEnv } = require('../src/chat-env');

test('Schritte als Satz wie in der Claude-App', () => {
  assert.strictEqual(stepSummary([{ tool: 'Bash' }, { tool: 'Bash', error: true }]), 'Ausgeführt 2 Befehle (1 fehlgeschlagen)');
  assert.strictEqual(stepSummary([{ tool: 'Bash' }, { tool: 'Read', detail: 'v19_ui.png' }]), 'Ausgeführt einen Befehl, las v19_ui.png');
  assert.strictEqual(stepSummary([{ tool: 'AskUserQuestion', detail: 'Welche Farbe?' }]), 'Fragte dich');
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

test('Bildschirmsteuerung: Tastendrücke per osascript, cliclick, CGEvent oder Bildschirm-Werkzeug werden erkannt', () => {
  const { toolStep, controlsScreen } = require('../src/tool-steps');
  assert.strictEqual(toolStep('Bash', { command: `osascript -e 'tell application "System Events" to keystroke "x"'` }).screen, true);
  assert.strictEqual(toolStep('Bash', { command: 'uv run python klick.py 1 2 # CGEventPost' }).screen, true);
  assert.strictEqual(toolStep('Bash', { command: 'cliclick c:10,10' }).screen, true);
  assert.strictEqual(controlsScreen('mcp__computer-use__app_click', {}), true);
  assert.strictEqual(toolStep('Bash', { command: 'ls -la' }).screen, undefined);
  assert.strictEqual(toolStep('Bash', { command: 'osascript -e \'tell application "Labelnize" to activate\'' }).screen, undefined, 'nur App nach vorn holen tippt nichts');
  assert.strictEqual(toolStep('Read', { file_path: '/x/System Events.txt' }).screen, undefined);
});

test('Live-Text: Bruchstücke werden zu „delta“, Unteragenten und andere Ereignisse nicht', () => {
  const { simplify } = require('../src/claude');
  const ev = (delta, extra = {}) => ({ type: 'stream_event', api_message_id: 'm1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 2, delta }, ...extra });
  assert.deepStrictEqual(simplify(ev({ type: 'text_delta', text: 'Ulm li' })), [{ kind: 'delta', text: 'Ulm li', key: 'm1:2' }]);
  assert.deepStrictEqual(simplify(ev({ type: 'input_json_delta', partial_json: '{"a' })), []);
  assert.deepStrictEqual(simplify(ev({ type: 'text_delta', text: 'x' }, { parent_tool_use_id: 'toolu_1' })), []);
  assert.deepStrictEqual(simplify({ type: 'stream_event', event: { type: 'message_start' } }), []);
});

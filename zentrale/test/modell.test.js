// Modell und Denktiefe je Chat: gehen als --model/--effort an Claude, Wechsel gilt ab der nächsten Nachricht.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeChat } = require('../src/claude');

const FAKE = path.join(__dirname, 'fake-claude.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastArgs = (log) => JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
const val = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

test('Modell: Standard ohne Schalter, gewähltes Modell und Denktiefe beim nächsten Start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modell-'));
  const log = path.join(dir, 'args.log');
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_ARGS_LOG: log }, cwd: os.tmpdir() });
  try {
    chat.start();
    await wait(300);
    assert.strictEqual(val(lastArgs(log), '--model'), null, 'Standard: Claude Code entscheidet');
    chat.setModel('claude-fable-5-2', 'high');
    assert.strictEqual(chat.needsRestart, true);
    await chat.send('hallo');
    await wait(400);
    assert.strictEqual(val(lastArgs(log), '--model'), 'claude-fable-5-2');
    assert.strictEqual(val(lastArgs(log), '--effort'), 'high');
  } finally {
    await chat.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

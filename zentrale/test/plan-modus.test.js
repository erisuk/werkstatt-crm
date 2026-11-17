// Plan-Modus: startet mit --permission-mode plan, der Plan wartet auf Eris – auch bei „Ohne Rückfrage arbeiten“.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeChat } = require('../src/claude');

const FAKE = path.join(__dirname, 'fake-claude.js');
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };

test('Plan-Modus: Start mit plan, Plan als Karte, ändern und annehmen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const log = path.join(dir, 'args.log');
  const chat = new ClaudeChat({ bin: FAKE, env: { ...process.env, FAKE_ARGS_LOG: log }, cwd: os.tmpdir(), allowAll: () => true, askQuestions: true });
  const texts = [];
  chat.on('event', (e) => { if (e.kind === 'text') texts.push(e.text); });
  try {
    chat.setPlanMode(true);
    await chat.send('PLAN:Datei anlegen');
    assert.ok(await waitFor(() => fs.existsSync(log)));
    const args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
    const [a] = chat.pendingApprovals();
    assert.strictEqual(a.kind, 'plan');
    assert.match(a.plan, /Datei anlegen/);
    chat.allowPending();
    assert.strictEqual(chat.pendingApprovals().length, 1, '„Ohne Rückfrage“ nimmt keinen Plan an');
    assert.strictEqual(chat.answerPlan(a.id, false, 'Bitte zwei Dateien'), true);
    assert.ok(await waitFor(() => texts.some((t) => t.startsWith('deny:') && t.includes('Bitte zwei Dateien'))));
    assert.strictEqual(chat.planMode, true, 'abgelehnt: bleibt im Plan-Modus');
    await chat.send('PLAN:Zwei Dateien');
    assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
    assert.strictEqual(chat.respond(chat.pendingApprovals()[0].id, 'allow'), true);
    assert.ok(await waitFor(() => texts.some((t) => t.startsWith('allow:'))));
    assert.strictEqual(chat.planMode, false, 'angenommen: Plan-Modus aus');
  } finally {
    await chat.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
// Nachbildung der claude-Kommandozeile für Tests.
const readline = require('readline');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const delay = Number(process.env.FAKE_DELAY || 0);
if (process.env.FAKE_ARGS_LOG) require('fs').appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args) + '\n');

if (process.env.FAKE_FAIL) {
  process.stderr.write('Error: No conversation found with session ID x\n');
  process.exit(3);
}

if (args.includes('--input-format')) {
  const sid = opt('--session-id') || opt('--resume');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    const text = msg.message.content[0].text;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
    setTimeout(() => {
      out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: `echo:${process.pid}:${text}` }] } });
      out({ type: 'result', session_id: sid, is_error: false, result: 'ok' });
    }, delay);
  });
} else {
  const dash = args.indexOf('--');
  const prompt = dash >= 0 ? args[dash + 1] : null;
  if (!prompt) { process.stderr.write("error: unknown option\n"); process.exit(1); }
  setTimeout(() => process.stdout.write(JSON.stringify({ result: `ok:${prompt}`, is_error: false })), delay);
}

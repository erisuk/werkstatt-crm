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

if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write('Checking MCP server health…\n\n'
    + 'claude.ai Gmail: https://gmail.mcp.claude.com/mcp (HTTP) - ✓ Connected\n'
    + 'plugin:x:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication\n'
    + 'mac: /usr/bin/node /x/mac-server.js - ✓ Connected\n');
  process.exit(0);
}

const sid = opt('--session-id') || opt('--resume');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let waiting = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_response') {
    if (waiting && msg.response.request_id === waiting.id) {
      const allowed = msg.response.response.behavior === 'allow';
      const done = waiting.done;
      waiting = null;
      done(allowed ? `erlaubt:${msg.response.response.updatedInput.command}` : 'abgelehnt');
    }
    return;
  }
  const text = msg.message.content[0].text;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
  const answer = (reply) => {
    out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', session_id: sid, is_error: false, result: 'ok' });
  };
  if (text.startsWith('ZURUECK:')) {
    const id = `req-cancel-${Date.now()}`;
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    setTimeout(() => { out({ type: 'control_cancel_request', request_id: id }); answer('zurückgezogen'); }, 200);
    return;
  }
  if (text.startsWith('FREIGABE:')) {
    const command = text.slice('FREIGABE:'.length);
    const id = `req-${process.pid}-${Date.now()}`;
    waiting = { id, done: answer };
    out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, description: 'Test' } });
    return;
  }
  setTimeout(() => answer(`echo:${process.pid}:${text}`), delay);
});

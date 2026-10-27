// Gemeinsamer Kern der MCP-Server der Zentrale: JSON-RPC 2.0 zeilenweise über stdin/stdout.
const readline = require('readline');

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// tools: [{ name, description, inputSchema, readOnly, run(args) → { ok, data | error } }]
function makeHandler(tools, serverName) {
  return async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
      });
    }
    if (id === undefined) return; // Benachrichtigungen brauchen keine Antwort
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      return reply(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly } })) });
    }
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === (params && params.name));
      if (!tool) return fail(id, -32602, `Unbekanntes Werkzeug: ${params && params.name}`);
      let res;
      try { res = await tool.run((params && params.arguments) || {}); } catch (e) { res = { ok: false, error: e.message }; }
      const text = res.ok ? JSON.stringify(res.data === undefined ? 'ok' : res.data, null, 1) : res.error;
      const content = [{ type: 'text', text }];
      if (res.ok && typeof res.image === 'string') content.push({ type: 'image', data: res.image, mimeType: 'image/png' });
      return reply(id, { content, isError: !res.ok });
    }
    return fail(id, -32601, `Methode nicht unterstützt: ${method}`);
  };
}

function serve(tools, serverName) {
  const handle = makeHandler(tools, serverName);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
  });
}

module.exports = { makeHandler, serve };

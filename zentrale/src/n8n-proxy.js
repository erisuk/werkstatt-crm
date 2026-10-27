// Vermittlung zwischen Claudes n8n-Werkzeugen und n8n. Läuft im Hauptprozess der Zentrale:
// Der API-Schlüssel verlässt ihn nie – weder in eine Datei noch in Claudes Umgebung, wo jeder
// ausgeführte Befehl ihn lesen könnte. Der MCP-Server ruft nur diese Unix-Socket-Schnittstelle auf.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_BODY = 2 * 1024 * 1024;
// Knoten, die Code ausführen, ins Internet senden oder von außen auslösbar sind.
const RISKY_NODE = /(code|function|executecommand|ssh|httprequest|webhook|ftp|sftp)$/i;
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|auth|bearer|credential|private[-_]?key|cookie)/i;

// Eigener Anschluss je Benutzer und Datenordner: zwei Zentralen kommen sich so nicht in die Quere.
// (Kurz gehalten, weil Unix-Sockets höchstens ~100 Zeichen Pfad erlauben.)
function socketPath(dataDir = '', service = 'n8n') {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'x';
  const tag = crypto.createHash('sha256').update(String(dataDir)).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `zentrale-${service}-${uid}-${tag}.sock`);
}

// Ersetzt Werte geheimer Felder (auch in Kopfzeilen-Listen wie { name: 'Authorization', value: … }).
function redact(value, depth = 0) {
  if (depth > 40 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  const namedSecret = typeof value.name === 'string' && SECRET_KEY.test(value.name);
  for (const [k, v] of Object.entries(value)) {
    if ((SECRET_KEY.test(k) && typeof v !== 'object') || (namedSecret && k === 'value')) out[k] = '••• geschwärzt •••';
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

function riskyNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter((n) => n && RISKY_NODE.test(String(n.type || '').split('.').pop()))
    .map((n) => `${n.name || '?'} (${String(n.type || '').split('.').pop()})`);
}

// Neue Workflows bekommen keine Zugangsdaten; bei Änderungen nur die, die ein gleichnamiger Knoten schon hatte.
function stripCredentials(nodes, previous = []) {
  const before = new Map((Array.isArray(previous) ? previous : []).map((n) => [n && n.name, n && n.credentials]));
  return (Array.isArray(nodes) ? nodes : []).map((n) => {
    if (!n || typeof n !== 'object') return n;
    const { credentials, ...rest } = n;
    const keep = before.get(n.name);
    return keep ? { ...rest, credentials: keep } : rest;
  });
}

// ops: was der MCP-Server darf. client(): ein N8n-Client mit Schlüssel.
function makeOps(client) {
  return {
    listWorkflows: () => client().listWorkflows(),
    listExecutions: (a) => client().listExecutions(a && a.limit),
    getWorkflow: async (a) => {
      const res = await client().getWorkflow(a && a.id);
      return res.ok ? { ok: true, data: redact(res.data) } : res;
    },
    createWorkflow: async (a) => {
      const def = a && a.workflow && typeof a.workflow === 'object' ? a.workflow : null;
      if (!def) return { ok: false, error: 'Workflow-Definition fehlt.' };
      const res = await client().createWorkflow({ ...def, nodes: stripCredentials(def.nodes) });
      if (!res.ok) return res;
      const id = res.data && String(res.data.id);
      return { ok: true, data: { id, name: res.data && res.data.name, active: false, link: client().editorUrl(id),
        hinweis: 'Ausgeschaltet und ohne Zugangsdaten angelegt. Zugangsdaten verbindet der Nutzer selbst in n8n.' } };
    },
    updateWorkflow: async (a) => {
      const id = a && a.id;
      const def = a && a.workflow && typeof a.workflow === 'object' ? a.workflow : null;
      if (!def) return { ok: false, error: 'Workflow-Definition fehlt.' };
      const current = await client().getWorkflow(id);
      if (!current.ok) return current;
      // Ein eingeschalteter Workflow würde die Änderung sofort ausführen – erst ausschalten lassen.
      if (current.data && current.data.active) {
        return { ok: false, error: 'Dieser Workflow ist eingeschaltet. Schalte ihn zuerst mit n8n_set_active (active: false) aus, ändere ihn dann und schalte ihn danach wieder ein.' };
      }
      return client().updateWorkflow(id, { ...def, nodes: stripCredentials(def.nodes, current.data && current.data.nodes) });
    },
    setActive: (a) => client().setActive(a && a.id, !!(a && a.active === true)),
  };
}

// Startet die Schnittstelle. Nur dieser Benutzer darf sie öffnen (Rechte 0600).
function startProxy(ops, file = socketPath()) {
  try { fs.unlinkSync(file); } catch {}
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/call') return send(404, { ok: false, error: 'Unbekannt.' });
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > MAX_BODY) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send(400, { ok: false, error: 'Ungültige Anfrage.' }); }
      const op = msg && typeof msg.op === 'string' && Object.prototype.hasOwnProperty.call(ops, msg.op) ? ops[msg.op] : null;
      if (!op) return send(400, { ok: false, error: 'Unbekannte Aktion.' });
      try { send(200, await op(msg.args || {})); } catch (e) { send(200, { ok: false, error: e.message }); }
    });
  });
  server.listen(file, () => { try { fs.chmodSync(file, 0o600); } catch {} });
  server.on('error', () => {});
  return { server, file, close: () => { try { server.close(); } catch {} try { fs.unlinkSync(file); } catch {} } };
}

// Für den MCP-Server: ruft eine Aktion über die Schnittstelle auf.
function callProxy(op, args, file = process.env.ZENTRALE_N8N_SOCKET || socketPath(), timeout = 30000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ op, args });
    const req = http.request({ socketPath: file, path: '/call', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false, error: 'Unerwartete Antwort der Zentrale.' }); } });
    });
    req.on('error', () => resolve({ ok: false, error: 'Die Zentrale ist nicht erreichbar – diese Werkzeuge gehen nur, solange sie läuft.' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Keine rechtzeitige Antwort.' }); });
    req.end(body);
  });
}

module.exports = { startProxy, callProxy, makeOps, redact, riskyNodes, stripCredentials, socketPath };

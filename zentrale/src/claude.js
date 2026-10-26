// Startet Claude Code als Hintergrundprozess und spricht mit ihm über stream-json.
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Apps, die aus dem Finder gestartet werden, kennen den PATH der Shell nicht.
// Darum holen wir ihn einmal aus der Login-Shell und suchen dort nach `claude`.
function resolveClaude() {
  const env = { ...process.env };
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'echo "__PATH__$PATH"'], { timeout: 8000 }).toString();
    const line = out.split('\n').find((l) => l.startsWith('__PATH__'));
    if (line) env.PATH = line.slice('__PATH__'.length);
  } catch {
    // Kein Problem: dann prüfen wir unten die üblichen Orte.
  }
  const home = os.homedir();
  const candidates = [
    ...(env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'claude')),
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  const bin = candidates.find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  });
  let version = null;
  if (bin) {
    try { version = execFileSync(bin, ['--version'], { env, timeout: 15000 }).toString().trim(); } catch {}
  }
  return { bin: bin || null, env, version };
}

// Kurze Beschreibung eines Werkzeugaufrufs, z. B. "Edit · src/app.js".
function describeTool(name, input) {
  const i = input || {};
  const detail = i.file_path || i.path || i.command || i.pattern || i.url || i.query || i.description || '';
  return detail ? `${name} · ${String(detail).split('\n')[0].slice(0, 90)}` : name;
}

// Wandelt ein rohes stream-json-Ereignis in eine einfache Liste für die Oberfläche um.
function simplify(ev) {
  if (!ev || typeof ev !== 'object') return [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    return [{ kind: 'init', sessionId: ev.session_id, model: ev.model || null }];
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const out = [];
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', text: describeTool(b.name, b.input) });
    }
    return out;
  }
  if (ev.type === 'result') {
    return [{ kind: 'result', isError: !!ev.is_error, text: ev.is_error ? String(ev.result || 'Fehler') : null, sessionId: ev.session_id }];
  }
  return [];
}

class ClaudeChat extends EventEmitter {
  constructor({ bin, env, cwd, resume = null, permissionMode = 'acceptEdits', title = null }) {
    super();
    this.bin = bin;
    this.env = env;
    this.cwd = cwd;
    this.resume = resume;
    this.sessionId = resume;
    this.permissionMode = permissionMode;
    this.title = title;
    this.status = 'stopped';
    this.proc = null;
    this.stderr = '';
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  start() {
    if (this.alive) return;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', this.permissionMode];
    if (this.sessionId) args.push('--resume', this.sessionId);
    this.stderr = '';
    const proc = spawn(this.bin, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.setStatus('ready');

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) this.sessionId = ev.session_id;
      for (const item of simplify(ev)) this.emit('event', item);
      if (ev.type === 'result') this.setStatus('ready');
    });
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
    proc.on('error', (err) => {
      this.emit('event', { kind: 'result', isError: true, text: `Claude konnte nicht starten: ${err.message}` });
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (code && this.stderr.trim()) {
        this.emit('event', { kind: 'result', isError: true, text: this.stderr.trim().split('\n').slice(-3).join('\n') });
      }
      this.setStatus('stopped');
    });
  }

  send(text) {
    if (!this.alive) this.start();
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    this.setStatus('busy');
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try { proc.stdin.end(); } catch {}
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 3000);
    proc.once('exit', () => clearTimeout(timer));
    this.setStatus('stopped');
  }
}

// Führt einen einzelnen Auftrag ohne Unterhaltung aus (für tägliche Aufgaben).
function runOnce({ bin, env, cwd, prompt, permissionMode = 'acceptEdits' }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const proc = spawn(bin, ['-p', prompt, '--output-format', 'json', '--permission-mode', permissionMode],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    proc.on('error', (e) => resolve({ ok: false, text: e.message }));
    proc.on('exit', (code) => {
      let text = '';
      try { text = JSON.parse(out).result || ''; } catch { text = out.trim(); }
      resolve({ ok: code === 0, text: code === 0 ? text : (err.trim() || text || `Exit-Code ${code}`) });
    });
  });
}

module.exports = { resolveClaude, ClaudeChat, simplify, describeTool, runOnce };

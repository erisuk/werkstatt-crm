// Startet Claude Code als Hintergrundprozess und spricht mit ihm über stream-json.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function execText(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Liest den PATH der Login-Shell. Die Marker machen das robust gegen Ausgaben aus .zshrc & Co.
async function loginShellPath() {
  const shell = process.env.SHELL || '/bin/zsh';
  const out = await execText(shell, ['-ilc', 'echo __ZPATH__; /usr/bin/printenv PATH; echo __ZEND__'], { timeout: 8000 });
  if (!out) return null;
  const a = out.indexOf('__ZPATH__');
  const b = out.indexOf('__ZEND__', a);
  if (a < 0 || b < 0) return null;
  const value = out.slice(a + '__ZPATH__'.length, b).trim();
  return value.includes('/') ? value : null;
}

// Variablen einer umgebenden Claude-Code-Sitzung dürfen nicht an unsere Kindprozesse gehen,
// sonst schreiben sie in die falsche Sitzung.
function cleanEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key === 'CLAUDECODE' || /^CLAUDE_CODE_(SESSION|ENTRYPOINT|SSE_PORT)/.test(key)) delete out[key];
  }
  return out;
}

// Apps, die aus dem Finder gestartet werden, kennen den PATH der Shell nicht.
// Darum holen wir ihn aus der Login-Shell und suchen dort nach `claude`.
async function resolveClaude() {
  const env = cleanEnv(process.env);
  const shellPath = await loginShellPath();
  const home = os.homedir();
  const fallbacks = [path.join(home, '.claude', 'local'), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const dirs = [...new Set([...(shellPath || env.PATH || '').split(':').filter(Boolean), ...fallbacks])];
  const bin = dirs.map((d) => path.join(d, 'claude')).find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  }) || null;
  if (bin) dirs.unshift(path.dirname(bin));
  env.PATH = [...new Set(dirs)].join(':');
  const version = bin ? ((await execText(bin, ['--version'], { env, timeout: 15000 })) || '').trim() || null : null;
  return { bin, env, version };
}

// Beendet einen Prozess samt allen Unterprozessen (Bash, MCP-Server …).
function killTree(proc, signal) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try { process.kill(-proc.pid, signal); } catch {
    try { proc.kill(signal); } catch {}
  }
}

// Wartet, bis ein Prozess beendet ist; drängt nach und nach stärker.
function terminate(proc, { interrupt = false } = {}) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
    const timers = [];
    proc.once('exit', () => { timers.forEach(clearTimeout); resolve(); });
    killTree(proc, interrupt ? 'SIGINT' : 'SIGTERM');
    timers.push(setTimeout(() => killTree(proc, 'SIGTERM'), 1500));
    timers.push(setTimeout(() => killTree(proc, 'SIGKILL'), 4000));
    timers.push(setTimeout(resolve, 5000));
  });
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
  if (ev.type === 'result' && ev.is_error) {
    const details = typeof ev.result === 'string' ? ev.result : (Array.isArray(ev.errors) ? ev.errors.join('\n') : '');
    return [{ kind: 'error', text: 'Claude hat einen Fehler gemeldet.', details: details || null }];
  }
  return [];
}

// Übersetzt eine Absturz-Ausgabe in eine verständliche deutsche Meldung.
function explainExit(stderr) {
  if (/No conversation found/i.test(stderr)) return 'Dieses Gespräch konnte nicht fortgesetzt werden.';
  if (/log ?in|auth|credential|API key/i.test(stderr)) return 'Claude ist nicht angemeldet. Starte einmal „claude“ im Terminal und melde dich an.';
  return 'Claude wurde unerwartet beendet.';
}

const clip = (s, n = 2000) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)} …` : t; };

// Beschreibt eine Freigabe-Anfrage in einfachen Worten: was will Claude tun, und womit?
function describeApproval(toolName, input, description) {
  const i = input && typeof input === 'object' ? input : {};
  const name = String(toolName || '');
  const json = () => clip(JSON.stringify(i, null, 2));
  if (name === 'Bash') return { title: 'Einen Befehl im Terminal ausführen', detail: clip(i.command) };
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return { title: 'Eine Datei außerhalb des Projekts ändern', detail: clip(i.file_path || i.notebook_path) };
  if (name === 'WebFetch') return { title: 'Eine Webseite abrufen', detail: clip(i.url) };
  if (name === 'WebSearch') return { title: 'Im Internet suchen', detail: clip(i.query) };
  if (name === 'mcp__mac__run_applescript') return { title: 'Den Mac per Skript steuern', detail: clip(i.script) };
  if (name === 'mcp__mac__open') return { title: 'Etwas auf dem Mac öffnen', detail: clip(i.target) };
  if (name === 'mcp__mac__reminders_add') return { title: 'Eine Erinnerung anlegen', detail: clip(`${i.title || ''}${i.due ? ` · fällig ${i.due}` : ''}`) };
  if (name === 'mcp__mac__notes_create') return { title: 'Eine Notiz anlegen', detail: clip(`${i.title || ''}\n\n${i.body || ''}`) };
  if (/chrome/i.test(name)) return { title: 'Chrome bedienen', detail: json() };
  if (/mail|outlook|gmail/i.test(name) && /send|reply|forward/i.test(name)) {
    const to = [].concat(i.to || i.recipient || i.recipients || []).join(', ');
    return { title: 'Eine E-Mail senden', detail: clip(`${to ? `An: ${to}\n` : ''}${i.subject ? `Betreff: ${i.subject}\n\n` : ''}${i.body || i.content || i.text || ''}`) || json() };
  }
  if (/draft/i.test(name)) return { title: 'Einen Mail-Entwurf anlegen', detail: json() };
  if (/delete|trash|remove/i.test(name)) return { title: 'Etwas löschen', detail: json() };
  const label = name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name;
  return { title: description ? clip(description, 140) : `Werkzeug „${label}“ benutzen`, detail: json() };
}

// Für Befehle und Skripte gilt "immer erlauben" nur für genau diesen Inhalt, sonst für das ganze Werkzeug.
function approvalKey(toolName, input) {
  const i = input || {};
  if (toolName === 'Bash') return `Bash:${i.command}`;
  if (toolName === 'mcp__mac__run_applescript') return `script:${i.script}`;
  return toolName;
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

class ClaudeChat extends EventEmitter {
  constructor({ bin, env, cwd, resume = null, permissionMode = 'acceptEdits', title = null,
    projectsRoot = PROJECTS_ROOT, extraArgs = () => [] }) {
    super();
    this.bin = bin;
    this.env = env;
    this.cwd = cwd;
    // Neue Chats bekommen ihre Gesprächs-ID sofort, damit sie von Anfang an feststeht.
    this.sessionId = resume || crypto.randomUUID();
    this.resumed = !!resume;
    this.projectsRoot = projectsRoot;
    this.permissionMode = permissionMode;
    this.extraArgs = extraArgs;
    this.title = title;
    this.status = 'stopped';
    this.proc = null;
    this.stderr = '';
    this.exiting = null;
    this.pending = 0;
    this.disposed = false;
    this.approvals = new Map();
    this.alwaysAllow = new Set();
  }

  // Fortsetzen geht nur, wenn Claude Code das Gespräch schon gespeichert hat.
  sessionSaved() {
    if (this.resumed) return true;
    try {
      return fs.readdirSync(this.projectsRoot).some((d) => fs.existsSync(path.join(this.projectsRoot, d, `${this.sessionId}.jsonl`)));
    } catch {
      return false;
    }
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  pendingApprovals() {
    return [...this.approvals.values()].map(({ id, tool, title, detail, createdAt }) => ({ id, tool, title, detail, createdAt }));
  }

  clearApprovals() {
    if (!this.approvals.size) return;
    this.approvals.clear();
    this.emit('approvals');
  }

  write(obj) {
    if (!this.alive || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  // Steueranfragen der Kommandozeile: Freigaben landen bei uns, alles andere lehnen wir höflich ab.
  handleControl(ev) {
    const req = ev.request || {};
    if (req.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: 'Nicht unterstützt' } });
      return;
    }
    const key = approvalKey(req.tool_name, req.input);
    if (this.alwaysAllow.has(key)) {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id,
        response: { behavior: 'allow', updatedInput: req.input || {} } } });
      return;
    }
    const { title, detail } = describeApproval(req.tool_name, req.input, req.description);
    this.approvals.set(ev.request_id, { id: ev.request_id, tool: req.tool_name, title, detail, key, input: req.input || {}, createdAt: Date.now() });
    this.emit('approvals');
  }

  // decision: 'allow' | 'always' | 'deny'
  respond(id, decision) {
    const a = this.approvals.get(id);
    if (!a) return false;
    this.approvals.delete(id);
    const allow = decision === 'allow' || decision === 'always';
    if (decision === 'always') this.alwaysAllow.add(a.key);
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id,
      response: allow ? { behavior: 'allow', updatedInput: a.input }
        : { behavior: 'deny', message: 'Der Nutzer hat das in der Zentrale abgelehnt.' } } });
    this.emit('approvals');
    return true;
  }

  start() {
    if (this.alive || this.disposed) return;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', this.permissionMode, '--permission-prompt-tool', 'stdio'];
    args.push(this.sessionSaved() ? '--resume' : '--session-id', this.sessionId);
    args.push(...(this.extraArgs() || []));
    this.stderr = '';
    this.pending = 0;
    this.clearApprovals();
    let proc;
    try {
      proc = spawn(this.bin, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      this.emit('event', { kind: 'error', text: 'Claude konnte nicht starten.', details: err.message });
      this.setStatus('error');
      return;
    }
    this.proc = proc;
    this.intentional = false;
    this.setStatus('ready');

    // Alle Handler prüfen, ob sie noch zum aktuellen Prozess gehören.
    const current = () => this.proc === proc;
    proc.stdin.on('error', () => {});
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!current()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'control_request') { this.handleControl(ev); return; }
      if (ev.session_id) this.sessionId = ev.session_id;
      for (const item of simplify(ev)) this.emit('event', item);
      // Erst "bereit", wenn alle gesendeten Nachrichten beantwortet sind.
      if (ev.type === 'result') {
        this.pending = Math.max(0, this.pending - 1);
        if (this.pending === 0) this.setStatus('ready');
      }
    });
    proc.stderr.on('data', (d) => { if (current()) this.stderr = (this.stderr + d.toString()).slice(-4000); });
    proc.on('error', (err) => {
      if (!current()) return;
      this.proc = null;
      this.clearApprovals();
      this.emit('event', { kind: 'error', text: 'Claude konnte nicht starten.', details: err.message });
      this.setStatus('error');
    });
    proc.on('exit', (code, signal) => {
      if (!current()) return;
      this.proc = null;
      this.clearApprovals();
      if (this.intentional || code === 0) { this.setStatus('stopped'); return; }
      const details = this.stderr.trim().split('\n').slice(-6).join('\n') || (signal ? `Signal ${signal}` : `Exit-Code ${code}`);
      this.emit('event', { kind: 'error', text: explainExit(this.stderr), details });
      this.setStatus('error');
    });
  }

  async send(text) {
    if (this.disposed) return false;
    if (this.exiting) await this.exiting;
    // Wurde der Chat inzwischen ersetzt, darf er nicht wieder starten.
    if (this.disposed) return false;
    if (!this.alive || !this.proc.stdin.writable) this.start();
    if (!this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })) return false;
    this.pending += 1;
    this.setStatus('busy');
    return true;
  }

  // Endgültig beenden: der Chat startet danach nie wieder.
  dispose() {
    this.disposed = true;
    const done = this.stop();
    this.removeAllListeners();
    return done;
  }

  // Bricht die laufende Arbeit ab. Der nächste send() setzt dasselbe Gespräch fort.
  stop({ interrupt = false } = {}) {
    const proc = this.proc;
    if (!proc) return this.exiting || Promise.resolve();
    this.intentional = true;
    this.clearApprovals();
    try { proc.stdin.end(); } catch {}
    this.exiting = terminate(proc, { interrupt }).then(() => {
      if (this.proc === proc) this.proc = null;
      this.exiting = null;
      this.setStatus('stopped');
    });
    return this.exiting;
  }
}

const runningTasks = new Set();
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

// Führt einen einzelnen Auftrag aus (für tägliche Aufgaben). Läuft wie ein Chat, damit
// Freigaben genauso in der Zentrale landen. onApproval(chat) meldet neue Rückfragen.
function runTask({ bin, env, cwd, prompt, extraArgs, onApproval, timeoutMs = TASK_TIMEOUT_MS, projectsRoot }) {
  return new Promise((resolve) => {
    const chat = new ClaudeChat({ bin, env, cwd, extraArgs, projectsRoot });
    const texts = [];
    let error = null;
    let sent = false;
    let finished = false;
    runningTasks.add(chat);
    const finish = (res) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      runningTasks.delete(chat);
      chat.dispose();
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, text: 'Abgebrochen: Die Aufgabe lief länger als 30 Minuten.' }), timeoutMs);
    chat.on('event', (ev) => {
      if (ev.kind === 'text') texts.push(ev.text);
      else if (ev.kind === 'error') error = ev;
    });
    chat.on('approvals', () => { if (onApproval) onApproval(chat); });
    chat.on('status', (s) => {
      if (!sent) return;
      const fail = () => [error && error.text, error && error.details].filter(Boolean).join('\n');
      if (s === 'ready') finish(error ? { ok: false, text: fail() } : { ok: true, text: texts[texts.length - 1] || '' });
      else if (s === 'error' || s === 'stopped') finish({ ok: false, text: fail() || 'Claude wurde beendet.' });
    });
    chat.send(prompt).then((ok) => {
      sent = true;
      if (!ok) finish({ ok: false, text: (error && error.details) || 'Claude konnte nicht gestartet werden.' });
      else if (chat.status !== 'busy') chat.emit('status', chat.status);
    });
  });
}

function stopAllTasks() {
  return Promise.all([...runningTasks].map((c) => c.dispose()));
}

// Liest `claude mcp list` und gibt die eingerichteten Verbindungen zurück.
function parseMcpList(output) {
  const out = [];
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim();
    const sep = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (sep <= 0 || dash <= sep) continue;
    const name = line.slice(0, sep);
    const statusText = line.slice(dash + 3).trim();
    let status = 'unknown';
    if (/fail|error/i.test(statusText)) status = 'failed';
    else if (/connected/i.test(statusText)) status = 'connected';
    else if (/auth/i.test(statusText)) status = 'auth';
    else if (/not configured|disabled|pending/i.test(statusText)) status = 'off';
    out.push({ name, target: line.slice(sep + 2, dash).trim(), status, statusText: statusText.replace(/^[^\w]+/, '') });
  }
  return out;
}

async function listMcpServers({ bin, env, cwd }) {
  const out = await execText(bin, ['mcp', 'list'], { env, cwd, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  return out === null ? null : parseMcpList(out);
}

module.exports = {
  resolveClaude, cleanEnv, ClaudeChat, simplify, describeTool, describeApproval, approvalKey,
  runTask, stopAllTasks, terminate, parseMcpList, listMcpServers,
};

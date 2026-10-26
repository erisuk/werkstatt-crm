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
  if (/No conversation found/i.test(stderr)) return 'Diese Sitzung konnte nicht fortgesetzt werden.';
  if (/log ?in|auth|credential|API key/i.test(stderr)) return 'Claude ist nicht angemeldet. Starte einmal „claude“ im Terminal und melde dich an.';
  return 'Claude wurde unerwartet beendet.';
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

class ClaudeChat extends EventEmitter {
  constructor({ bin, env, cwd, resume = null, permissionMode = 'acceptEdits', title = null, projectsRoot = PROJECTS_ROOT }) {
    super();
    this.bin = bin;
    this.env = env;
    this.cwd = cwd;
    // Neue Chats bekommen ihre Sitzungs-ID sofort, damit sie von Anfang an feststeht.
    this.sessionId = resume || crypto.randomUUID();
    this.resumed = !!resume;
    this.projectsRoot = projectsRoot;
    this.permissionMode = permissionMode;
    this.title = title;
    this.status = 'stopped';
    this.proc = null;
    this.stderr = '';
    this.exiting = null;
    this.pending = 0;
    this.disposed = false;
  }

  // Fortsetzen geht nur, wenn Claude Code die Sitzung schon gespeichert hat.
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

  start() {
    if (this.alive || this.disposed) return;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', this.permissionMode];
    args.push(this.sessionSaved() ? '--resume' : '--session-id', this.sessionId);
    this.stderr = '';
    this.pending = 0;
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
      this.emit('event', { kind: 'error', text: 'Claude konnte nicht starten.', details: err.message });
      this.setStatus('error');
    });
    proc.on('exit', (code, signal) => {
      if (!current()) return;
      this.proc = null;
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
    if (!this.alive) return false;
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    this.pending += 1;
    this.setStatus('busy');
    return true;
  }

  // Endgültig beenden: der Chat startet danach nie wieder.
  dispose() {
    this.disposed = true;
    this.removeAllListeners();
    return this.stop();
  }

  // Bricht die laufende Arbeit ab. Der nächste send() setzt dieselbe Sitzung fort.
  stop({ interrupt = false } = {}) {
    const proc = this.proc;
    if (!proc) return this.exiting || Promise.resolve();
    this.intentional = true;
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

// Führt einen einzelnen Auftrag ohne Unterhaltung aus (für tägliche Aufgaben).
function runOnce({ bin, env, cwd, prompt, permissionMode = 'acceptEdits', timeoutMs = TASK_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let proc;
    try {
      // Der Auftrag steht nach "--", damit ein Text wie "- Fasse zusammen" keine Option ist.
      proc = spawn(bin, ['-p', '--output-format', 'json', '--permission-mode', permissionMode, '--', prompt],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ ok: false, text: e.message });
      return;
    }
    runningTasks.add(proc);
    const timer = setTimeout(() => { err += '\nAbgebrochen: Die Aufgabe lief länger als 30 Minuten.'; terminate(proc); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    let finished = false;
    const done = (res) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      runningTasks.delete(proc);
      resolve(res);
    };
    proc.on('error', (e) => done({ ok: false, text: e.message }));
    // 'close' statt 'exit': dann ist die Ausgabe sicher vollständig gelesen.
    proc.on('close', (code) => {
      let text = '';
      let isError = false;
      try { const j = JSON.parse(out); text = j.result || ''; isError = !!j.is_error; } catch { text = out.trim(); }
      const ok = code === 0 && !isError;
      done({ ok, text: ok ? text : (err.trim() || text || `Exit-Code ${code}`) });
    });
  });
}

function stopAllTasks() {
  return Promise.all([...runningTasks].map((p) => terminate(p)));
}

module.exports = { resolveClaude, cleanEnv, ClaudeChat, simplify, describeTool, runOnce, stopAllTasks, terminate };

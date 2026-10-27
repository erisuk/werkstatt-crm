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

const MAX_DETAIL = 50000;

// Alles, was oben noch nicht gezeigt wurde, kommt vollständig darunter – nichts wird verschwiegen.
function moreFields(i, shown) {
  const rest = {};
  for (const [k, v] of Object.entries(i)) if (!shown.includes(k) && k !== 'description') rest[k] = v;
  return Object.keys(rest).length ? `\n\nWeitere Angaben:\n${JSON.stringify(rest, null, 2)}` : '';
}

const asText = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : JSON.stringify(v));

// Beschreibt eine Freigabe-Anfrage in einfachen Worten: was will Claude tun, und womit?
// canAlways: ob "Immer erlauben" angeboten wird (nie bei Senden, Löschen oder Chrome).
function describeApproval(toolName, input, description) {
  const i = input && typeof input === 'object' ? input : {};
  const name = String(toolName || '');
  let title;
  let summary = '';
  let shown = [];
  let canAlways = true;
  const field = (k) => (i[k] == null || i[k] === '' ? '' : asText(i[k]));
  if (name === 'Bash') {
    title = 'Einen Befehl im Terminal ausführen'; summary = field('command'); shown = ['command'];
  } else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) {
    title = 'Eine Datei ändern'; summary = field('file_path') || field('notebook_path'); shown = ['file_path', 'notebook_path'];
  } else if (name === 'WebFetch') {
    title = 'Eine Webseite abrufen'; summary = field('url'); shown = ['url'];
  } else if (name === 'WebSearch') {
    title = 'Im Internet suchen'; summary = field('query'); shown = ['query'];
  } else if (name === 'mcp__mac__run_applescript') {
    title = 'Den Mac per Skript steuern'; summary = field('script'); shown = ['script'];
  } else if (name === 'mcp__mac__open') {
    title = 'Etwas auf dem Mac öffnen'; summary = field('target'); shown = ['target'];
  } else if (name === 'mcp__mac__reminders_add') {
    title = 'Eine Erinnerung anlegen'; summary = `${field('title')}${i.due ? ` · fällig ${field('due')}` : ''}`; shown = ['title', 'due'];
  } else if (name === 'mcp__mac__notes_create') {
    title = 'Eine Notiz anlegen'; summary = `${field('title')}\n\n${field('body')}`.trim(); shown = ['title', 'body'];
  } else if (/chrome/i.test(name)) {
    title = 'Chrome bedienen'; canAlways = false;
  } else if (/mail|outlook|gmail/i.test(name) && /send|reply|forward/i.test(name)) {
    title = 'Eine E-Mail senden'; canAlways = false;
    const labels = [['to', 'An'], ['recipient', 'An'], ['recipients', 'An'], ['cc', 'Kopie'], ['bcc', 'Blindkopie'],
      ['subject', 'Betreff'], ['attachments', 'Anhänge']];
    summary = labels.filter(([k]) => field(k)).map(([k, l]) => `${l}: ${field(k)}`).join('\n');
    const body = field('body') || field('content') || field('text');
    if (body) summary += `${summary ? '\n\n' : ''}${body}`;
    shown = [...labels.map(([k]) => k), 'body', 'content', 'text'];
  } else if (/delete|trash|remove/i.test(name)) {
    title = 'Etwas löschen'; canAlways = false;
  } else if (/draft/i.test(name)) {
    title = 'Einen Mail-Entwurf anlegen';
  } else {
    // Der Titel kommt nie von Claude selbst, sonst könnte eine Aktion harmloser klingen, als sie ist.
    const label = name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name;
    title = `Werkzeug „${label}“ benutzen`;
    if (description) summary = `Claude sagt dazu: ${String(description).slice(0, 300)}`;
  }
  const fallbackDetail = Object.keys(i).length ? JSON.stringify(i, null, 2) : '';
  let detail = summary && shown.length ? `${summary}${moreFields(i, shown)}`
    : [summary, fallbackDetail].filter(Boolean).join('\n\n');
  const truncated = detail.length > MAX_DETAIL;
  if (truncated) detail = `${detail.slice(0, MAX_DETAIL)}\n\n… zu lang, um alles anzuzeigen. Deshalb kann das nur abgelehnt werden.`;
  return { title, detail, canAlways: canAlways && !truncated, truncated };
}

// Schlüssel mit sortierten Feldern, damit dieselbe Aktion immer gleich aussieht.
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// "Immer erlauben" gilt nur für genau diese Aktion mit genau diesen Angaben.
function approvalKey(toolName, input) {
  return `${toolName}:${stableJson(input || {})}`;
}

// Dateien ohne Rückfrage ändern darf Claude nur in einem echten Projektordner – nie im Benutzerordner,
// darüber, in ~/Library oder in Systemordnern. Dort fragt die Zentrale vor jeder Änderung.
function permissionModeFor(cwd, home = os.homedir()) {
  const dir = path.resolve(String(cwd || '/'));
  const h = path.resolve(home);
  const rel = dir.startsWith(h + path.sep) ? dir.slice(h.length + 1).split(path.sep) : [];
  const unsafe = dir === path.parse(dir).root
    || dir === h
    || h.startsWith(dir + path.sep)
    || dir === path.join(h, 'Library') || dir.startsWith(path.join(h, 'Library') + path.sep)
    // Sammelordner selbst (nicht ihre Unterordner) und versteckte Ordner wie ~/.claude oder ~/.ssh
    || (rel.length === 1 && /^(desktop|documents|downloads|pictures|movies|music|public)$/i.test(rel[0]))
    || rel.some((part) => part.startsWith('.'))
    || /^\/(System|Library|Applications|usr|bin|sbin|etc|private|var|opt|Volumes)(\/|$)/.test(dir) && !dir.startsWith(h + path.sep);
  return unsafe ? 'default' : 'acceptEdits';
}

// Die Erlaubnisliste in ~/.claude/settings.json (z. B. "Bash(python3 *)") würde sonst an der Zentrale
// vorbeilaufen. "ask"-Regeln schlagen "allow"-Regeln: so landet jeder Befehl in der Zentrale.
// Im Projektordner bleiben Dateiänderungen ohne Rückfrage, sonst fragt auch jede Änderung.
// WebSearch gehört dazu: Eine Suchanfrage kann sonst gelesene Geheimnisse unbemerkt nach außen tragen.
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
function safetySettings(permissionMode) {
  const ask = ['Bash', 'WebFetch', 'WebSearch', 'mcp__claude-in-chrome', 'mcp__Claude_in_Chrome'];
  if (permissionMode !== 'acceptEdits') ask.push(...EDIT_TOOLS);
  // Auch im Projektordner: Einstellungen, Hooks und Git-Interna nie ohne Rückfrage ändern.
  else for (const t of EDIT_TOOLS) ask.push(`${t}(**/.claude/**)`, `${t}(**/.git/**)`, `${t}(**/.mcp.json)`);
  return JSON.stringify({ permissions: { ask } });
}

// Reine Lese-Befehle winkt die Zentrale selbst durch. Streng: ein einziger Befehl aus der Liste,
// ohne Verkettung, Umleitung oder eingebettete Befehle.
// Bewusst nicht dabei: rg (--pre startet Programme), tree (-o schreibt), file (-C schreibt),
// date (stellt die Uhr) und git (führt Befehle aus der Repo-Konfiguration aus).
const READ_ONLY_COMMANDS = new Set(['ls', 'pwd', 'whoami', 'cat', 'head', 'tail', 'wc', 'grep',
  'stat', 'which', 'echo', 'du', 'df', 'basename', 'dirname', 'realpath', 'uname', 'sw_vers']);

// true nur für einen einzelnen Lese-Befehl, dessen Pfade alle im Projektordner cwd liegen –
// so liest Claude ohne Rückfrage nie ~/.ssh, Tokens oder andere Projekte.
function isReadOnlyCommand(command, cwd) {
  const c = String(command || '').trim();
  if (!cwd || !c || c.length > 2000 || /[;&|<>`$(){}\\\n\r~*?[\]'"]/.test(c) || /[^\x20-\x7E -ɏ]/.test(c)) return false;
  const [bin, ...args] = c.split(/\s+/);
  if (!READ_ONLY_COMMANDS.has(bin)) return false;
  let root;
  try { root = fs.realpathSync.native(path.resolve(cwd)); } catch { return false; }
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  return args.filter((a) => !a.startsWith('-')).every((a) => {
    const p = path.resolve(root, a);
    if (!inside(p) || p.slice(root.length).split(path.sep).some((part) => part.length > 1 && part.startsWith('.'))) return false;
    // Verknüpfungen, die aus dem Projekt herauszeigen, zählen nicht als „im Projekt“.
    try { return inside(fs.realpathSync.native(p)); } catch { return true; }
  });
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

class ClaudeChat extends EventEmitter {
  constructor({ bin, env, cwd, resume = null, permissionMode = null, title = null,
    projectsRoot = PROJECTS_ROOT, extraArgs = () => [] }) {
    super();
    this.bin = bin;
    this.env = env;
    this.cwd = cwd;
    // Neue Chats bekommen ihre Gesprächs-ID sofort, damit sie von Anfang an feststeht.
    this.sessionId = resume || crypto.randomUUID();
    this.resumed = !!resume;
    this.projectsRoot = projectsRoot;
    this.permissionMode = permissionMode || permissionModeFor(cwd);
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
    return [...this.approvals.values()].map(({ id, tool, title, detail, canAlways, truncated, createdAt }) =>
      ({ id, tool, title, detail, canAlways, truncated, createdAt }));
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
    const readOnly = req.tool_name === 'Bash' && this.permissionMode === 'acceptEdits'
      && isReadOnlyCommand(req.input && req.input.command, this.cwd);
    if (readOnly || this.alwaysAllow.has(key)) {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id,
        response: { behavior: 'allow', updatedInput: req.input || {} } } });
      return;
    }
    const { title, detail, canAlways, truncated } = describeApproval(req.tool_name, req.input, req.description);
    this.approvals.set(ev.request_id, { id: ev.request_id, tool: req.tool_name, title, detail, canAlways, truncated, key,
      input: req.input || {}, createdAt: Date.now() });
    this.emit('approvals');
  }

  // decision: 'allow' | 'always' | 'deny'. Was nicht vollständig angezeigt werden konnte, lässt sich nur ablehnen.
  respond(id, decision) {
    const a = this.approvals.get(id);
    if (!a) return false;
    this.approvals.delete(id);
    const allow = (decision === 'allow' || decision === 'always') && !a.truncated;
    if (decision === 'always' && allow && a.canAlways) this.alwaysAllow.add(a.key);
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id,
      response: allow ? { behavior: 'allow', updatedInput: a.input }
        : { behavior: 'deny', message: 'Der Nutzer hat das in der Zentrale abgelehnt.' } } });
    this.emit('approvals');
    return true;
  }

  start() {
    if (this.alive || this.disposed) return;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', this.permissionMode, '--permission-prompt-tool', 'stdio',
      '--settings', safetySettings(this.permissionMode)];
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
      // Claude kann eine offene Rückfrage selbst zurückziehen.
      if (ev.type === 'control_cancel_request') {
        if (this.approvals.delete(ev.request_id)) this.emit('approvals');
        return;
      }
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
    // "close" statt "exit": erst wenn auch die letzte Ausgabe gelesen ist, sonst gingen Meldungen beim Absturz verloren.
    proc.on('close', (code, signal) => {
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
    // Neue Verbindungen (MCP, Chrome) gelten erst nach einem Neustart des Prozesses.
    if (this.needsRestart && this.alive && this.status !== 'busy') {
      this.needsRestart = false;
      await this.stop();
      if (this.disposed) return false;
    }
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
function runTask({ bin, env, cwd, prompt, extraArgs, onApproval, timeoutMs = TASK_TIMEOUT_MS, projectsRoot, permissionMode }) {
  return new Promise((resolve) => {
    const chat = new ClaudeChat({ bin, env, cwd, extraArgs, projectsRoot, permissionMode: permissionMode || permissionModeFor(cwd) });
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
    const timer = setTimeout(() => finish({ ok: false, text: chat.approvals.size
      ? 'Abgebrochen: Claude hat auf deine Freigabe gewartet, aber keine bekommen.'
      : 'Abgebrochen: Die Aufgabe lief länger als 30 Minuten.' }), timeoutMs);
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
  resolveClaude, cleanEnv, ClaudeChat, simplify, describeTool, describeApproval, approvalKey, permissionModeFor,
  safetySettings, isReadOnlyCommand,
  runTask, stopAllTasks, terminate, parseMcpList, listMcpServers,
};

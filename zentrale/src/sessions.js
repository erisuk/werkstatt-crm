// Liest die Sitzungen, die Claude Code unter ~/.claude/projects speichert.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { toolStep } = require('./tool-steps');

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_READ_BYTES = 20 * 1024 * 1024;

function readRange(file, bytes, fromEnd = false) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const readHead = (file) => readRange(file, HEAD_BYTES);

// Umbenennungen (/rename, Titel aus der Claude-App) hängt Claude Code ans Ende an – der letzte gilt.
function lastCustomTitle(file) {
  let found = null;
  for (const o of parseLines(readRange(file, TAIL_BYTES, true))) {
    if (o.type === 'custom-title' && o.customTitle) found = o.customTitle;
  }
  return found;
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* abgeschnittene letzte Zeile */ }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

// Befehle und Systemhinweise von Claude Code (<command-name>, <system-reminder> …) sind keine echten Fragen.
// Ein eigener Text, der mit "<" anfängt (z. B. HTML), zählt dagegen schon.
const SYSTEM_PROMPT = /^<(command-|local-command|system-reminder|user-prompt|bash-|task-notification|ide_|persisted-output)/;
function isRealPrompt(text) {
  const t = (text || '').trim();
  return !!t && !SYSTEM_PROMPT.test(t) && !t.startsWith('Caveat:');
}

// Erste Zeile als Titel; zu lange Titel enden am Wort mit "…".
// Angehängte Dateien („Datei: /pfad“) sind kein guter Titel – die erste echte Textzeile zählt.
function shortTitle(text, max = 80) {
  const lines = String(text || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !/^Datei: \//.test(l)) || (lines[0] || '').replace(/^Datei: .*\//, '');
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()} …`;
}

// Fortsetzungs-Chats beginnen alle gleich („Wir setzen eine Arbeit fort …“). Der Name steht
// in der ersten Überschrift der Übergabe, z. B. „## Übergabe: Trading-Bot `~/trading-agent`“.
const CONTINUATION = /^(wir setzen eine arbeit fort|unten steht der verlauf)/i;

function continuationTitle(text) {
  if (!CONTINUATION.test(String(text || '').trim())) return null;
  const m = /^#{1,4}\s*(?:Übergabe|Uebergabe|Handover)?\s*[:–-]?\s*(.+)$/m.exec(text);
  const name = m ? m[1].replace(/[`*_]/g, '').trim() : '';
  return name ? `↪ ${shortTitle(name, 70)}` : null;
}

function parseSession(file) {
  const stat = fs.statSync(file);
  let cwd = null;
  let title = null;
  let customTitle = null;
  let snippet = '';
  for (const o of parseLines(readHead(file))) {
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
    if (o.type === 'summary' && o.summary && !customTitle) customTitle = o.summary;
    if (!title && o.type === 'user' && !o.isSidechain && o.message) {
      const t = textOf(o.message.content);
      if (isRealPrompt(t)) { title = continuationTitle(t) || shortTitle(t); snippet = t.trim().slice(0, 1500); }
    }
  }
  customTitle = lastCustomTitle(file) || customTitle;
  return {
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    title: customTitle || title || 'Ohne Titel',
    firstPrompt: title,
    snippet,
    updatedAt: stat.mtimeMs,
  };
}

// Bereits gelesene Sitzungen merken: neu gelesen wird nur, wenn sich die Datei geändert hat.
const sessionCache = new Map();

function cachedSession(file, cache) {
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.session;
  // Titel und Ordner stehen am Anfang; bei reinem Anhängen genügt es, die Zeit zu aktualisieren.
  const session = hit && hit.size < stat.size && hit.size >= HEAD_BYTES
    ? { ...hit.session, title: lastCustomTitle(file) || hit.session.title, updatedAt: stat.mtimeMs }
    : parseSession(file);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, session });
  return session;
}

// Gruppiert alle Sitzungen nach Projektordner, neueste zuerst.
function listProjects(root = DEFAULT_ROOT, cache = sessionCache) {
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const byPath = new Map();
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    let files;
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      let s;
      try { s = cachedSession(file, cache); } catch { continue; }
      seen.add(file);
      const key = s.cwd || dir.name;
      if (!byPath.has(key)) byPath.set(key, { path: s.cwd, name: s.cwd ? path.basename(s.cwd) : dir.name, sessions: [] });
      byPath.get(key).sessions.push(s);
    }
  }
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
  const projects = [...byPath.values()];
  for (const p of projects) {
    p.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    p.updatedAt = p.sessions.length ? p.sessions[0].updatedAt : 0;
  }
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Lädt den Verlauf einer Sitzung als einfache Nachrichtenliste.
// tools: true = auch Claudes Arbeitsschritte (Werkzeugaufrufe) als { role: 'tool', tool, detail } liefern.
function readMessages(file, limit = 200, { tools = false } = {}) {
  const size = fs.statSync(file).size;
  let text;
  if (size > MAX_READ_BYTES) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_READ_BYTES);
      fs.readSync(fd, buf, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } else {
    text = fs.readFileSync(file, 'utf8');
  }
  const out = [];
  for (const o of parseLines(text)) {
    if (o.isSidechain || !o.message) continue;
    if (o.type === 'user') {
      const t = textOf(o.message.content);
      if (isRealPrompt(t)) out.push({ role: 'user', text: t.trim() });
    } else if (o.type === 'assistant' && Array.isArray(o.message.content)) {
      if (tools) for (const b of o.message.content) if (b && b.type === 'tool_use') out.push({ role: 'tool', ...toolStep(b.name, b.input) });
      const t = textOf(o.message.content).trim();
      if (!t) continue;
      const last = out[out.length - 1];
      if (last && last.role === 'assistant') last.text += '\n\n' + t;
      else out.push({ role: 'assistant', text: t });
    }
  }
  return out.slice(-limit);
}

// Meldet Änderungen im Sitzungsordner, damit die Liste live bleibt.
// Höchstens alle 400 ms, aber spätestens nach 2 s, auch wenn Claude ununterbrochen schreibt.
function watchSessions(root = DEFAULT_ROOT) {
  const emitter = new EventEmitter();
  let timer = null;
  let firstPending = 0;
  let watcher = null;
  let poll = null;
  const fire = () => { timer = null; firstPending = 0; emitter.emit('change'); };
  const onChange = () => {
    const now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(400, firstPending + 2000 - now)));
  };
  // fs.watch mit recursive gibt es auf macOS; klappt das nicht, prüfen wir regelmäßig.
  const startPolling = () => {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (!poll) poll = setInterval(() => emitter.emit('change'), 5000);
  };
  try {
    fs.mkdirSync(root, { recursive: true });
    watcher = fs.watch(root, { recursive: true }, onChange);
    watcher.on('error', startPolling);
  } catch {
    startPolling();
  }
  emitter.close = () => {
    clearTimeout(timer);
    clearInterval(poll);
    if (watcher) try { watcher.close(); } catch {}
  };
  return emitter;
}

module.exports = { DEFAULT_ROOT, listProjects, parseSession, readMessages, watchSessions, isRealPrompt, shortTitle, continuationTitle };

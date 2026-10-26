// Liest die Sitzungen, die Claude Code unter ~/.claude/projects speichert.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 256 * 1024;
const MAX_READ_BYTES = 20 * 1024 * 1024;

function readHead(file, bytes = HEAD_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
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

// Befehle und Systemhinweise beginnen mit "<" und sind keine echten Fragen.
function isRealPrompt(text) {
  const t = (text || '').trim();
  return !!t && !t.startsWith('<') && !t.startsWith('Caveat:');
}

function parseSession(file) {
  const stat = fs.statSync(file);
  let cwd = null;
  let title = null;
  let customTitle = null;
  for (const o of parseLines(readHead(file))) {
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
    if (o.type === 'summary' && o.summary && !customTitle) customTitle = o.summary;
    if (!title && o.type === 'user' && !o.isSidechain && o.message) {
      const t = textOf(o.message.content);
      if (isRealPrompt(t)) title = t.trim().split('\n')[0].slice(0, 80);
    }
  }
  return {
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    title: customTitle || title || 'Ohne Titel',
    updatedAt: stat.mtimeMs,
  };
}

// Gruppiert alle Sitzungen nach Projektordner, neueste zuerst.
function listProjects(root = DEFAULT_ROOT) {
  if (!fs.existsSync(root)) return [];
  const byPath = new Map();
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      let s;
      try { s = parseSession(path.join(full, f)); } catch { continue; }
      const key = s.cwd || dir.name;
      if (!byPath.has(key)) byPath.set(key, { path: s.cwd, name: s.cwd ? path.basename(s.cwd) : dir.name, sessions: [] });
      byPath.get(key).sessions.push(s);
    }
  }
  const projects = [...byPath.values()];
  for (const p of projects) {
    p.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    p.updatedAt = p.sessions.length ? p.sessions[0].updatedAt : 0;
  }
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Lädt den Verlauf einer Sitzung als einfache Nachrichtenliste.
function readMessages(file, limit = 200) {
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
function watchSessions(root = DEFAULT_ROOT) {
  const emitter = new EventEmitter();
  let timer = null;
  let watcher = null;
  try {
    fs.mkdirSync(root, { recursive: true });
    watcher = fs.watch(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => emitter.emit('change'), 400);
    });
  } catch {
    // fs.watch mit recursive gibt es auf macOS; anderswo prüfen wir regelmäßig.
    const iv = setInterval(() => emitter.emit('change'), 5000);
    emitter.close = () => clearInterval(iv);
    return emitter;
  }
  emitter.close = () => { clearTimeout(timer); watcher.close(); };
  return emitter;
}

module.exports = { DEFAULT_ROOT, listProjects, parseSession, readMessages, watchSessions, isRealPrompt };

// Lokale Server (localhost): welche laufen, zu welchem Projekt sie gehören, und Starten/Stoppen.
// Nach dem Vorbild des ports-Werkzeugs: lsof liefert lauschende Ports, ps und lsof den Rest.
// Geschützte Prozesse (Handelsbrücke, Claude, die Zentrale selbst …) lassen sich hier nie beenden.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const HOME = os.homedir();
// macOS-Dienste und Apps, die zwar lauschen, aber keine Projekte sind (lsof kürzt Namen auf 9 Zeichen).
const SYSTEM_PREFIXES = ['controlce', 'rapportd', 'sharingd', 'identitys', 'remoted', 'launchd', 'mdnsrespo', 'spotify', 'dropbox',
  'adprivacy', 'netbiosd', 'coreaudio', 'trustd', 'airplayx', 'bluetooth', 'whatsapp', 'discord', 'steam', 'microsoft', 'zoom',
  'figma', 'obsidian', 'ollama'];
// Nie beenden – bittere Erfahrung: sonst sind Handelsbrücke oder die eigene Sitzung weg.
const PROTECTED_NAMES = /(mt5|metatrader|wine|caffeinate|signalserver|claude|mcp|zentrale|electron)/i;
const PROTECTED_PORTS = new Set([8788]);
const PROBE_MS = 700;

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });
}

// lsof -F: Zeilen mit p<pid>, c<name>, n<adresse:port>
function parseLsof(text) {
  const out = [];
  let pid = null;
  let name = '';
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); name = ''; }
    else if (line.startsWith('c')) name = line.slice(1);
    else if (line.startsWith('n') && pid) {
      const m = /^(.*):(\d+)$/.exec(line.slice(1));
      if (m) out.push({ pid, proc: name, host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) });
    }
  }
  // Ein Prozess, der auf v4 und v6 lauscht, zählt einmal pro Port.
  const seen = new Set();
  return out.filter((x) => { const k = `${x.pid}:${x.port}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Projektordner: das Arbeitsverzeichnis – oder, wenn das der Benutzerordner ist, ein Projektpfad aus dem Befehl.
function projectOf(cwd, cmd) {
  const fromCmd = String(cmd || '').split(/\s+/).find((a) => a.startsWith(HOME + path.sep) && !a.includes('/.npm/') && !a.includes('/Library/'));
  const dir = cwd && cwd !== HOME && cwd !== '/' ? cwd : fromCmd ? fromCmd.slice(0, HOME.length + 1 + fromCmd.slice(HOME.length + 1).split(path.sep)[0].length) : cwd;
  return { dir: dir || null, name: dir ? path.basename(dir) : '' };
}

function isSystem(proc) {
  const p = String(proc || '').toLowerCase();
  return SYSTEM_PREFIXES.some((s) => p.startsWith(s));
}

function protectedReason(s, selfPids = []) {
  if (selfPids.includes(s.pid)) return 'Das ist die Zentrale selbst.';
  if (PROTECTED_PORTS.has(s.port)) return 'Der Signal-Server des Trading-Bots läuft hier – der bleibt immer an.';
  if (PROTECTED_NAMES.test(`${s.proc} ${s.cmd}`)) return 'Geschützter Prozess (Handelsbrücke, Claude oder die Zentrale) – den beendet die Zentrale nie.';
  return null;
}

function probeTitle(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: PROBE_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 20000) res.destroy(); });
      res.on('end', () => resolve((/<title[^>]*>([^<]{0,120})<\/title>/i.exec(body) || [])[1] || ''));
      res.on('close', () => resolve((/<title[^>]*>([^<]{0,120})<\/title>/i.exec(body) || [])[1] || ''));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

function formatUptime(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} Std.`;
  return `${Math.floor(h / 24)} Tage`;
}

// Alle lauschenden TCP-Ports mit Projekt, Befehl, Laufzeit, Titel. all = auch System-Dienste.
async function listServers({ all = false, selfPids = [], started = [] } = {}) {
  const raw = parseLsof(await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
  const pids = [...new Set(raw.map((x) => x.pid))];
  const info = new Map();
  await Promise.all(pids.map(async (pid) => {
    const [ps, cwdOut] = await Promise.all([
      run('/bin/ps', ['-o', 'etime=,ppid=,command=', '-p', String(pid)]),
      run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    ]);
    const m = /^\s*(\S+)\s+(\d+)\s+(.*)$/.exec(ps.trim()) || [];
    const cwd = (cwdOut.split('\n').find((l) => l.startsWith('n')) || '').slice(1) || null;
    info.set(pid, { etime: m[1] || '', ppid: Number(m[2] || 0), cmd: (m[3] || '').trim(), cwd });
  }));
  const startedByPid = new Map(started.map((s) => [s.pid, s]));
  const list = raw.map((x) => {
    const i = info.get(x.pid) || {};
    const project = projectOf(i.cwd, i.cmd);
    const s = { ...x, cmd: i.cmd || x.proc, cwd: i.cwd, project: project.name, projectDir: project.dir,
      uptime: etimeToText(i.etime), launchd: i.ppid === 1, startedByZentrale: startedByPid.has(x.pid),
      url: `http://127.0.0.1:${x.port}`, system: isSystem(x.proc) };
    return { ...s, self: selfPids.includes(s.pid), protected: protectedReason(s, selfPids) };
  }).filter((s) => all || !s.system);
  await Promise.all(list.map(async (s) => { s.title = s.system ? '' : await probeTitle(s.port); }));
  return list.sort((a, b) => a.port - b.port);
}

// ps etime: [[dd-]hh:]mm:ss
function etimeToText(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime || '').trim());
  if (!m) return '';
  const ms = (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
  return formatUptime(ms);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Beendet genau diesen Prozess (keine Namenssuche). force = hart beenden, wenn er nicht reagiert.
async function stopServer(s, { force = false, selfPids = [] } = {}) {
  const reason = protectedReason(s, selfPids);
  if (reason) return { ok: false, error: reason };
  if (!Number.isInteger(s.pid) || s.pid <= 1) return { ok: false, error: 'Ungültiger Prozess.' };
  try { process.kill(s.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { return { ok: false, error: e.code === 'ESRCH' ? 'Der Server läuft schon nicht mehr.' : e.message }; }
  for (let i = 0; i < 20 && alive(s.pid); i += 1) await new Promise((r) => setTimeout(r, 150));
  if (alive(s.pid)) return { ok: false, stillRunning: true, error: 'Der Server reagiert nicht. Hart beenden?' };
  return { ok: true, restarts: s.launchd ? 'Dieser Dienst wird von macOS (launchd) verwaltet und startet womöglich gleich wieder.' : null };
}

// Vorschläge für den Startbefehl aus dem Projektordner.
function suggestCommands(dir) {
  const out = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const name of ['dev', 'start', 'serve', 'preview']) if (pkg.scripts && pkg.scripts[name]) out.push(`npm run ${name}`);
  } catch {}
  if (fs.existsSync(path.join(dir, 'manage.py'))) out.push('python3 manage.py runserver');
  if (fs.existsSync(path.join(dir, 'index.html'))) out.push('python3 -m http.server 8000');
  if (!out.length) out.push('python3 -m http.server 8000');
  return out;
}

// Startet einen Server im Projektordner (über die Login-Shell, damit npm & Co. gefunden werden).
// Ausgaben landen in einer Log-Datei; der Prozess läuft unabhängig von der Zentrale weiter.
function startServer({ dir, command, port, env, logDir }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: 'Diesen Ordner gibt es nicht.' };
  const cmd = String(command || '').trim();
  if (!cmd || cmd.length > 500 || /[\n\r]/.test(cmd)) return { ok: false, error: 'Bitte einen Startbefehl eintragen (eine Zeile).' };
  const p = port == null || port === '' ? null : Number(port);
  if (p != null && (!Number.isInteger(p) || p < 1024 || p > 65535)) return { ok: false, error: 'Der Port muss zwischen 1024 und 65535 liegen.' };
  if (PROTECTED_PORTS.has(p)) return { ok: false, error: 'Dieser Port ist für den Trading-Bot reserviert.' };
  const id = crypto.randomUUID();
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${path.basename(dir)}-${id.slice(0, 8)}.log`);
  const fd = fs.openSync(log, 'a');
  const shell = process.env.SHELL || '/bin/zsh';
  let child;
  try {
    child = spawn(shell, ['-lc', cmd], { cwd: dir, detached: true, stdio: ['ignore', fd, fd],
      env: { ...env, ...(p ? { PORT: String(p) } : {}) } });
  } catch (e) {
    fs.closeSync(fd);
    return { ok: false, error: e.message };
  }
  fs.closeSync(fd);
  child.on('error', () => {}); // z. B. Shell fehlt – darf die Zentrale nicht abstürzen lassen
  child.unref();
  return { ok: true, data: { id, dir, command: cmd, port: p, pid: child.pid, log, startedAt: Date.now() } };
}

function readLog(file, bytes = 20000) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return { ok: true, data: buf.toString('utf8') };
    } finally { fs.closeSync(fd); }
  } catch { return { ok: false, error: 'Kein Log vorhanden.' }; }
}

module.exports = { listServers, stopServer, startServer, suggestCommands, readLog, parseLsof, projectOf, protectedReason, etimeToText, isSystem };

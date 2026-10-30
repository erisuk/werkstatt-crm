// Ordner-Wächter: neue Dateien (z. B. in Downloads) nach deinen Regeln einsortieren.
// Regel = Ordner + Muster (z. B. „*Rechnung*.pdf“) + Ziel. Es wird nie überschrieben; jede Verschiebung
// steht im Protokoll und lässt sich rückgängig machen. Dateien ohne passende Regel werden nur gemeldet.
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TEMP_FILE = /\.(crdownload|download|part|partial|tmp)$|^\.|^~\$/i;
const MAX_LOG = 200;
const SETTLE_MS = 1500;
const SCAN_MS = 30 * 1000; // Sicherheits-Durchgang: macOS meldet unter Last nicht jede neue Datei

// Einfaches Muster: * = beliebig viele Zeichen, ? = ein Zeichen; Groß/klein egal.
function patternToRegex(pattern) {
  const p = String(pattern || '').trim();
  if (!p || p.length > 80) return null;
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

function insideHome(dir) {
  try {
    const real = fs.realpathSync.native(dir);
    const rel = path.relative(fs.realpathSync.native(os.homedir()), real);
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).some((x) => x.startsWith('.')) && rel.split(path.sep)[0] !== 'Library' ? real : null;
  } catch { return null; }
}

// Wie insideHome, aber der Ordner darf noch fehlen (wird beim ersten Einsortieren angelegt):
// geprüft wird der nächste vorhandene Elternordner.
function insideHomeOrNew(dir) {
  if (!dir || !path.isAbsolute(dir)) return null;
  const rest = [];
  let cur = path.normalize(dir);
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  if (rest.some((x) => x.startsWith('.'))) return null;
  const base = insideHome(cur);
  return base ? path.join(base, ...rest) : null;
}

function cleanRule(r) {
  const folder = insideHome(String((r && r.folder) || path.join(os.homedir(), 'Downloads')));
  const target = insideHomeOrNew(String((r && r.target) || ''));
  const re = patternToRegex(r && r.pattern);
  if (!folder) return { ok: false, error: 'Der überwachte Ordner muss in deinem Benutzerordner liegen.' };
  if (!target) return { ok: false, error: 'Der Zielordner muss in deinem Benutzerordner liegen und existieren.' };
  if (!re) return { ok: false, error: 'Bitte ein Muster angeben, z. B. *Rechnung*.pdf' };
  if (folder === target) return { ok: false, error: 'Quelle und Ziel sind derselbe Ordner.' };
  return { ok: true, rule: { id: typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) ? r.id : crypto.randomUUID(),
    folder, pattern: String(r.pattern).trim(), target, enabled: r.enabled !== false } };
}

// Freier Name im Ziel: „Rechnung.pdf“ → „Rechnung (2).pdf“, nie überschreiben.
function freeName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

// Verschieben, ohne je etwas zu überschreiben: link() schlägt fehl, wenn das Ziel schon existiert –
// anders als rename(), das stillschweigend ersetzt. Zwischen zwei Platten: kopieren mit COPYFILE_EXCL.
function moveFile(from, to) {
  try {
    fs.linkSync(from, to);
    fs.unlinkSync(from);
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

// Freien Namen suchen und verschieben; ist der Name inzwischen belegt, den nächsten nehmen.
function moveFree(from, dir, name) {
  for (let i = 0; i < 50; i += 1) {
    const to = freeName(dir, name);
    try { moveFile(from, to); return to; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('Kein freier Dateiname gefunden.');
}

class FolderWatcher extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    const data = this.load();
    this.rules = data.rules;
    this.log = data.log;
    this.unsorted = [];
    this.watchers = new Map();
    this.pending = new Map();
    this.kept = new Set(); // zurückgeholte Dateien – nie wieder automatisch wegsortieren
    this.scanTimer = null;
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const rules = (Array.isArray(d.rules) ? d.rules : []).map((r) => cleanRule(r)).filter((x) => x.ok).map((x) => x.rule);
      return { rules, log: Array.isArray(d.log) ? d.log.slice(-MAX_LOG) : [] };
    } catch { return { rules: [], log: [] }; }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ rules: this.rules, log: this.log }, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
    this.emit('change');
  }

  get() {
    return { rules: this.rules.map((r) => ({ ...r })), log: [...this.log].reverse().slice(0, 50), unsorted: [...this.unsorted] };
  }

  saveRule(input) {
    const res = cleanRule(input);
    if (!res.ok) return res;
    const exists = this.rules.some((r) => r.id === res.rule.id);
    this.rules = exists ? this.rules.map((r) => (r.id === res.rule.id ? res.rule : r)) : [...this.rules, res.rule];
    this.save();
    this.restart();
    return { ok: true, rule: res.rule };
  }

  removeRule(id) {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.save();
    this.restart();
  }

  // Beobachtet jeden Quellordner einmal (nicht rekursiv – Unterordner sortiert niemand ungefragt).
  start() {
    const folders = [...new Set(this.rules.filter((r) => r.enabled).map((r) => r.folder))];
    for (const dir of folders) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, (_type, name) => { if (name) this.schedule(dir, String(name)); });
        w.on('error', () => {});
        this.watchers.set(dir, w);
      } catch {}
    }
    // Nur Dateien, die nach dem Start des Wächters entstanden sind – Altbestand sortiert niemand ungefragt.
    this.startedAt = Date.now();
    clearInterval(this.scanTimer);
    this.scanTimer = setInterval(() => this.scan(), SCAN_MS);
    this.scanTimer.unref();
  }

  scan() {
    for (const dir of this.watchers.keys()) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        const full = path.join(dir, name);
        if (this.pending.has(full) || this.kept.has(full) || TEMP_FILE.test(name)) continue;
        if (!this.rules.some((r) => r.enabled && r.folder === dir && patternToRegex(r.pattern).test(name))) continue;
        try { if (fs.lstatSync(full).birthtimeMs < this.startedAt) continue; } catch { continue; }
        this.schedule(dir, name);
      }
    }
  }

  stop() {
    clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const w of this.watchers.values()) try { w.close(); } catch {}
    this.watchers.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  restart() { this.stop(); this.start(); }

  // Erst handeln, wenn die Datei fertig geschrieben ist (Größe bleibt gleich).
  schedule(dir, name) {
    if (TEMP_FILE.test(name)) return;
    const full = path.join(dir, name);
    clearTimeout(this.pending.get(full));
    this.pending.set(full, setTimeout(() => this.settle(dir, name, -1), SETTLE_MS));
  }

  settle(dir, name, lastSize) {
    const full = path.join(dir, name);
    let st;
    // lstat: Verknüpfungen (Symlinks) werden nie verschoben.
    try { st = fs.lstatSync(full); } catch { this.pending.delete(full); return; }
    if (!st.isFile()) { this.pending.delete(full); return; }
    if (st.size !== lastSize) { this.pending.set(full, setTimeout(() => this.settle(dir, name, st.size), SETTLE_MS)); return; }
    this.pending.delete(full);
    this.handle(dir, name);
  }

  handle(dir, name) {
    const full = path.join(dir, name);
    // Eine gerade zurückgeholte Datei nicht gleich wieder wegsortieren.
    if (this.skipOnce === full) { this.skipOnce = null; return null; }
    const rule = this.rules.find((r) => r.enabled && r.folder === dir && patternToRegex(r.pattern).test(name));
    if (!rule) {
      // Ohne Regel nur melden – Claude kann auf Wunsch einen Platz vorschlagen.
      this.unsorted = [{ path: full, name, at: Date.now() }, ...this.unsorted.filter((u) => u.path !== full)].slice(0, 20);
      this.emit('change');
      return null;
    }
    try {
      if (!fs.existsSync(rule.target)) fs.mkdirSync(rule.target, { recursive: true });
      // Ziel beim Verschieben neu prüfen – es könnte inzwischen auf einen anderen Ort zeigen.
      if (insideHomeOrNew(rule.target) !== rule.target) throw new Error('Der Zielordner liegt nicht mehr in deinem Benutzerordner.');
      const to = moveFree(full, rule.target, name);
      const entry = { id: crypto.randomUUID(), from: full, to, at: Date.now(), rule: rule.pattern, undone: false };
      this.log = [...this.log, entry].slice(-MAX_LOG);
      this.save();
      this.emit('moved', entry);
      return entry;
    } catch (e) {
      this.emit('failed', { path: full, error: e.message });
      return null;
    }
  }

  undo(id) {
    const e = this.log.find((x) => x.id === id);
    if (!e || e.undone) return { ok: false, error: 'Das lässt sich nicht mehr rückgängig machen.' };
    if (!fs.existsSync(e.to)) return { ok: false, error: 'Die Datei liegt nicht mehr am Zielort.' };
    // Nicht sofort wieder einsortieren, wenn die Datei zurückkommt.
    this.skipOnce = freeName(path.dirname(e.from), path.basename(e.from));
    try { this.skipOnce = moveFree(e.to, path.dirname(e.from), path.basename(e.from)); } catch (err) { return { ok: false, error: err.message }; }
    this.kept.add(this.skipOnce);
    this.log = this.log.map((x) => (x.id === id ? { ...x, undone: true } : x));
    this.save();
    return { ok: true };
  }

  dismiss(file) {
    this.unsorted = this.unsorted.filter((u) => u.path !== file);
    this.emit('change');
  }
}

module.exports = { FolderWatcher, patternToRegex, cleanRule, freeName, insideHome };

// Obsidian-Vault („Gehirn“): Notizen auflisten, durchsuchen, lesen und schnell etwas in den Eingang legen.
// Alle Pfade bleiben im Vault – auch Verknüpfungen nach draußen werden nicht gelesen.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OBSIDIAN_CONFIG = path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const MAX_NOTES = 5000;
const MAX_READ = 200 * 1024;
const MAX_SEARCH_FILE = 1024 * 1024;
const INBOX = 'Eingang';

// Die Vaults, die Obsidian kennt; der zuletzt geöffnete zuerst.
function findVaults(configFile = OBSIDIAN_CONFIG) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return []; }
  return Object.values((data && data.vaults) || {})
    .filter((v) => v && typeof v.path === 'string' && fs.existsSync(v.path))
    .sort((a, b) => (b.open === true) - (a.open === true) || (b.ts || 0) - (a.ts || 0))
    .map((v) => ({ path: v.path, name: path.basename(v.path), open: v.open === true }));
}

function realRoot(vault) {
  try { return fs.realpathSync.native(vault); } catch { return null; }
}

// Ein Pfad im Vault (relativ angegeben) – oder null, wenn er hinausführen würde.
function inside(vault, rel) {
  const root = realRoot(vault);
  if (!root || typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync.native(full);
    return real === root || real.startsWith(root + path.sep) ? real : null;
  } catch {
    // Gibt es (noch) nicht – z. B. eine neue Notiz. Dann muss der vorhandene Elternordner im Vault liegen.
    let dir = path.dirname(full);
    while (!fs.existsSync(dir) && dir !== root) dir = path.dirname(dir);
    try { const realDir = fs.realpathSync.native(dir); return realDir === root || realDir.startsWith(root + path.sep) ? full : null; } catch { return null; }
  }
}

function walk(root, out = [], dir = root) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_NOTES) break;
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, out, full);
    else if (e.isFile() && e.name.endsWith('.md')) {
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const rel = path.relative(root, full);
      out.push({ rel, title: e.name.slice(0, -3), folder: path.dirname(rel) === '.' ? '' : path.dirname(rel), modified: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function listNotes(vault) {
  const root = realRoot(vault);
  if (!root) return { ok: false, error: 'Den Vault gibt es nicht (mehr).' };
  return { ok: true, data: walk(root).sort((a, b) => b.modified - a.modified) };
}

// Sucht in Titel und Inhalt; liefert pro Treffer eine kurze Textstelle.
function search(vault, query, limit = 50) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return listNotes(vault);
  const root = realRoot(vault);
  if (!root) return { ok: false, error: 'Den Vault gibt es nicht (mehr).' };
  const hits = [];
  for (const n of walk(root)) {
    if (hits.length >= limit) break;
    const inTitle = n.title.toLowerCase().includes(q);
    let snippet = '';
    if (n.size <= MAX_SEARCH_FILE) {
      let text = '';
      try { text = fs.readFileSync(path.join(root, n.rel), 'utf8'); } catch {}
      const i = text.toLowerCase().indexOf(q);
      if (i >= 0) snippet = text.slice(Math.max(0, i - 60), i + q.length + 80).replace(/\s+/g, ' ').trim();
      if (!inTitle && i < 0) continue;
    } else if (!inTitle) continue;
    hits.push({ ...n, snippet, score: inTitle ? 2 : 1 });
  }
  return { ok: true, data: hits.sort((a, b) => (b.score - a.score) || (b.modified - a.modified)) };
}

function readNote(vault, rel) {
  const file = inside(vault, rel);
  if (!file || !file.endsWith('.md') || !fs.existsSync(file)) return { ok: false, error: 'Diese Notiz gibt es nicht.' };
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, MAX_READ));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { ok: true, data: { rel, text: buf.toString('utf8'), truncated: size > MAX_READ } };
  } finally {
    fs.closeSync(fd);
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

// Neue Notiz im Eingang: „2026-10-28 0912 Titel.md“. Überschreibt nie etwas.
function addNote(vault, title, text, now = new Date()) {
  const t = String(title || '').replace(/[\\/:*?"<>|#^[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const body = String(text || '').trim();
  if (!t && !body) return { ok: false, error: 'Schreib einen Titel oder etwas Text.' };
  const name = `${stamp(now)} ${t || body.split('\n')[0].replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim().slice(0, 40) || 'Notiz'}`.trim();
  const rel = path.join(INBOX, `${name}.md`);
  const file = inside(vault, rel);
  if (!file) return { ok: false, error: 'Der Eingang des Vaults ist nicht erreichbar.' };
  if (fs.existsSync(file)) return { ok: false, error: 'Diese Notiz gibt es schon – warte eine Minute oder ändere den Titel.' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${t || 'Notiz'}\n\n${body}\n\n_Aus der Zentrale, ${now.toLocaleString('de-DE')}_\n`, { flag: 'wx' });
  return { ok: true, data: { rel } };
}

// Link, der die Notiz direkt in Obsidian öffnet.
function obsidianUrl(vault, rel) {
  const name = path.basename(vault);
  const file = String(rel || '').replace(/\.md$/, '');
  return `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(file)}`;
}

module.exports = { findVaults, listNotes, search, readNote, addNote, obsidianUrl, inside, INBOX, stamp };

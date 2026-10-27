// Apps und Ordner des Mac für die Ansicht „Mein Mac“: auflisten, durchsuchen, öffnen.
// Öffnen und Löschen passiert nur auf Klick in der Oberfläche – nie durch Claude.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(HOME, 'Applications')];
const MAX_ENTRIES = 2000;

// Diese Ordner (und alles darüber) dürfen nie in den Papierkorb.
const PROTECTED = [HOME, path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'Downloads'),
  path.join(HOME, 'Library'), path.join(HOME, '.claude'), '/Applications', '/System', '/Library', '/Users'];

function listApps(dirs = APP_DIRS) {
  const seen = new Map();
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      const label = name.slice(0, -4);
      if (!seen.has(label)) seen.set(label, { name: label, path: path.join(dir, name) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function favorites() {
  const list = [
    ['Benutzerordner', HOME], ['Schreibtisch', path.join(HOME, 'Desktop')], ['Dokumente', path.join(HOME, 'Documents')],
    ['Downloads', path.join(HOME, 'Downloads')], ['Bilder', path.join(HOME, 'Pictures')], ['Filme', path.join(HOME, 'Movies')],
    ['Musik', path.join(HOME, 'Music')], ['iCloud Drive', path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')],
  ];
  return list.filter(([, p]) => isDir(p)).map(([name, p]) => ({ name, path: p }));
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function validPath(p) {
  return typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0');
}

// Inhalt eines Ordners: Ordner zuerst, dann Dateien; versteckte nur auf Wunsch.
function listDir(dir, { hidden = false } = {}) {
  if (!validPath(dir)) return { ok: false, error: 'Ungültiger Ordner.' };
  const p = path.resolve(dir);
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) {
    return { ok: false, error: e.code === 'EACCES' || e.code === 'EPERM'
      ? 'macOS erlaubt der Zentrale diesen Ordner noch nicht. Erlaube es unter Systemeinstellungen → Datenschutz & Sicherheit → Dateien und Ordner.'
      : 'Diesen Ordner gibt es nicht (mehr).' };
  }
  const items = [];
  for (const e of entries) {
    if (!hidden && e.name.startsWith('.')) continue;
    if (items.length >= MAX_ENTRIES) break;
    const full = path.join(p, e.name);
    let st = null;
    try { st = fs.statSync(full); } catch {}
    const app = e.name.endsWith('.app');
    items.push({ name: e.name, path: full, dir: !!st && st.isDirectory() && !app, app, size: st && st.isFile() ? st.size : null,
      modified: st ? st.mtimeMs : null });
  }
  items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'de', { numeric: true }));
  return { ok: true, path: p, parent: path.dirname(p) !== p ? path.dirname(p) : null, items, truncated: entries.length > items.length && items.length >= MAX_ENTRIES };
}

// Echter Pfad ohne Verknüpfungen, klein geschrieben: macOS unterscheidet Groß/klein nicht,
// „~/documents“ ist also derselbe Ordner wie „~/Documents“.
function canonical(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch {}
  return r.toLowerCase();
}

function isProtected(p) {
  const r = canonical(p);
  return r === path.parse(r).root || PROTECTED.some((x) => {
    const c = canonical(x);
    return c === r || c.startsWith(r + path.sep);
  });
}

// Skripte und Programme, die macOS beim Öffnen ausführen würde.
const RUNNABLE = /\.(command|tool|terminal|sh|zsh|bash|scpt|applescript|workflow|action|jar|pkg|mpkg)$/i;
const SYSTEM_APP_DIRS = APP_DIRS.map((d) => d.toLowerCase());

// true, wenn Öffnen etwas ausführen würde, das nicht aus einem Programme-Ordner stammt.
// Apps zählen über ihren sichtbaren Ort (Safari liegt intern in einem System-Bereich unter /System/Volumes/…).
function needsRunConfirm(p) {
  const shown = path.resolve(p).toLowerCase();
  const r = canonical(p);
  if (RUNNABLE.test(shown) || RUNNABLE.test(r)) return true;
  if (!/\.app$/.test(shown)) return false;
  const inAppDir = (x) => SYSTEM_APP_DIRS.includes(path.dirname(x));
  return !(inAppDir(shown) && (inAppDir(r) || r.startsWith('/system/')));
}

module.exports = { listApps, favorites, listDir, isProtected, needsRunConfirm, canonical, validPath, isDir, APP_DIRS, HOME };

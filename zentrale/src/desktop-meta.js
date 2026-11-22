// Liest, was die Claude-App (Desktop) über ihre Code-Gespräche weiß: Titel, archiviert, geplante Aufgabe.
// Die Dateien liegen unter ~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const MAX_DEPTH = 4;

// Nur geänderte Dateien werden neu gelesen.
const fileCache = new Map();

function readMeta(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta;
  let meta = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j.cliSessionId === 'string') {
      meta = { id: j.cliSessionId, localId: typeof j.sessionId === 'string' ? j.sessionId : null,
        title: typeof j.title === 'string' ? j.title : null, archived: j.isArchived === true, scheduled: !!j.scheduledTaskId };
    }
  } catch {}
  fileCache.set(file, { mtimeMs: st.mtimeMs, meta });
  return meta;
}

// Map: Gesprächs-ID von Claude Code → { title, archived, scheduled }.
function desktopMeta(root = DEFAULT_ROOT) {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/^local_.*\.json$/.test(e.name)) {
        const m = readMeta(full);
        if (m) out.set(m.id, m);
      }
    }
  };
  walk(root, 0);
  return out;
}

// Ordnung der Seitenleiste in der Claude-App (nur lesen): angeheftete Gespräche und eigene Gruppen mit Mitgliedern.
// Steht in claude_desktop_config.json unter preferences.epitaxyPrefs; die IDs dort sind die „local_…“-IDs der App.
const CONFIG = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
let sidebarCache = { mtimeMs: -1, value: { pinned: [], groups: [] } };

function desktopSidebar(file = CONFIG) {
  let st;
  try { st = fs.statSync(file); } catch { return { pinned: [], groups: [] }; }
  if (st.mtimeMs === sidebarCache.mtimeMs) return sidebarCache.value;
  let value = { pinned: [], groups: [] };
  try {
    const prefs = (JSON.parse(fs.readFileSync(file, 'utf8')).preferences || {}).epitaxyPrefs || {};
    const pinned = Array.isArray(prefs['starred-local-code-sessions']) ? prefs['starred-local-code-sessions'].filter((x) => typeof x === 'string') : [];
    const frames = prefs['dframe-code-sections'] && typeof prefs['dframe-code-sections'] === 'object' ? Object.values(prefs['dframe-code-sections']) : [];
    const sections = frames.flatMap((f) => (f && Array.isArray(f.sections) ? f.sections : []));
    const groups = sections.filter((x) => x && x.kind === 'manual' && x.shown !== false && typeof x.name === 'string')
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((x) => ({ id: String(x.id), name: x.name, members: Array.isArray(x.members) ? x.members.filter((m) => typeof m === 'string') : [] }));
    value = { pinned, groups };
  } catch { /* Format unbekannt: dann eben ohne Ordnung */ }
  sidebarCache = { mtimeMs: st.mtimeMs, value };
  return value;
}

module.exports = { desktopMeta, desktopSidebar, DEFAULT_ROOT };

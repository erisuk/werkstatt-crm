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
      meta = { id: j.cliSessionId, title: typeof j.title === 'string' ? j.title : null,
        archived: j.isArchived === true, scheduled: !!j.scheduledTaskId };
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

module.exports = { desktopMeta, DEFAULT_ROOT };

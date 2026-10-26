// Liest, was Claude Code auf diesem Mac kann: Skills, Befehle, Plugins und Agenten.
// Dazu, welche Gespräche und Unteragenten gerade arbeiten.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const ACTIVE_MS = 2 * 60 * 1000; // so frisch muss eine Datei sein, damit sie als "arbeitet gerade" gilt
const MAX_DEPTH = 5;

function readText(file, max = 16 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// Einfacher Kopfbereich zwischen "---"-Zeilen: nur "schlüssel: wert" in einer Zeile.
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// Alle Dateien mit diesem Namen unterhalb von dir (begrenzte Tiefe, ohne node_modules).
function findFiles(dir, test, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude-plugin') continue;
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, test, depth + 1, out);
    else if (test(e.name, full)) out.push(full);
  }
  return out;
}

function describe(file, fallbackName) {
  const fm = frontmatter(readText(file));
  return { name: fm.name || fallbackName, description: (fm.description || '').slice(0, 400), model: fm.model || null, file };
}

// Installierte Plugins liegen bei dir unter ~/.claude/plugins/synced/<konto>/<plugin>.
function pluginDirs(root = CLAUDE_DIR) {
  const synced = path.join(root, 'plugins', 'synced');
  const out = [];
  let accounts = [];
  try { accounts = fs.readdirSync(synced, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const acc of accounts) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(synced, acc.name), { withFileTypes: true }); } catch {}
    for (const e of entries) if (e.isDirectory()) out.push(path.join(synced, acc.name, e.name));
  }
  return out;
}

function pluginInfo(dir) {
  const manifest = [path.join(dir, '.claude-plugin', 'plugin.json'), path.join(dir, 'plugin.json')]
    .map((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }).find(Boolean) || {};
  const name = manifest.name || path.basename(dir).split('~')[0];
  return { name, description: String(manifest.description || '').slice(0, 400), version: manifest.version || null, dir };
}

function listSkills(root = CLAUDE_DIR) {
  const own = findFiles(path.join(root, 'skills'), (n) => n === 'SKILL.md').map((f) => {
    const rel = path.relative(path.join(root, 'skills'), f).split(path.sep);
    const source = rel[0] === 'ecc' ? 'ECC' : rel[0] === 'synced' ? 'Konto' : 'Eigene';
    return { ...describe(f, rel[rel.length - 2]), source };
  });
  const fromPlugins = pluginDirs(root).flatMap((dir) => {
    const p = pluginInfo(dir);
    return findFiles(dir, (n) => n === 'SKILL.md').map((f) => ({ ...describe(f, path.basename(path.dirname(f))), source: `Plugin ${p.name}` }));
  });
  return [...own, ...fromPlugins].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function listCommands(root = CLAUDE_DIR) {
  const dir = path.join(root, 'commands');
  return findFiles(dir, (n) => n.endsWith('.md')).map((f) => {
    const name = path.relative(dir, f).replace(/\.md$/, '').split(path.sep).join(':');
    const d = describe(f, name);
    return { ...d, name: `/${name}` };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function listPlugins(root = CLAUDE_DIR) {
  return pluginDirs(root).map((dir) => {
    const p = pluginInfo(dir);
    const count = (re) => findFiles(dir, (n, full) => re.test(full)).length;
    return { ...p, skills: count(/SKILL\.md$/), commands: count(/[/\\]commands[/\\][^/\\]+\.md$/), agents: count(/[/\\]agents[/\\][^/\\]+\.md$/) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// Aktiv = in ~/.claude/agents, abgeschaltet = in ~/.claude/agents-archiv.
function listAgents(root = CLAUDE_DIR) {
  const read = (folder, active) => {
    let files = [];
    try { files = fs.readdirSync(path.join(root, folder)).filter((f) => f.endsWith('.md')); } catch {}
    return files.map((f) => ({ ...describe(path.join(root, folder, f), f.replace(/\.md$/, '')), id: f, active, source: 'Eigene' }));
  };
  const fromPlugins = pluginDirs(root).flatMap((dir) => {
    const p = pluginInfo(dir);
    return findFiles(dir, (n, full) => /[/\\]agents[/\\][^/\\]+\.md$/.test(full))
      .map((f) => ({ ...describe(f, path.basename(f, '.md')), id: null, active: true, source: `Plugin ${p.name}` }));
  });
  return [...read('agents', true), ...read('agents-archiv', false), ...fromPlugins]
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'de'));
}

// Schaltet einen eigenen Agenten an oder ab, indem die Datei zwischen den beiden Ordnern wandert.
function setAgentActive(id, active, root = CLAUDE_DIR) {
  if (typeof id !== 'string' || !/^[\w.-]+\.md$/.test(id) || id.startsWith('.')) return { ok: false, error: 'Unbekannter Agent.' };
  const from = path.join(root, active ? 'agents-archiv' : 'agents', id);
  const toDir = path.join(root, active ? 'agents' : 'agents-archiv');
  const to = path.join(toDir, id);
  if (!fs.existsSync(from)) return { ok: false, error: 'Diesen Agenten gibt es dort nicht.' };
  if (fs.existsSync(to)) return { ok: false, error: 'Im Zielordner liegt schon ein Agent mit diesem Namen.' };
  try {
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(from, to);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Gespräche und Unteragenten, deren Verlauf in den letzten 2 Minuten geschrieben wurde.
// sessionTitle(id) liefert den Titel eines Gesprächs.
function runningWork(sessionTitle = () => null, root = CLAUDE_DIR, now = Date.now()) {
  const projects = path.join(root, 'projects');
  const sessions = [];
  const agents = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(projects, d.name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (now - st.mtimeMs < ACTIVE_MS) sessions.push({ id: e.name.slice(0, -6), title: sessionTitle(e.name.slice(0, -6)), updatedAt: st.mtimeMs });
      } else if (e.isDirectory()) {
        const sub = path.join(full, 'subagents');
        let files = [];
        try { files = fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
        for (const f of files) {
          let st;
          try { st = fs.statSync(path.join(sub, f)); } catch { continue; }
          if (now - st.mtimeMs >= ACTIVE_MS) continue;
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(sub, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch {}
          agents.push({ type: meta.agentType || 'Unteragent', description: meta.description || '', session: sessionTitle(e.name), updatedAt: st.mtimeMs });
        }
      }
    }
  }
  const byTime = (a, b) => b.updatedAt - a.updatedAt;
  return { sessions: sessions.sort(byTime), agents: agents.sort(byTime) };
}

function library(root = CLAUDE_DIR) {
  return { skills: listSkills(root), commands: listCommands(root), plugins: listPlugins(root), agents: listAgents(root) };
}

module.exports = { frontmatter, listSkills, listCommands, listPlugins, listAgents, setAgentActive, runningWork, library, CLAUDE_DIR };

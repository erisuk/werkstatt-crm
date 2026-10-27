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

// Einfacher Kopfbereich zwischen "---"-Zeilen: "schlüssel: wert", auch mehrzeilig mit ">" oder "|".
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  let block = null; // Schlüssel eines mehrzeiligen Werts
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      const value = kv[2].trim();
      block = /^[>|][+-]?$/.test(value) ? kv[1] : null;
      out[kv[1]] = block ? '' : value.replace(/^["']|["']$/g, '');
    } else if (block && /^\s+\S/.test(line)) {
      out[block] = `${out[block]} ${line.trim()}`.trim();
    }
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
  const name = String(fm.name || fallbackName || path.basename(path.dirname(file)) || path.basename(file, '.md'));
  return { name, description: String(fm.description || '').slice(0, 400), model: fm.model || null, file };
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
    return { ...describe(f, rel[rel.length - 2]), source, own: !!ownSkillDir(f, root) };
  });
  const fromPlugins = pluginDirs(root).flatMap((dir) => {
    const p = pluginInfo(dir);
    return findFiles(dir, (n) => n === 'SKILL.md').map((f) => ({ ...describe(f, path.basename(path.dirname(f))), source: `Plugin ${p.name}`, own: false }));
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

// ---------- Agenten und Skills anlegen, lesen, ändern ----------

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/;
const MODELS = ['inherit', 'sonnet', 'opus', 'haiku'];
// Werkzeug-Gruppen für die Oberfläche; ohne Angabe darf ein Agent alle Werkzeuge nutzen.
const TOOL_GROUPS = {
  lesen: ['Read', 'Grep', 'Glob'],
  schreiben: ['Write', 'Edit'],
  terminal: ['Bash'],
  web: ['WebSearch', 'WebFetch'],
};

// Aus einem Namen wie „Mein SEO Prüfer“ wird „mein-seo-pruefer“.
function slugify(name) {
  return String(name || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// YAML-sicherer Einzeiler (Anführungszeichen, keine Zeilenumbrüche).
const yamlLine = (v) => JSON.stringify(String(v || '').replace(/\s*\n\s*/g, ' ').trim());

function splitFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

function parseTools(value) {
  const v = String(value || '').trim();
  if (!v) return [];
  try { const arr = JSON.parse(v); if (Array.isArray(arr)) return arr.map(String); } catch {}
  return v.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function agentFile(id, active, root = CLAUDE_DIR) {
  if (typeof id !== 'string' || !/^[\w.-]+\.md$/.test(id) || id.startsWith('.')) return null;
  return path.join(root, active ? 'agents' : 'agents-archiv', id);
}

function readAgent(id, root = CLAUDE_DIR) {
  for (const active of [true, false]) {
    const file = agentFile(id, active, root);
    if (!file || !fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const fm = frontmatter(text);
    return { ok: true, data: { id, active, name: fm.name || id.replace(/\.md$/, ''), description: fm.description || '',
      model: MODELS.includes(fm.model) ? fm.model : 'inherit', tools: parseTools(fm.tools), body: splitFrontmatter(text).trim() } };
  }
  return { ok: false, error: 'Diesen Agenten gibt es nicht.' };
}

// Legt einen Agenten an (id fehlt) oder ändert einen bestehenden (id gesetzt). Neue Agenten sind sofort aktiv.
function saveAgent(input, root = CLAUDE_DIR) {
  const a = input && typeof input === 'object' ? input : {};
  const name = slugify(a.name);
  if (!SLUG.test(name)) return { ok: false, error: 'Der Name braucht mindestens 2 Zeichen (Buchstaben, Zahlen, Bindestriche).' };
  const description = String(a.description || '').trim();
  if (description.length < 10) return { ok: false, error: 'Beschreib in einem Satz, wofür der Agent da ist und wann Claude ihn einsetzen soll.' };
  const body = String(a.body || '').trim();
  if (body.length < 20) return { ok: false, error: 'Die Anweisungen sind zu kurz – schreib, wie der Agent arbeiten soll.' };
  const model = MODELS.includes(a.model) ? a.model : 'inherit';
  const known = new Set(Object.values(TOOL_GROUPS).flat());
  const tools = Array.isArray(a.tools) ? [...new Set(a.tools.filter((t) => known.has(t)))] : [];
  const id = `${name}.md`;
  let file = agentFile(id, true, root);
  if (a.id) {
    const old = readAgent(a.id, root);
    if (!old.ok) return old;
    const oldFile = agentFile(a.id, old.data.active, root);
    file = agentFile(id, old.data.active, root);
    if (a.id !== id && (fs.existsSync(agentFile(id, true, root)) || fs.existsSync(agentFile(id, false, root)))) {
      return { ok: false, error: `Es gibt schon einen Agenten „${name}“.` };
    }
    if (a.id !== id) fs.renameSync(oldFile, file);
  } else if (fs.existsSync(agentFile(id, true, root)) || fs.existsSync(agentFile(id, false, root))) {
    return { ok: false, error: `Es gibt schon einen Agenten „${name}“.` };
  }
  const head = ['---', `name: ${name}`, `description: ${yamlLine(description)}`];
  if (model !== 'inherit') head.push(`model: ${model}`);
  if (tools.length) head.push(`tools: ${tools.join(', ')}`);
  head.push('---', '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${head.join('\n')}${body}\n`);
  return { ok: true, id };
}

function skillDir(name, root = CLAUDE_DIR) {
  return SLUG.test(name) ? path.join(root, 'skills', name) : null;
}

// Eigene Skills liegen direkt in ~/.claude/skills/<name>/SKILL.md – nur die lassen sich hier ändern oder löschen.
function ownSkillDir(file, root = CLAUDE_DIR) {
  const rel = path.relative(path.join(root, 'skills'), String(file || '')).split(path.sep);
  return rel.length === 2 && rel[1] === 'SKILL.md' && SLUG.test(rel[0]) ? path.join(root, 'skills', rel[0]) : null;
}

function saveSkill(input, root = CLAUDE_DIR) {
  const a = input && typeof input === 'object' ? input : {};
  const name = slugify(a.name);
  const dir = skillDir(name, root);
  if (!dir) return { ok: false, error: 'Der Name braucht mindestens 2 Zeichen (Buchstaben, Zahlen, Bindestriche).' };
  const description = String(a.description || '').trim();
  if (description.length < 10) return { ok: false, error: 'Beschreib, was der Skill tut und wann Claude ihn benutzen soll.' };
  const body = String(a.body || '').trim();
  if (body.length < 20) return { ok: false, error: 'Die Anleitung ist zu kurz.' };
  const file = path.join(dir, 'SKILL.md');
  if (!a.edit && fs.existsSync(file)) return { ok: false, error: `Es gibt schon einen Skill „${name}“.` };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${yamlLine(description)}\n---\n\n${body}\n`);
  return { ok: true, name, file };
}

function readSkill(file, root = CLAUDE_DIR) {
  if (!ownSkillDir(file, root) || !fs.existsSync(file)) return { ok: false, error: 'Nur eigene Skills lassen sich hier bearbeiten.' };
  const text = fs.readFileSync(file, 'utf8');
  const fm = frontmatter(text);
  return { ok: true, data: { name: fm.name || path.basename(path.dirname(file)), description: fm.description || '', body: splitFrontmatter(text).trim() } };
}

// Plugins aus den lokal bekannten Marktplätzen (zum Entdecken neuer Skills und Agenten).
function listMarketplace(root = CLAUDE_DIR) {
  const dir = path.join(root, 'plugins', 'marketplaces');
  let markets = [];
  try { markets = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  const installed = new Set(listPlugins(root).map((p) => p.name));
  const out = [];
  for (const m of markets) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, m, '.claude-plugin', 'marketplace.json'), 'utf8')); } catch { continue; }
    for (const p of (data && Array.isArray(data.plugins) ? data.plugins : [])) {
      if (!p || typeof p.name !== 'string') continue;
      out.push({ name: p.name, marketplace: (data.name || m), description: String(p.description || '').slice(0, 300),
        category: p.category || 'sonstiges', installed: installed.has(p.name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function library(root = CLAUDE_DIR) {
  return { skills: listSkills(root), commands: listCommands(root), plugins: listPlugins(root), agents: listAgents(root) };
}

module.exports = { frontmatter, listSkills, listCommands, listPlugins, listAgents, setAgentActive, runningWork, library, CLAUDE_DIR,
  slugify, readAgent, saveAgent, agentFile, saveSkill, readSkill, ownSkillDir, listMarketplace, TOOL_GROUPS, MODELS };

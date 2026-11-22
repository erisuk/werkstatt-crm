// Claude verwalten wie in der Claude-App: Versionen und Updates von Claude Code, Plugins an/aus, aktualisieren,
// entfernen, suchen und installieren. Alles über die offiziellen Befehle (claude plugin …, npm) – nichts von Hand.
const { execFile } = require('child_process');
const fs = require('fs');

const PACKAGE = '@anthropic-ai/claude-code';
const CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const PLUGIN_ID = /^[a-z0-9][\w.-]{0,80}(@[a-z0-9][\w.-]{0,80})?$/i;
const OPS = { enable: ['enable'], disable: ['disable'], update: ['update'], uninstall: ['uninstall'], install: ['install'] };
const MAX_RESULTS = 30;

function run(bin, args, { env, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '').trim() }));
  });
}

const parseVersion = (text) => { const m = /(\d+\.\d+\.\d+)/.exec(String(text || '')); return m ? m[1] : null; };

// a < b nach Versionsnummer (2.1.329 < 2.1.330 < 2.2.0)
function older(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

function appVersion(plist = '/Applications/Claude.app/Contents/Info.plist') {
  try {
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(plist, 'utf8'));
    return m ? m[1] : null;
  } catch { return null; } // binäre plist: dann ohne Anzeige
}

// claude: Pfad zur Kommandozeile, npm: Pfad zu npm (aus derselben Installation), env: Umgebung mit PATH.
// env darf eine Funktion sein: Die Umgebung (PATH) steht erst fest, wenn Claude gefunden ist.
function createClaudeAdmin({ claude, npm = 'npm', env: envOf, exec = run, now = Date.now }) {
  const env = () => (typeof envOf === 'function' ? envOf() : envOf);
  let versionCache = { at: 0, value: null };
  async function versions({ force = false } = {}) {
    if (!force && versionCache.value && now() - versionCache.at < 6 * 60 * 60 * 1000) return versionCache.value;
    const [mine, latest] = await Promise.all([exec(claude(), ['--version'], { env: env(), timeout: 20000 }),
      exec(npm, ['view', PACKAGE, 'version'], { env: env(), timeout: 30000 })]);
    const installed = parseVersion(mine.out);
    const newest = parseVersion(latest.out);
    const value = { installed, latest: newest, update: !!(installed && newest && older(installed, newest)), app: appVersion(),
      changelog: CHANGELOG, checkedAt: now(), offline: !latest.ok };
    versionCache = { at: now(), value };
    return value;
  }

  async function updateClaude() {
    const r = await exec(npm, ['install', '-g', `${PACKAGE}@latest`], { env: env(), timeout: 5 * 60 * 1000 });
    if (!r.ok) return { ok: false, error: `Das Update ging nicht: ${r.err.split('\n').slice(-3).join(' ').slice(0, 300)}` };
    return { ok: true, data: await versions({ force: true }) };
  }

  async function plugins() {
    const r = await exec(claude(), ['plugin', 'list', '--json'], { env: env() });
    if (!r.ok) return { ok: false, error: 'Die Plugins ließen sich nicht lesen.' };
    try {
      const list = JSON.parse(r.out);
      return { ok: true, data: (Array.isArray(list) ? list : list.installed || []).map((p) => ({ id: String(p.id), version: p.version || null,
        enabled: p.enabled !== false, scope: p.scope || null })) };
    } catch { return { ok: false, error: 'Unerwartete Antwort beim Lesen der Plugins.' }; }
  }

  let availableCache = { at: 0, list: [] };
  async function search(query) {
    const q = String(query || '').trim().toLowerCase().slice(0, 80);
    if (!q) return { ok: true, data: [] };
    if (now() - availableCache.at > 30 * 60 * 1000) {
      const r = await exec(claude(), ['plugin', 'list', '--json', '--available'], { env: env(), timeout: 90000 });
      try { availableCache = { at: now(), list: (JSON.parse(r.out).available || []) }; } catch { return { ok: false, error: 'Der Marktplatz ließ sich nicht laden.' }; }
    }
    const hits = availableCache.list.filter((p) => `${p.name || ''} ${p.description || ''}`.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS).map((p) => ({ id: String(p.pluginId || p.name), name: String(p.name || p.pluginId), description: String(p.description || '').slice(0, 240) }));
    return { ok: true, data: hits };
  }

  async function action(op, id) {
    if (!OPS[op]) return { ok: false, error: 'Unbekannte Aktion.' };
    if (!PLUGIN_ID.test(String(id || ''))) return { ok: false, error: 'Ungültiger Plugin-Name.' };
    const r = await exec(claude(), ['plugin', ...OPS[op], String(id)], { env: env(), timeout: 3 * 60 * 1000 });
    if (!r.ok) return { ok: false, error: (r.err || r.out).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || 'Ging nicht.' };
    availableCache = { at: 0, list: [] };
    return plugins();
  }

  return { versions, updateClaude, plugins, search, action };
}

module.exports = { createClaudeAdmin, parseVersion, older, PLUGIN_ID };

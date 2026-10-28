// Mac-Gesundheit: Speicherplatz, Arbeitsspeicher, Akku, größte Ordner und Programme, Aufräum-Hinweise.
// Nur lesen und zeigen – gelöscht wird hier nichts (außer der Nutzer leert selbst den Papierkorb).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });
}

const GB = 1024 ** 3;
const round1 = (n) => Math.round(n * 10) / 10;

// Freier Platz auf der Startfestplatte (statfs, wie im Finder „verfügbar“).
async function disk() {
  try {
    const st = await fs.promises.statfs('/System/Volumes/Data').catch(() => fs.promises.statfs('/'));
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { ok: true, total: round1(total / GB), free: round1(free / GB), usedPct: Math.round((1 - free / total) * 100) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Arbeitsspeicher: belegt laut macOS (aktiv + festgelegt + komprimiert), nicht nur „frei“.
async function memory() {
  const total = os.totalmem();
  const out = await run('/usr/bin/vm_stat', []);
  const page = Number((/page size of (\d+)/.exec(out) || [])[1] || 16384);
  const val = (label) => Number(((new RegExp(`${label}:\\s+(\\d+)`)).exec(out) || [])[1] || 0) * page;
  const used = val('Pages active') + val('Pages wired down') + val('Pages occupied by compressor');
  const pressure = (await run('/usr/bin/memory_pressure', ['-Q'])).match(/(\d+)%/);
  return { ok: true, total: round1(total / GB), used: round1((used || total - os.freemem()) / GB),
    freePct: pressure ? Number(pressure[1]) : Math.round((os.freemem() / total) * 100) };
}

async function battery() {
  const out = await run('/usr/bin/pmset', ['-g', 'batt']);
  const m = /(\d+)%;\s*([^;]+);/.exec(out);
  if (!m) return { ok: true, present: false };
  return { ok: true, present: true, percent: Number(m[1]), state: m[2].trim(), onPower: /AC Power/.test(out) };
}

// Programme mit dem meisten Arbeitsspeicher (zusammengefasst nach Namen).
async function topProcesses(limit = 8) {
  const out = await run('/bin/ps', ['-axo', 'rss=,comm=']);
  const byName = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = path.basename(m[2].trim()).replace(/ Helper.*$/, '');
    byName.set(name, (byName.get(name) || 0) + Number(m[1]) * 1024);
  }
  return [...byName.entries()].map(([name, bytes]) => ({ name, gb: round1(bytes / GB) }))
    .sort((a, b) => b.gb - a.gb).slice(0, limit);
}

// Größe eines Ordners in GB (du -sk, mit Zeitlimit; große Ordner können dauern).
async function folderSize(dir, timeout = 60000) {
  const out = await run('/usr/bin/du', ['-sk', dir], timeout);
  const kb = Number((/^(\d+)/.exec(out.trim()) || [])[1] || 0);
  return round1((kb * 1024) / GB);
}

// Die größten Ordner direkt im Benutzerordner plus bekannte Platzfresser.
async function bigFolders(limit = 12) {
  let entries = [];
  try { entries = fs.readdirSync(HOME, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')); } catch {}
  const known = [
    ['Papierkorb', path.join(HOME, '.Trash'), 'Papierkorb leeren gibt den Platz frei.'],
    ['Caches', path.join(HOME, 'Library', 'Caches'), 'Zwischenspeicher von Apps – macOS und die Apps bauen ihn bei Bedarf neu auf.'],
    ['Ollama-Modelle', path.join(HOME, '.ollama', 'models'), 'Lokale KI-Modelle – nicht benutzte kannst du in Ollama entfernen.'],
    ['Hugging Face', path.join(HOME, '.cache', 'huggingface'), 'Heruntergeladene KI-Modelle – nicht benutzte entfernen.'],
    ['Xcode-Daten', path.join(HOME, 'Library', 'Developer', 'Xcode', 'DerivedData'), 'Xcode-Zwischenstände – lassen sich gefahrlos löschen.'],
    ['npm-Cache', path.join(HOME, '.npm'), 'npm-Zwischenspeicher – „npm cache clean --force“.'],
  ].filter(([, p]) => fs.existsSync(p));
  const dirs = [...entries.map((e) => ({ name: e.name, path: path.join(HOME, e.name), hint: null })),
    ...known.map(([name, p, hint]) => ({ name, path: p, hint, known: true }))];
  const sized = [];
  // Nacheinander in kleinen Gruppen, damit der Mac nicht ins Stocken gerät.
  for (let i = 0; i < dirs.length; i += 4) {
    const part = await Promise.all(dirs.slice(i, i + 4).map(async (d) => ({ ...d, gb: await folderSize(d.path) })));
    sized.push(...part);
  }
  return sized.filter((d) => d.gb >= 0.1).sort((a, b) => b.gb - a.gb).slice(0, limit);
}

// Kurzer Gesundheitsbericht (schnell). Ordnergrößen liefert bigFolders separat, weil das dauert.
async function snapshot() {
  const [d, m, b, p] = await Promise.all([disk(), memory(), battery(), topProcesses()]);
  const load = os.loadavg()[0];
  const hints = [];
  if (d.ok && d.free < 15) hints.push(`Nur noch ${d.free} GB frei – ab etwa 10 GB wird der Mac langsam. Schau unten bei den größten Ordnern.`);
  if (m.ok && m.freePct < 20) hints.push('Der Arbeitsspeicher ist knapp – schließ Programme, die du nicht brauchst (siehe Liste).');
  if (load > os.cpus().length * 1.5) hints.push('Der Mac ist gerade stark ausgelastet.');
  return { disk: d, memory: m, battery: b, processes: p, load: round1(load), cpus: os.cpus().length, hints };
}

module.exports = { snapshot, bigFolders, disk, memory, battery, topProcesses, folderSize };

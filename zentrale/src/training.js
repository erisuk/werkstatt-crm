// Trainingsbereich: findet täglich Verbesserungen in Eris' Projekten und macht daraus kleine Mini-Aufgaben für Claude.
// Jede Aufgabe läuft isoliert in einer eigenen Git-Arbeitskopie (git worktree, eigener Zweig) unter ~/Zentrale-Training –
// das echte Projekt bleibt unberührt, bis Eris das Ergebnis ansieht und selbst übernimmt.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = () => path.join(os.homedir(), 'Zentrale-Training');
const BRANCH = 'zentrale-training/';
const MAX_NEW_PER_DAY = 3;
const MAX_OPEN = 15;
const BIG_LINES = 800;
const CODE = /\.(js|ts|tsx|jsx|py|swift|gd|lua|luau|rb|go|rs|css|html)$/i;

function git(cwd, args, timeout = 20000) {
  return new Promise((resolve) => execFile('/usr/bin/git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') })));
}
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Ideen für ein Projekt (ohne Claude, nur aus dem Code). Jede hat einen festen Schlüssel gegen Doppelte.
async function scanProject(dir) {
  const ideas = [];
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return ideas; // nur Git-Projekte – sonst gäbe es keine sichere, abgetrennte Kopie
  dir = top.out.trim(); // ganzes Repo, auch wenn das Projekt in einem Unterordner liegt
  const name = path.basename(dir);
  const add = (kind, target, title, why) => ideas.push({ key: `${dir}|${kind}|${target}`, kind, target, title, why, project: name, dir });
  // 1. TODO/FIXME im Code
  const todo = await git(dir, ['grep', '-n', '-I', '-E', '(TODO|FIXME)[: ]', '--', '.', ':!node_modules', ':!*.min.*', ':!dist', ':!build']);
  for (const line of todo.out.split('\n').filter(Boolean).slice(0, 3)) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (m) add('todo', `${m[1]}:${m[2]}`, `TODO lösen: ${m[1]}:${m[2]}`, m[3].trim().slice(0, 160));
  }
  // 2. Sehr große Dateien (Regel: höchstens 800 Zeilen)
  const files = await git(dir, ['ls-files']);
  const big = [];
  for (const f of files.out.split('\n').filter((x) => CODE.test(x) && !/node_modules|\.min\.|dist\//.test(x)).slice(0, 400)) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.size < 20000) continue;
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length;
      if (lines > BIG_LINES) big.push([f, lines]);
    } catch {}
  }
  for (const [f, lines] of big.sort((a, b) => b[1] - a[1]).slice(0, 2)) add('gross', f, `Große Datei aufteilen: ${f}`, `${lines} Zeilen – über der Grenze von ${BIG_LINES}. In kleinere, verständliche Teile zerlegen, Verhalten gleich lassen.`);
  // 3. Keine Beschreibung
  if (!fs.readdirSync(dir).some((f) => /^readme/i.test(f))) add('readme', 'README', 'README schreiben', 'Es fehlt eine Beschreibung: was das Projekt ist, wie man es startet und testet.');
  // 4. Tests laufen lassen
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  if (pkg && pkg.scripts && pkg.scripts.test && !/no test specified/.test(pkg.scripts.test)) add('tests', 'npm test', 'Tests laufen lassen und Fehler beheben', 'Prüfen, ob alle Tests grün sind; rote Tests reparieren (Code, nicht die Tests – außer der Test ist falsch).');
  else if (fs.existsSync(path.join(dir, 'tests')) || fs.existsSync(path.join(dir, 'test'))) add('tests', 'tests', 'Tests laufen lassen und Fehler beheben', 'Es gibt einen Test-Ordner – prüfen, ob alles grün ist.');
  else if (pkg || fs.existsSync(path.join(dir, 'pyproject.toml'))) add('ohne-tests', 'tests', 'Ersten Test schreiben', 'Das Projekt hat noch keine Tests. Einen kleinen Test für die wichtigste Funktion anlegen.');
  return ideas;
}

class TrainingStore {
  constructor(file) {
    this.file = file;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    this.tasks = Array.isArray(d.tasks) ? d.tasks.filter((t) => t && typeof t.id === 'string') : [];
    this.lastScan = typeof d.lastScan === 'string' ? d.lastScan : null;
    this.settings = { time: /^\d{2}:\d{2}$/.test(d.settings && d.settings.time) ? d.settings.time : '09:00', enabled: !(d.settings && d.settings.enabled === false) };
    this.seen = new Set(Array.isArray(d.seen) ? d.seen.slice(-2000) : []); // erledigte/verworfene Ideen nicht wieder vorschlagen
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ tasks: this.tasks, lastScan: this.lastScan, settings: this.settings, seen: [...this.seen] }, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }

  list() { return { tasks: [...this.tasks], lastScan: this.lastScan, settings: { ...this.settings }, root: ROOT() }; }

  isDue(now = new Date()) {
    if (!this.settings.enabled || this.lastScan === localDay(now)) return false;
    const [hh, mm] = this.settings.time.split(':').map(Number);
    return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
  }

  // Neue Ideen als Aufgaben aufnehmen: höchstens 3 am Tag, 15 offen, nichts doppelt oder schon verworfen.
  addIdeas(ideas, extra = [], now = new Date()) {
    const open = this.tasks.filter((t) => ['offen', 'läuft', 'fertig'].includes(t.status));
    const have = new Set([...this.tasks.map((t) => t.key), ...this.seen]);
    const fresh = [...extra, ...ideas].filter((i) => !have.has(i.key));
    const take = fresh.slice(0, Math.max(0, Math.min(MAX_NEW_PER_DAY, MAX_OPEN - open.length)));
    for (const i of take) this.tasks.unshift({ id: crypto.randomUUID().slice(0, 8), ...i, status: 'offen', createdAt: now.getTime(), branch: null, worktree: null });
    this.lastScan = localDay(now);
    this.save();
    return take.length;
  }

  update(id, patch) {
    this.tasks = this.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.save();
    return this.tasks.find((t) => t.id === id) || null;
  }

  drop(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (t) this.seen.add(t.key);
    this.tasks = this.tasks.filter((x) => x.id !== id);
    this.save();
  }

  setSettings(s) {
    if (s && /^\d{2}:\d{2}$/.test(s.time)) this.settings.time = s.time;
    if (s && typeof s.enabled === 'boolean') this.settings.enabled = s.enabled;
    this.save();
  }
}

// Isolierte Arbeitskopie anlegen (eigener Zweig vom aktuellen Stand).
async function createWorktree(task) {
  const wt = path.join(ROOT(), `${task.project.replace(/[^\w.-]/g, '-')}-${task.id}`);
  const branch = `${BRANCH}${task.id}`;
  fs.mkdirSync(ROOT(), { recursive: true });
  const r = await git(task.dir, ['worktree', 'add', '-b', branch, wt, 'HEAD']);
  if (!r.ok) return { ok: false, error: `Die Trainings-Kopie ließ sich nicht anlegen: ${r.err.split('\n')[0]}` };
  return { ok: true, worktree: wt, branch };
}

// Was hat sich in der Kopie getan? (Commits auf dem Zweig + offene Änderungen)
async function changes(task) {
  if (!task.worktree || !fs.existsSync(task.worktree)) return { ok: false, error: 'Die Trainings-Kopie gibt es nicht mehr.' };
  const status = await git(task.worktree, ['status', '--porcelain']);
  const base = await git(task.dir, ['merge-base', 'HEAD', task.branch]);
  const stat = await git(task.worktree, ['diff', '--stat', base.ok ? base.out.trim() : 'HEAD']);
  return { ok: true, dirty: status.out.trim().split('\n').filter(Boolean).length, stat: stat.out.trim().split('\n').slice(-12).join('\n') };
}

// Übernehmen: Änderungen in der Kopie committen und in den aktuellen Zweig des echten Projekts holen.
async function adopt(task) {
  const c = await changes(task);
  if (!c.ok) return c;
  if (c.dirty) {
    await git(task.worktree, ['add', '-A']);
    const ci = await git(task.worktree, ['commit', '-m', `training: ${task.title}`]);
    if (!ci.ok) return { ok: false, error: `Commit in der Kopie ging nicht: ${ci.err.split('\n')[0]}` };
  }
  const clean = await git(task.dir, ['status', '--porcelain', '--untracked-files=no']);
  if (clean.out.trim()) return { ok: false, error: 'Im echten Projekt gibt es gerade nicht gespeicherte Änderungen – erst committen, dann übernehmen.' };
  const m = await git(task.dir, ['merge', '--no-ff', '--no-edit', task.branch]);
  if (!m.ok) { await git(task.dir, ['merge', '--abort']); return { ok: false, error: 'Das ließ sich nicht konfliktfrei übernehmen – nichts wurde geändert.' }; }
  await discard(task);
  return { ok: true };
}

// Verwerfen: Kopie und Trainings-Zweig weg (das echte Projekt war nie berührt).
async function discard(task) {
  if (task.worktree) await git(task.dir, ['worktree', 'remove', '--force', task.worktree]);
  if (task.branch && task.branch.startsWith(BRANCH)) await git(task.dir, ['branch', '-D', task.branch]);
  return { ok: true };
}

function trainPrompt(task) {
  const q = (s) => JSON.stringify(String(s || ''));
  return [
    `TRAINING (isolierte Kopie von ${q(task.project)}): Mini-Aufgabe ${q(task.title)}.`,
    task.why ? `Warum: ${q(task.why)}` : null,
    '',
    'Du arbeitest in einer abgetrennten Git-Arbeitskopie auf einem eigenen Zweig – das echte Projekt bleibt unberührt.',
    'Regeln: klein halten (eine Sache), Verhalten nur ändern, wenn die Aufgabe es verlangt, vorhandene Tests laufen lassen, keine Abhängigkeiten installieren, nichts pushen, keine Geheimnisse anfassen.',
    'Am Ende: kurze Zusammenfassung „Was ich geändert habe“, „Wie ich es geprüft habe“, „Was Eris vor dem Übernehmen ansehen sollte“. Committe nicht selbst – das macht die Zentrale beim Übernehmen.',
  ].filter((x) => x !== null).join('\n');
}

module.exports = { TrainingStore, scanProject, createWorktree, changes, adopt, discard, trainPrompt, ROOT, BRANCH, localDay };

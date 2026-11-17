// „Änderungen ansehen“ in der Info-Leiste: was in einem Git-Ordner noch nicht committet ist (Dateien mit +/−)
// und der Unterschied (Diff) einer Datei – wie die Diff-Ansicht der Claude-App. Nur lesen, nie etwas ändern.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT_MS = 6000;
const MAX_FILES = 60;
const MAX_DIFF = 200 * 1024; // so viel Text zeigt die Ansicht höchstens

function run(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// git status --porcelain=v1 -z → [{ path, status }] (status: neu, geändert, gelöscht, umbenannt)
function parseStatus(text) {
  const parts = String(text || '').split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i += 1; // danach steht der alte Name
    const status = code === '??' ? 'neu' : code.includes('D') ? 'gelöscht' : code.includes('A') ? 'neu' : code[0] === 'R' ? 'umbenannt' : 'geändert';
    out.push({ path: file, status });
  }
  return out;
}

// git diff --numstat → Map Pfad → { plus, minus } ("-" bei Binärdateien)
function parseNumstat(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) map.set(m[3], { plus: m[1] === '-' ? null : +m[1], minus: m[2] === '-' ? null : +m[2] });
  }
  return map;
}

// Datei gehört wirklich zum Repository (kein ../, keine Verknüpfung nach draußen).
function inside(root, rel) {
  const p = path.resolve(root, rel);
  return p.startsWith(root + path.sep) ? p : null;
}

async function changes(cwd, git = run) {
  const rootText = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!rootText) return { git: false };
  const root = rootText.trim();
  const status = parseStatus(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root));
  const nums = parseNumstat(await git(['diff', 'HEAD', '--numstat'], root));
  // Ganze neue Ordner (z. B. eingebettete Git-Projekte) meldet Git mit „/“ am Ende – die kommen ans Ende der Liste.
  const sorted = [...status].sort((a, b) => a.path.endsWith('/') - b.path.endsWith('/'));
  const files = sorted.slice(0, MAX_FILES).map((f) => {
    if (f.path.endsWith('/')) return { ...f, ordner: true, plus: null, minus: null };
    const n = nums.get(f.path);
    if (n) return { ...f, ...n };
    if (f.status === 'neu') {
      const full = inside(root, f.path);
      let plus = null;
      try { const t = fs.readFileSync(full, 'utf8'); plus = t.includes('\0') ? null : t.split('\n').length; } catch { /* nicht lesbar */ }
      return { ...f, plus, minus: 0 };
    }
    return { ...f, plus: null, minus: null };
  });
  return { git: true, root, files, more: Math.max(0, status.length - MAX_FILES) };
}

// Diff einer Datei. Neue Dateien zeigen ihren ganzen Inhalt als hinzugefügt.
async function fileDiff(cwd, rel, git = run) {
  const rootText = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!rootText) return { ok: false, error: 'Kein Git-Projekt.' };
  const root = rootText.trim();
  const full = inside(root, String(rel || ''));
  if (!full) return { ok: false, error: 'Diese Datei gehört nicht zum Projekt.' };
  const relClean = path.relative(root, full);
  let text = await git(['diff', 'HEAD', '--no-color', '--', relClean], root);
  if (!text) {
    const tracked = await git(['ls-files', '--error-unmatch', '--', relClean], root);
    if (tracked === null) {
      try {
        const body = fs.readFileSync(full, 'utf8');
        if (body.includes('\0')) return { ok: true, data: { path: relClean, diff: '', binary: true } };
        text = `+++ ${relClean} (neu)\n${body.split('\n').map((l) => `+${l}`).join('\n')}`;
      } catch { return { ok: false, error: 'Die Datei gibt es nicht mehr.' }; }
    }
  }
  const diff = String(text || '');
  return { ok: true, data: { path: relClean, diff: diff.slice(0, MAX_DIFF), cut: diff.length > MAX_DIFF, binary: /^Binary files/m.test(diff) } };
}

module.exports = { changes, fileDiff, parseStatus, parseNumstat };

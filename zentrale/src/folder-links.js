// Ordner und Projekte verbinden: Ein Chat arbeitet außer in seinem Ordner auch in weiteren (claude --add-dir).
// Verknüpfte Projekte gehören dauerhaft zusammen: Jeder neue Chat im einen sieht den anderen gleich mit.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DIRS = 8;

// Nur echte Ordner im Benutzerordner, nie versteckte (.ssh, .config …) und nie der Benutzerordner selbst.
function cleanDir(p, home = os.homedir()) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  let real;
  try { real = fs.realpathSync.native(p); if (!fs.statSync(real).isDirectory()) return null; } catch { return null; }
  let root;
  try { root = fs.realpathSync.native(home); } catch { root = home; }
  if (!real.startsWith(root + path.sep)) return null;
  if (real.slice(root.length + 1).split(path.sep).some((part) => part.startsWith('.'))) return null;
  return real;
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, MAX_DIRS);
    return out;
  } catch { return {}; }
}

function save(file, links) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(links, null, 2));
}

// Mit welchen Ordnern ist `dir` verknüpft?
function linked(links, dir) {
  return Array.isArray(links[dir]) ? links[dir] : [];
}

// Verknüpfen gilt in beide Richtungen. Gibt eine neue Liste zurück, die alte bleibt unverändert.
function link(links, a, b) {
  if (!a || !b || a === b) return links;
  const add = (from, to) => (linked(links, from).includes(to) ? linked(links, from) : [...linked(links, from), to].slice(0, MAX_DIRS));
  return { ...links, [a]: add(a, b), [b]: add(b, a) };
}

function unlink(links, a, b) {
  const drop = (from, to) => linked(links, from).filter((x) => x !== to);
  const next = { ...links, [a]: drop(a, b), [b]: drop(b, a) };
  for (const k of [a, b]) if (!next[k].length) delete next[k];
  return next;
}

// Zusätzliche Ordner eines Chats: ohne den eigenen Ordner, ohne doppelte, höchstens MAX_DIRS.
function mergeDirs(cwd, ...lists) {
  const out = [];
  for (const d of lists.flat()) if (d && d !== cwd && !out.includes(d)) out.push(d);
  return out.slice(0, MAX_DIRS);
}

module.exports = { cleanDir, load, save, linked, link, unlink, mergeDirs, MAX_DIRS };

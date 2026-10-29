// Ein Arbeitsschritt von Claude (Werkzeugaufruf) als kurze Zeile für den Chat: welches Werkzeug, worauf.
// Gemeinsam für den laufenden Chat (claude.js) und den gespeicherten Verlauf (sessions.js).
const path = require('path');

const MAX_DETAIL = 140;

function firstLine(v) {
  return String(v == null ? '' : v).split('\n')[0].trim().slice(0, MAX_DETAIL);
}

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return firstLine(url); }
}

// detail: das Wichtigste in einer Zeile – Dateiname, Befehl, Suchbegriff, Adresse.
function stepDetail(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash') return firstLine(i.description || i.command);
  if (/^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return firstLine(path.basename(String(i.file_path || i.notebook_path || '')));
  if (name === 'Grep' || name === 'Glob') return firstLine(i.pattern);
  if (name === 'WebFetch') return hostOf(i.url);
  if (name === 'WebSearch') return firstLine(i.query);
  if (name === 'Task' || name === 'Agent') return firstLine(i.description || i.subagent_type);
  if (name === 'Skill') return firstLine(i.skill || i.command);
  return firstLine(i.description || i.file_path || i.path || i.url || i.query || i.command || i.title || i.name || '');
}

function toolStep(name, input) {
  const tool = String(name || 'Werkzeug');
  return { tool, detail: stepDetail(tool, input) };
}

module.exports = { toolStep, stepDetail };

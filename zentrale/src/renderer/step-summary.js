// Arbeitsschritte als ein Satz wie in der Claude-App: „Ausgeführt 2 Befehle (1 fehlgeschlagen), las bild.png“.
// Läuft im Fenster (globale Funktion) und in den Tests (module.exports).

const SERVER_NAMES = {
  'google-workspace': 'Google Workspace', mac: 'Mac', web: 'Web-Tabs', 'claude-in-chrome': 'Chrome', n8n: 'n8n',
  kommentare: 'Kommentare', github: 'GitHub', playwright: 'Playwright', context7: 'Context7', higgsfield: 'Higgsfield',
};

// mcp__claude_ai_Gmail__search_threads → „Gmail“
function serverName(tool) {
  const raw = String(tool).split('__')[1] || '';
  const name = raw.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '');
  return SERVER_NAMES[name] || name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Werkzeug';
}

const isImagePath = (p) => /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i.test(String(p || ''));

function count(n, one, many) {
  return n === 1 ? one : `${n} ${many}`;
}

// Bis zu zwei Namen ausschreiben, sonst zählen.
function names(list, many) {
  const uniq = [...new Set(list.filter(Boolean))];
  if (uniq.length && uniq.length <= 2) return uniq.join(' und ');
  return `${list.length} ${many}`;
}

function categoryOf(tool) {
  const t = String(tool || '');
  if (t === 'Bash') return 'cmd';
  if (t === 'Read') return 'read';
  if (t === 'Write') return 'write';
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(t)) return 'edit';
  if (t === 'Grep' || t === 'Glob') return 'search';
  if (t === 'WebFetch') return 'web';
  if (t === 'WebSearch') return 'websearch';
  if (t === 'Task' || t === 'Agent') return 'agent';
  if (t === 'TodoWrite') return 'todo';
  if (t === 'AskUserQuestion') return 'ask';
  if (t.startsWith('mcp__')) return `mcp:${serverName(t)}`;
  return `other:${t || 'Werkzeug'}`;
}

function phrase(cat, steps) {
  const n = steps.length;
  const details = steps.map((s) => s.detail);
  if (cat === 'cmd') return `ausgeführt ${count(n, 'einen Befehl', 'Befehle')}`;
  if (cat === 'read') return `las ${names(details, 'Dateien')}`;
  if (cat === 'write') return `erstellte ${names(details, 'Dateien')}`;
  if (cat === 'edit') return `bearbeitete ${names(details, 'Dateien')}`;
  if (cat === 'search') return n === 1 && details[0] ? `suchte nach „${details[0]}“` : `suchte ${n}-mal in Dateien`;
  if (cat === 'web') return `las ${count(n, 'eine Webseite', 'Webseiten')}`;
  if (cat === 'websearch') return n === 1 ? 'suchte im Netz' : `suchte ${n}-mal im Netz`;
  if (cat === 'agent') return `beauftragte ${count(n, 'einen Agenten', 'Agenten')}`;
  if (cat === 'todo') return 'aktualisierte die Aufgabenliste';
  if (cat === 'ask') return n === 1 ? 'fragte dich' : `fragte dich ${n}-mal`;
  const name = cat.slice(cat.indexOf(':') + 1);
  return n === 1 ? `nutzte ${name}` : `nutzte ${name} (${n}×)`;
}

function stepSummary(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return '';
  const groups = new Map();
  for (const s of list) {
    const cat = categoryOf(s.tool);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(s);
  }
  const parts = [...groups].map(([cat, g]) => {
    const failed = g.filter((s) => s.error).length;
    return phrase(cat, g) + (failed ? ` (${failed} fehlgeschlagen)` : '');
  });
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Das zuletzt angeschaute Bild einer Schrittgruppe (für die kleine Vorschau).
function lastImage(steps) {
  const imgs = (Array.isArray(steps) ? steps : []).filter((s) => s.tool === 'Read' && isImagePath(s.path));
  return imgs.length ? imgs[imgs.length - 1].path : null;
}

if (typeof module !== 'undefined') module.exports = { stepSummary, lastImage, serverName, isImagePath };

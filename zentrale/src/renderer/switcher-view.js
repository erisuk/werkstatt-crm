// Schnellsprung (Cmd+K): tippen, Pfeiltasten, Enter – zu jeder Seite, jedem Projekt, Gespräch, Web-Tab,
// Server und jeder Website. Ein Projekt anspringen heißt: Claude arbeitet dort weiter. Nutzt die Helfer aus app.js.

const sw = { open: false, query: '', index: 0, items: [], servers: null, sites: null };
const SW_PAGES = [['overview', 'Übersicht'], ['chat', 'Chat'], ['brain', 'Gehirn'], ['web', 'Web'], ['websites', 'Websites'], ['planner', 'Planer'],
  ['bitvideos', 'Bit-Videos'], ['automations', 'Automatisierungen'], ['local', 'Localhost'], ['projects', 'Projekte & Server'], ['mac', 'Mein Mac'],
  ['library', 'Skills & Agenten'], ['tasks', 'Tägliche Aufgaben'], ['finance', 'Privat'], ['lernen', 'Lernen & Training'], ['kontrolle', 'Kontrollraum'], ['connections', 'Verbindungen']];

// Einfache Treffer-Bewertung: Wortanfang schlägt Mitte, alle Suchwörter müssen vorkommen.
function swScore(text, q) {
  const t = text.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return -1;
    score += i === 0 ? 30 : /\s|[-·/]/.test(t[i - 1]) ? 20 : 5;
  }
  return score;
}

function swCandidates() {
  const s = ui.state;
  const out = SW_PAGES.map(([v, label]) => ({ kind: 'Seite', label, run: () => setView(v) }));
  for (const p of projects()) {
    if (p.path) out.push({ kind: 'Projekt', label: p.name, sub: p.path.replace(/^\/Users\/[^/]+/, '~'), run: () => newSession(p.path) });
    for (const x of p.sessions.slice(0, 40)) out.push({ kind: 'Gespräch', label: x.title, sub: p.name, at: x.updatedAt, run: () => openSession(x) });
  }
  for (const p of (webv.state ? webv.state.portals : [])) {
    const local = isLocalUrl(p.url);
    out.push({ kind: local ? 'Localhost' : 'Web-Tab', label: p.name, sub: p.url, run: () => { api.webShow(p.id); setView(local ? 'local' : 'web'); } });
  }
  for (const x of sw.servers || []) out.push({ kind: 'Server', label: `${x.title || x.project || x.proc} :${x.port}`, sub: x.url, run: () => { api.openInTab(x.url).then(() => setView('local')); } });
  for (const x of sw.sites || []) out.push({ kind: 'Website', label: x.name, sub: x.dir.replace(/^\/Users\/[^/]+/, '~'), run: () => newSession(x.dir) });
  if (s && s.tasks) for (const t of s.tasks) out.push({ kind: 'Aufgabe', label: t.name, run: () => setView('tasks') });
  return out;
}

function swFilter() {
  const q = sw.query.trim();
  const all = swCandidates();
  if (!q) {
    // Ohne Eingabe: Seiten und die letzten Gespräche.
    const recent = all.filter((x) => x.kind === 'Gespräch').sort((a, b) => b.at - a.at).slice(0, 6);
    return [...recent, ...all.filter((x) => x.kind === 'Seite')].slice(0, 30);
  }
  return all.map((x) => ({ x, s: swScore(`${x.label} ${x.sub || ''} ${x.kind}`, q) })).filter((y) => y.s >= 0)
    .sort((a, b) => b.s - a.s || (b.x.at || 0) - (a.x.at || 0)).slice(0, 30).map((y) => y.x);
}

function swRender() {
  let box = document.getElementById('switcher');
  if (!sw.open) { if (box) box.remove(); return; }
  sw.items = swFilter();
  sw.index = Math.max(0, Math.min(sw.index, sw.items.length - 1));
  if (!box) {
    box = h('div', { id: 'switcher', class: 'switcher-backdrop', onMousedown: (e) => { if (e.target === box) swClose(); } });
    document.body.append(box);
  }
  const input = h('input', { id: 'sw-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'sw-list', 'aria-autocomplete': 'list',
    'aria-activedescendant': sw.items.length ? `sw-item-${sw.index}` : '', placeholder: 'Wohin? Projekt, Gespräch, Seite, Tab, Server …', autocomplete: 'off', spellcheck: 'false' });
  input.value = sw.query;
  input.addEventListener('input', () => { sw.query = input.value; sw.index = 0; swRender(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sw.index = Math.min(sw.items.length - 1, sw.index + 1); swRender(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sw.index = Math.max(0, sw.index - 1); swRender(); }
    else if (e.key === 'Enter') { e.preventDefault(); swRun(sw.items[sw.index]); }
    else if (e.key === 'Escape') { e.preventDefault(); swClose(); }
  });
  fill(box, h('div', { class: 'switcher card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Schnellsprung' },
    input,
    h('ul', { id: 'sw-list', role: 'listbox', class: 'switcher-list' }, sw.items.length ? sw.items.map((x, i) => h('li', {
      id: `sw-item-${i}`, role: 'option', 'aria-selected': String(i === sw.index), class: i === sw.index ? 'on' : '',
      onMousemove: () => { if (sw.index !== i) { sw.index = i; swRender(); } }, onClick: () => swRun(x) },
      h('span', { class: 'kind', text: x.kind }), h('span', { class: 'label', text: x.label }), x.sub ? h('span', { class: 'sub', text: x.sub }) : null))
      : h('li', { class: 'empty', text: 'Nichts gefunden.' })),
    h('div', { class: 'switcher-hint', text: '↑↓ wählen · Enter öffnen · Esc schließen' })));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const on = box.querySelector('li.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function swRun(x) {
  if (!x) return;
  swClose();
  x.run();
}

function swOpen() {
  sw.open = true; sw.query = ''; sw.index = 0;
  // Web-Tabs würden über dem Fenster liegen – solange der Schnellsprung offen ist, ausblenden.
  api.webVisible(false);
  swRender();
  // Server und Websites im Hintergrund dazuholen (aus dem Zwischenspeicher, schnell).
  api.serversList(false).then((l) => { sw.servers = l || []; if (sw.open) swRender(); }).catch(() => {});
  api.studioList().then((d) => { sw.sites = (d && d.sites) || []; if (sw.open) swRender(); }).catch(() => {});
}

function swClose() {
  sw.open = false;
  swRender();
  if (ui.view === 'web' || ui.view === 'local') renderMain(); // Web-Tab wieder zeigen
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (sw.open) swClose(); else swOpen();
  }
});
window.zentrale.onSwitcherToggle(() => { if (sw.open) swClose(); else swOpen(); });

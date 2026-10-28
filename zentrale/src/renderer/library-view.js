// Ansicht „Skills & Agenten“: was gerade arbeitet, alle Agenten (an/aus), Skills, Befehle, Plugins
// und Konnektoren. Nutzt die Helfer aus app.js (h, fill, ui, api …).

const LIB_TABS = [
  { id: 'agents', label: 'Agenten' },
  { id: 'skills', label: 'Skills' },
  { id: 'commands', label: 'Befehle' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'connectors', label: 'Konnektoren' },
  { id: 'discover', label: 'Entdecken' },
];

const lib = { tab: 'agents', data: null, error: null, loading: false, filter: '', agentFilter: 'all', running: null, runningTimer: null };

async function loadLibrary(force) {
  if (lib.loading) { if (force) lib.again = true; return; } // nach dem laufenden Laden noch einmal
  if (lib.data && !force) return;
  lib.loading = true;
  try { lib.data = await api.library(); lib.error = null; } catch (e) { lib.data = null; lib.error = e.message || 'Unbekannter Fehler'; }
  lib.loading = false;
  if (lib.again) { lib.again = false; loadLibrary(true); return; }
  if (ui.view === 'library') renderLibraryBody();
}

async function loadRunning() {
  try { lib.running = await api.runningWork(); } catch { lib.running = null; }
  if (ui.view === 'library') renderRunning();
  else { clearInterval(lib.runningTimer); lib.runningTimer = null; }
}

function libMatches(item) {
  const q = lib.filter;
  return !q || `${item.name} ${item.description || ''} ${item.source || ''}`.toLowerCase().includes(q);
}

// Ein Skill oder Befehl lässt sich direkt im Chat benutzen: der Name steht dann schon im Eingabefeld.
// Ist kein Chat offen, startet einer im zuletzt benutzten Projekt.
async function useInChat(text) {
  if (!ui.state.chat) {
    const recent = projects().find((p) => p.path);
    const res = await api.newSession({ cwd: recent ? recent.path : null });
    if (!res || res.error || !res.chat) { alert((res && res.error) || 'Es konnte kein Chat gestartet werden.'); return; }
    resetChat(res.chat.gen, []);
  }
  ui.prefill = text;
  setView('chat');
}

function itemRow(item, right) {
  return h('div', { class: 'row lib-row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, item.name, item.source ? h('span', { class: 'pill', text: item.source }) : null,
        item.model ? h('span', { class: 'pill blue', text: item.model }) : null),
      item.description ? h('div', { class: 'sub clamp', text: item.description, title: item.description }) : null),
    right);
}

function runningCard(icon, name, where, pill) {
  return h('div', { class: 'card agent' },
    h('div', { class: 'top' },
      h('div', { class: 'claude-avatar', text: icon }),
      h('div', { class: 'grow' }, h('div', { class: 'name', text: name }), h('div', { class: 'where', text: where })),
      h('span', { class: `pill ${pill}`, text: pill === 'amber' ? 'arbeitet' : pill === 'blue' ? 'wartet' : 'aktiv' })));
}

function renderRunning() {
  const box = $('#lib-running');
  if (!box) return;
  const s = ui.state;
  const r = lib.running || { sessions: [], agents: [] };
  if (!changed('libRunning', [s.chat, s.tasks.filter((t) => t.running).map((t) => t.id), r, (s.approvals || []).length])) return;
  const cards = [];
  if (s.chat) {
    const st = chatStatus();
    cards.push(runningCard('C', s.chat.title || 'Neues Gespräch', `Zentrale · ${s.chat.name}`, st.pill === 'amber' ? 'amber' : st.pill === 'blue' ? 'blue' : 'green'));
  }
  for (const t of s.tasks.filter((x) => x.running)) cards.push(runningCard('⏱', t.name, 'Tägliche Aufgabe', 'amber'));
  for (const a of r.agents) cards.push(runningCard('A', a.type, `${a.description || 'Unteragent'}${a.session ? ` · in „${a.session}“` : ''}`, 'amber'));
  for (const x of r.sessions) cards.push(runningCard('›', x.title || 'Gespräch', `anderes Claude-Fenster · ${formatWhen(x.updatedAt)}`, 'amber'));
  fill(box, cards.length ? h('div', { class: 'running-grid' }, cards)
    : h('div', { class: 'card empty', text: 'Gerade arbeitet kein Agent. Hier erscheinen Chats, Aufgaben und Unteragenten, sobald sie loslegen – auch aus anderen Claude-Fenstern.' }));
}

function renderSkillList(list, prefix) {
  const filtered = list.filter(libMatches);
  return h('div', { class: 'card list' }, filtered.length ? filtered.map((x) => itemRow(x,
    h('button', { class: 'link', 'aria-label': `${x.name} im Chat nutzen`, onClick: () => useInChat(`${prefix}${x.name.replace(/^\//, '')} `) }, 'Im Chat nutzen')))
    : h('div', { class: 'empty', text: 'Nichts gefunden.' }));
}

function renderPlugins(list) {
  const filtered = list.filter(libMatches);
  return h('div', { class: 'card list' }, filtered.length ? filtered.map((p) => itemRow({ ...p, source: p.version ? `v${p.version}` : null },
    h('span', { class: 'sub', text: [p.skills && plural(p.skills, 'Skill', 'Skills'), p.commands && plural(p.commands, 'Befehl', 'Befehle'),
      p.agents && plural(p.agents, 'Agent', 'Agenten')].filter(Boolean).join(' · ') })))
    : h('div', { class: 'empty', text: 'Keine Plugins installiert. Plugins fügst du auf claude.ai oder mit „/plugin“ im Terminal hinzu.' }));
}

function renderConnectors() {
  if (!ui.connections) {
    loadConnections().then(() => { if (ui.view === 'library') renderLibraryBody(); });
    return h('div', { class: 'card empty', text: 'Konnektoren werden geprüft … (das dauert bis zu einer Minute)' });
  }
  const list = ui.connections.filter((c) => libMatches({ name: c.name, description: c.target }));
  return [
    h('div', { class: 'card list' }, list.length ? list.map((c) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'title', text: c.name }), h('div', { class: 'sub clamp', text: c.statusText })),
      h('span', { class: `pill ${STATUS_PILL[c.status]}`, text: STATUS_LABEL[c.status] })))
      : h('div', { class: 'empty', text: 'Keine Konnektoren eingerichtet.' })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', disabled: ui.connectionsLoading, onClick: async () => { ui.connections = null; renderLibraryBody(); } }, 'Neu prüfen'),
      h('button', { class: 'btn ghost', onClick: () => setView('connections') }, 'Verbindungen einrichten')),
  ];
}

function renderLibraryBody() {
  const box = $('#lib-body');
  if (!box) return;
  const d = lib.data;
  let body;
  if (lib.tab === 'connectors') body = renderConnectors();
  else if (lib.error) body = h('div', { class: 'card empty warn' }, `Die Liste konnte nicht gelesen werden: ${lib.error} `,
    h('button', { class: 'link', onClick: () => loadLibrary(true) }, 'Erneut versuchen'));
  else if (!d) body = h('div', { class: 'card empty', text: 'Lädt …' });
  else if (lib.tab === 'agents') body = renderAgentsWorkshop(d.agents);
  else if (lib.tab === 'skills') body = renderSkillsTable(d.skills);
  else if (lib.tab === 'discover') body = renderDiscover();
  else if (lib.tab === 'commands') body = renderSkillList(d.commands, '/');
  else body = renderPlugins(d.plugins);
  const counts = d ? { agents: d.agents.length, skills: d.skills.length, commands: d.commands.length, plugins: d.plugins.length,
    connectors: ui.connections ? ui.connections.length : null, discover: ws.market ? ws.market.length : null } : {};
  keepFocus(() => fill($('#lib-tabs'), LIB_TABS.map((t) => h('button', { 'aria-pressed': String(lib.tab === t.id), 'data-focus': `lib-tab:${t.id}`,
    onClick: () => { lib.tab = t.id; ws.editor = null; ws.taskFor = null; renderLibraryBody(); } }, t.label, counts[t.id] != null ? h('span', { class: 'count', text: String(counts[t.id]) }) : null))));
  keepFocus(() => fill(box, body));
}

function renderLibrary() {
  const filter = h('input', { type: 'search', class: 'filter', placeholder: 'Filtern …', 'aria-label': 'Liste filtern' });
  filter.value = lib.filter;
  filter.addEventListener('input', () => { lib.filter = filter.value.trim().toLowerCase(); renderLibraryBody(); });
  fill($('#main'),
    h('div', { class: 'section-head wrap' },
      h('h1', { text: 'Skills & Agenten' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: () => { ws.market = null; loadLibrary(true); loadRunning(); } }, 'Aktualisieren')),
    h('p', { class: 'date', text: 'Agenten sind Spezialisten, denen Claude Arbeit übergibt. Skills sind Anleitungen, die Claude bei passenden Aufgaben von selbst benutzt.' }),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Läuft gerade' })),
      h('div', { id: 'lib-running' })),
    h('section', { class: 'section' },
      h('div', { class: 'section-head wrap' }, h('div', { class: 'tabs', id: 'lib-tabs', role: 'group', 'aria-label': 'Bereich wählen' }), h('span', { class: 'spacer' }), filter),
      h('div', { id: 'lib-body', class: 'section' })));
  ui.sig.libRunning = null;
  renderRunning();
  renderLibraryBody();
  loadLibrary(false);
  loadRunning();
  if (!lib.runningTimer) lib.runningTimer = setInterval(loadRunning, 10000);
}

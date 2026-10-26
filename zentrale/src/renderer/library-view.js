// Ansicht „Skills & Agenten“: was gerade arbeitet, alle Agenten (an/aus), Skills, Befehle, Plugins
// und Konnektoren. Nutzt die Helfer aus app.js (h, fill, ui, api …).

const LIB_TABS = [
  { id: 'agents', label: 'Agenten' },
  { id: 'skills', label: 'Skills' },
  { id: 'commands', label: 'Befehle' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'connectors', label: 'Konnektoren' },
];

const lib = { tab: 'agents', data: null, loading: false, filter: '', agentFilter: 'all', running: null, runningTimer: null };

async function loadLibrary(force) {
  if (lib.loading || (lib.data && !force)) return;
  lib.loading = true;
  try { lib.data = await api.library(); } catch { lib.data = { skills: [], commands: [], plugins: [], agents: [] }; }
  lib.loading = false;
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
function useInChat(text) {
  ui.prefill = text;
  if (!ui.state.chat) { alert('Öffne zuerst einen Chat in der Übersicht – dann geht es direkt los.'); return; }
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

function renderAgents(list) {
  const filtered = list.filter(libMatches).filter((a) => lib.agentFilter === 'all' || (lib.agentFilter === 'on') === a.active);
  const on = list.filter((a) => a.active).length;
  const filterBtn = (id, label) => h('button', { role: 'radio', 'aria-checked': String(lib.agentFilter === id),
    onClick: () => { lib.agentFilter = id; renderLibraryBody(); } }, label);
  return [
    h('div', { class: 'section-head' },
      h('span', { class: 'sub', text: `${on} aktiv · ${list.length - on} ausgeschaltet` }), h('span', { class: 'spacer' }),
      h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Agenten filtern' },
        filterBtn('all', 'Alle'), filterBtn('on', 'Aktiv'), filterBtn('off', 'Aus'))),
    h('p', { class: 'date', text: 'Ausgeschaltete Agenten kennt Claude nicht. Der Schalter verschiebt die Datei zwischen ~/.claude/agents und ~/.claude/agents-archiv – neue Gespräche sehen die Änderung sofort.' }),
    h('div', { class: 'card list' }, filtered.length ? filtered.map((a) => itemRow(a,
      a.id ? h('button', { class: 'switch', role: 'switch', 'aria-checked': String(a.active), 'aria-label': `${a.name} ${a.active ? 'ausschalten' : 'einschalten'}`,
        onClick: async () => {
          const res = await api.toggleAgent(a.id, !a.active);
          if (res && !res.ok) alert(res.error);
          await loadLibrary(true);
        } }) : h('span', { class: 'pill green', text: 'über Plugin' })))
      : h('div', { class: 'empty', text: 'Keine passenden Agenten.' })),
  ];
}

function renderSkillList(list, prefix) {
  const filtered = list.filter(libMatches);
  return h('div', { class: 'card list' }, filtered.length ? filtered.map((x) => itemRow(x,
    h('button', { class: 'link', onClick: () => useInChat(`${prefix}${x.name.replace(/^\//, '')} `) }, 'Im Chat nutzen')))
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
    if (!ui.connectionsLoading) loadConnections().then(() => { if (ui.view === 'library') renderLibraryBody(); });
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
  else if (!d) body = h('div', { class: 'card empty', text: 'Lädt …' });
  else if (lib.tab === 'agents') body = renderAgents(d.agents);
  else if (lib.tab === 'skills') body = renderSkillList(d.skills, '/');
  else if (lib.tab === 'commands') body = renderSkillList(d.commands, '/');
  else body = renderPlugins(d.plugins);
  const counts = d ? { agents: d.agents.length, skills: d.skills.length, commands: d.commands.length, plugins: d.plugins.length,
    connectors: ui.connections ? ui.connections.length : null } : {};
  fill($('#lib-tabs'), LIB_TABS.map((t) => h('button', { role: 'tab', 'aria-selected': String(lib.tab === t.id),
    onClick: () => { lib.tab = t.id; renderLibraryBody(); } }, t.label, counts[t.id] != null ? h('span', { class: 'count', text: String(counts[t.id]) }) : null)));
  keepFocus(() => fill(box, body));
}

function renderLibrary() {
  const filter = h('input', { type: 'search', class: 'filter', placeholder: 'Filtern …', 'aria-label': 'Liste filtern' });
  filter.value = lib.filter;
  filter.addEventListener('input', () => { lib.filter = filter.value.trim().toLowerCase(); renderLibraryBody(); });
  fill($('#main'),
    h('div', { class: 'section-head wrap' },
      h('h1', { text: 'Skills & Agenten' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: () => { loadLibrary(true); loadRunning(); } }, 'Aktualisieren')),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Läuft gerade' })),
      h('div', { id: 'lib-running' })),
    h('section', { class: 'section' },
      h('div', { class: 'section-head wrap' }, h('div', { class: 'tabs', id: 'lib-tabs', role: 'tablist' }), h('span', { class: 'spacer' }), filter),
      h('div', { id: 'lib-body', class: 'section' })));
  ui.sig.libRunning = null;
  renderRunning();
  renderLibraryBody();
  loadLibrary(false);
  loadRunning();
  if (!lib.runningTimer) lib.runningTimer = setInterval(loadRunning, 10000);
}

// Auf der Seite „Verbindungen“: Claude selbst verwalten wie in der Claude-App – Version und Update,
// Plugins an/aus, aktualisieren, entfernen, suchen und installieren. Nutzt die Helfer aus app.js (h, fill, ui, api …).
const ca = { plugins: null, loading: false, busy: null, query: '', results: null, searching: false, message: null };

function loadPlugins() {
  if (ca.loading) return;
  ca.loading = true;
  api.pluginsList().then((r) => { ca.plugins = r && r.ok ? r.data : []; ca.message = r && !r.ok ? r.error : null; })
    .catch(() => {}).finally(() => { ca.loading = false; if (ui.view === 'connections') renderConnections(); });
}

async function pluginDo(op, id) {
  ca.busy = `${op}:${id}`;
  renderConnections();
  const r = await api.pluginsAction(op, id);
  ca.busy = null;
  if (r && r.ok) { ca.plugins = r.data; ca.message = `${{ enable: 'Eingeschaltet', disable: 'Ausgeschaltet', update: 'Aktualisiert', uninstall: 'Entfernt', install: 'Installiert' }[op]}: ${id} – gilt ab der nächsten Nachricht.`; }
  else if (r && !r.cancelled) ca.message = r.error || 'Ging nicht.';
  renderConnections();
}

let pluginSearchTimer = null;
function pluginSearch(q) {
  ca.query = q;
  clearTimeout(pluginSearchTimer);
  if (!q.trim()) { ca.results = null; renderConnections(); return; }
  pluginSearchTimer = setTimeout(async () => {
    ca.searching = true;
    renderConnections();
    const r = await api.pluginsSearch(q);
    ca.searching = false;
    ca.results = r && r.ok ? r.data : [];
    if (r && !r.ok) ca.message = r.error;
    renderConnections();
  }, 350);
}

// Karte „Claude“: installierte Version, neueste Version, Update-Knopf.
function claudeVersionCard() {
  const v = ui.state && ui.state.claudeVersions;
  const update = async (btn) => {
    btn.disabled = true;
    btn.textContent = 'Wird aktualisiert …';
    const r = await api.claudeUpdate();
    if (r && !r.ok && !r.cancelled) alert(r.error);
    renderConnections();
  };
  const rows = v ? [
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title', text: 'Claude Code' }),
      h('div', { class: 'sub', text: v.update ? `Installiert ${v.installed} · neu: ${v.latest}` : `Version ${v.installed || '?'} – aktuell${v.offline ? ' (ohne Netz nicht geprüft)' : ''}` })),
    v.update ? h('button', { class: 'btn', 'data-focus': 'claude-update', onClick: (e) => update(e.currentTarget) }, `Auf ${v.latest} aktualisieren`)
      : h('span', { class: 'pill green', text: 'aktuell' }),
    h('button', { class: 'link', onClick: () => api.openExternal(v.changelog) }, 'Was ist neu?')),
    v.app ? h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title', text: 'Claude-App' }),
      h('div', { class: 'sub', text: `Version ${v.app} – aktualisiert sich selbst (Claude → Nach Updates suchen)` }))) : null,
  ] : [h('div', { class: 'empty', text: 'Wird geprüft …' })];
  return h('section', { class: 'section' },
    h('div', { class: 'section-head wrap' }, h('h2', { text: 'Claude' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', 'data-focus': 'claude-check', onClick: async () => { await api.claudeVersions(true); renderConnections(); } }, 'Nach Updates suchen')),
    h('div', { class: 'card list' }, rows));
}

function pluginRow(p) {
  const busy = ca.busy && ca.busy.endsWith(`:${p.id}`);
  return h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 'title', text: p.id.split('@')[0] }),
      h('div', { class: 'sub', text: [p.version ? `Version ${p.version}` : null, p.id.includes('@') ? `aus ${p.id.split('@')[1]}` : null].filter(Boolean).join(' · ') })),
    h('button', { class: 'switch', role: 'switch', 'aria-checked': String(p.enabled), 'aria-label': `${p.id} ${p.enabled ? 'ausschalten' : 'einschalten'}`,
      disabled: !!busy, 'data-focus': `plugin-toggle:${p.id}`, onClick: () => pluginDo(p.enabled ? 'disable' : 'enable', p.id) }),
    h('button', { class: 'link', disabled: !!busy, 'data-focus': `plugin-update:${p.id}`, onClick: () => pluginDo('update', p.id) }, 'Aktualisieren'),
    h('button', { class: 'link subtle', disabled: !!busy, 'data-focus': `plugin-remove:${p.id}`, onClick: () => pluginDo('uninstall', p.id) }, 'Entfernen'));
}

function pluginsSection() {
  if (!ca.plugins && !ca.loading) loadPlugins();
  const installed = new Set((ca.plugins || []).map((p) => p.id));
  const search = h('input', { type: 'search', class: 'konto-input plugin-search', placeholder: 'Plugin suchen, z. B. telegram, figma, notion …',
    'aria-label': 'Plugins im Marktplatz suchen', 'data-focus': 'plugin-search', value: ca.query });
  search.addEventListener('input', () => pluginSearch(search.value));
  return h('section', { class: 'section' },
    h('div', { class: 'section-head wrap' }, h('h2', { text: 'Plugins' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', 'data-focus': 'plugins-refresh', onClick: loadPlugins }, ca.loading ? 'Lädt …' : 'Neu laden')),
    ca.message ? h('div', { class: 'notice', text: ca.message }) : null,
    h('div', { class: 'card list' }, ca.plugins === null ? h('div', { class: 'empty', text: 'Lädt …' })
      : ca.plugins.length ? ca.plugins.map(pluginRow) : h('div', { class: 'empty', text: 'Keine Plugins installiert.' })),
    h('div', { class: 'plugin-find' }, search),
    ca.results ? h('div', { class: 'card list' }, ca.searching ? h('div', { class: 'empty', text: 'Sucht …' })
      : ca.results.length ? ca.results.map((p) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: p.name }),
          h('div', { class: 'sub wrap-sub', text: `${p.id.includes('@') ? `aus ${p.id.split('@')[1]} · ` : ''}${p.description}` })),
        installed.has(p.id) ? h('span', { class: 'pill green', text: 'installiert' })
          : h('button', { class: 'btn ghost', disabled: !!ca.busy, 'data-focus': `plugin-install:${p.id}`, onClick: () => pluginDo('install', p.id) }, 'Installieren')))
        : h('div', { class: 'empty', text: `Nichts gefunden für „${ca.query}“.` })) : null);
}

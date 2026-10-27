// Ansicht „Projekte & Server“: welche lokalen Server laufen (Port, Projekt, Laufzeit), starten und stoppen;
// welche Projekte mit welchen Ordnern verbunden sind, Ordner hinzufügen oder ausblenden.
// Nutzt die Helfer aus app.js (h, fill, ui, api …).

const pv = { servers: null, projects: null, showAll: false, form: null, log: null, timer: null, message: null };
const PV_REFRESH_MS = 5000;

async function loadProjectsView() {
  try {
    const [s, p] = await Promise.all([api.serversList(pv.showAll), api.projectsList()]);
    pv.servers = s; pv.projects = p;
  } catch (e) { pv.message = e.message; }
  if (ui.view === 'projects') renderProjectsBody();
  else { clearInterval(pv.timer); pv.timer = null; }
}

async function stopServerUi(s) {
  if (!confirm(`Server auf Port ${s.port} (${s.project || s.proc}) beenden?`)) return;
  let res = await api.serversStop(s.pid, s.port, false);
  if (res && res.stillRunning && confirm(`${res.error}\n\nDer Prozess wird dann sofort beendet, ungespeicherte Arbeit darin geht verloren.`)) {
    res = await api.serversStop(s.pid, s.port, true);
  }
  pv.message = res.ok ? `Port ${s.port} beendet.${res.restarts ? ` ${res.restarts}` : ''}` : res.error;
  await loadProjectsView();
}

async function openStartForm(dir) {
  pv.form = { dir: dir || '', command: '', port: '', suggestions: dir ? await api.serversSuggest(dir) : [], error: null };
  if (pv.form.suggestions[0]) pv.form.command = pv.form.suggestions[0];
  renderProjectsBody();
  setTimeout(() => { const el = $('#srv-cmd'); if (el) el.focus(); }, 0);
}

function startForm() {
  const f = pv.form;
  const dirSel = h('select', { id: 'srv-dir', 'data-focus': 'srv-dir' }, h('option', { value: '' }, 'Projekt wählen …'),
    (pv.projects || []).map((p) => h('option', { value: p.path }, `${p.name} – ${p.path.replace(/^\/Users\/[^/]+/, '~')}`)));
  dirSel.value = f.dir;
  dirSel.addEventListener('change', async () => { f.dir = dirSel.value; f.suggestions = f.dir ? await api.serversSuggest(f.dir) : []; if (f.suggestions[0]) f.command = f.suggestions[0]; renderProjectsBody(); });
  const cmd = h('input', { id: 'srv-cmd', type: 'text', placeholder: 'z. B. npm run dev', 'data-focus': 'srv-cmd' });
  cmd.value = f.command;
  cmd.addEventListener('input', () => { f.command = cmd.value; });
  const port = h('input', { id: 'srv-port', type: 'number', min: '1024', max: '65535', placeholder: 'optional, z. B. 3000', 'data-focus': 'srv-port' });
  port.value = f.port;
  port.addEventListener('input', () => { f.port = port.value; });
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    const res = await api.serversStart(f.dir, f.command, f.port);
    if (!res.ok) { f.error = res.error; renderProjectsBody(); return; }
    pv.form = null;
    pv.message = `Gestartet (Prozess ${res.data.pid}). Er erscheint gleich in der Liste, sobald er lauscht.`;
    renderProjectsBody();
    setTimeout(loadProjectsView, 2500);
  } },
  h('h2', { class: 'full', text: 'Server starten' }),
  h('div', { class: 'field full' }, h('label', { for: 'srv-dir', text: 'Projekt' }), dirSel),
  h('div', { class: 'field' }, h('label', { for: 'srv-cmd', text: 'Startbefehl' }), cmd),
  h('div', { class: 'field' }, h('label', { for: 'srv-port', text: 'Port (PORT)' }), port),
  f.suggestions.length ? h('div', { class: 'quick-actions full', role: 'group', 'aria-label': 'Vorschläge' },
    f.suggestions.map((s) => h('button', { type: 'button', class: `chip${f.command === s ? ' chip-on' : ''}`, onClick: () => { f.command = s; renderProjectsBody(); } }, s))) : null,
  f.error ? h('div', { class: 'full sub warn', role: 'alert', text: f.error }) : null,
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: 'Läuft im Projektordner wie im Terminal und auch weiter, wenn die Zentrale geschlossen ist. Die Ausgaben siehst du unter „Log“.' }),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: () => { pv.form = null; renderProjectsBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn', disabled: !f.dir || !f.command.trim() }, 'Starten')));
}

function serverRow(s) {
  const badges = [s.started ? ['von der Zentrale', 'blue'] : null, s.launchd ? ['startet automatisch', ''] : null,
    s.protected ? ['geschützt', 'green'] : null, s.system ? ['System', ''] : null].filter(Boolean);
  return h('div', { class: 'row server-row' },
    h('span', { class: 'port', text: String(s.port) }),
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, s.title || s.project || s.proc, ...badges.map(([t, c]) => h('span', { class: `pill ${c}`, text: t }))),
      h('div', { class: 'sub', title: s.cmd, text: [s.project && s.project !== s.title ? s.project : null, s.uptime ? `läuft seit ${s.uptime}` : null,
        s.cwd ? s.cwd.replace(/^\/Users\/[^/]+/, '~') : null].filter(Boolean).join(' · ') })),
    s.system ? null : h('button', { class: 'link', 'aria-label': `Port ${s.port} in der Zentrale öffnen`, onClick: async () => { const r = await api.openInTab(s.url); if (r.ok) setView('web'); else alert(r.error); } }, 'Öffnen'),
    s.started ? h('button', { class: 'link', 'aria-label': `Log von Port ${s.port}`, onClick: async () => {
      const r = await api.serversLog(s.started.id); pv.log = { port: s.port, text: r.ok ? r.data : r.error }; renderProjectsBody();
    } }, 'Log') : null,
    s.protected ? h('span', { class: 'sub', title: s.protected, text: '🔒' })
      : h('button', { class: 'btn ghost danger-text', 'aria-label': `Server auf Port ${s.port} stoppen`, onClick: () => stopServerUi(s) }, 'Stoppen'));
}

function projectRow(p) {
  return h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, p.name, p.added ? h('span', { class: 'pill blue', text: 'hinzugefügt' }) : null,
        ...p.servers.map((s) => h('span', { class: 'pill green', title: s.title || s.url, text: `:${s.port}` }))),
      h('div', { class: 'sub', title: p.path, text: [p.path.replace(/^\/Users\/[^/]+/, '~'), p.sessions ? plural(p.sessions, 'Gespräch', 'Gespräche') : null].filter(Boolean).join(' · ') })),
    h('button', { class: 'link', 'aria-label': `${p.name} im Finder zeigen`, onClick: () => api.fsOpen(p.path) }, 'Im Finder'),
    h('button', { class: 'link', 'aria-label': `Claude in ${p.name} starten`, disabled: !ui.state.claude.found, onClick: () => newSession(p.path) }, 'Claude hier'),
    h('button', { class: 'link', 'aria-label': `Server in ${p.name} starten`, onClick: () => openStartForm(p.path) }, 'Server starten'),
    h('button', { class: 'icon-btn', 'aria-label': `${p.name} aus der Liste entfernen`, title: 'Aus der Liste entfernen (der Ordner bleibt)', onClick: async () => {
      if (!confirm(`„${p.name}“ aus der Projektliste entfernen?\n\nDer Ordner selbst bleibt unverändert.`)) return;
      await api.projectsRemove(p.path); await loadProjectsView();
    } }, '×'));
}

function renderProjectsBody() {
  const box = $('#pv-body');
  if (!box) return;
  const toggle = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(pv.showAll), 'aria-label': 'Auch System-Dienste zeigen', 'data-focus': 'pv-all',
    onClick: () => { pv.showAll = !pv.showAll; pv.servers = null; renderProjectsBody(); loadProjectsView(); } });
  keepFocus(() => fill(box,
    pv.message ? h('div', { class: 'notice', role: 'status', text: pv.message }) : null,
    pv.form ? startForm() : null,
    h('section', { class: 'section' },
      h('div', { class: 'section-head wrap' }, h('h2', { text: 'Laufende Server' }),
        h('span', { class: 'sub', text: pv.servers ? plural(pv.servers.length, 'Server', 'Server') : '' }), h('span', { class: 'spacer' }),
        h('label', { class: 'toggle-line' }, toggle, 'Auch System-Dienste'),
        pv.form ? null : h('button', { class: 'btn', 'data-focus': 'srv-new', onClick: () => openStartForm('') }, '+ Server starten')),
      h('div', { class: 'card list' }, !pv.servers ? h('div', { class: 'empty', text: 'Sucht …' })
        : pv.servers.length ? pv.servers.map(serverRow) : h('div', { class: 'empty', text: 'Gerade läuft kein lokaler Server.' }))),
    pv.log ? h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { text: `Log von Port ${pv.log.port}` }), h('span', { class: 'spacer' }),
        h('button', { class: 'link', onClick: () => { pv.log = null; renderProjectsBody(); } }, 'Schließen')),
      h('pre', { class: 'card log-box', tabindex: '0', text: pv.log.text || '(leer)' })) : null,
    h('section', { class: 'section' },
      h('div', { class: 'section-head wrap' }, h('h2', { text: 'Projekte und ihre Ordner' }), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onClick: async () => {
          const dir = await api.pickFolder();
          if (!dir) return;
          const r = await api.projectsAdd(dir);
          pv.message = r.ok ? `„${dir.split('/').pop()}“ ist jetzt ein Projekt.` : r.error;
          await loadProjectsView();
        } }, '+ Ordner als Projekt hinzufügen')),
      h('div', { class: 'card list' }, !pv.projects ? h('div', { class: 'empty', text: 'Lädt …' })
        : pv.projects.length ? pv.projects.map(projectRow) : h('div', { class: 'empty', text: 'Noch keine Projekte.' })))));
}

function renderProjects() {
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Projekte & Server' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: loadProjectsView }, 'Aktualisieren')),
    h('p', { class: 'date', text: 'Welche lokalen Server (localhost) gerade laufen und zu welchem Projekt sie gehören. Geschützte Dienste wie der Trading-Bot lassen sich hier nicht beenden.' }),
    h('div', { id: 'pv-body', class: 'section' }));
  renderProjectsBody();
  loadProjectsView();
  if (!pv.timer) pv.timer = setInterval(() => { if (!pv.form) loadProjectsView(); }, PV_REFRESH_MS);
}

// Ansicht „Websites“: neue Website mit dem Webdesigner-Agenten anlegen – jedes Mal mit einer anderen
// Designrichtung – und an bestehenden weiterarbeiten. Nutzt die Helfer aus app.js (h, fill, ui, api …).

const sites = { data: null, form: null, message: null, busy: false };

async function loadWebsites() {
  try { sites.data = await api.studioList(); } catch (e) { sites.message = e.message; }
  if (ui.view === 'websites') renderWebsitesBody();
}

async function openSiteForm() {
  sites.form = { name: '', purpose: '', audience: '', goal: '', notes: '', direction: await api.studioSuggest(null), error: null };
  renderWebsitesBody();
  setTimeout(() => { const el = $('#ws-name'); if (el) el.focus(); }, 0);
}

function directionCard(d, onReroll) {
  return h('div', { class: 'card direction' },
    h('div', { class: 'section-head' }, h('span', { class: 'label', text: 'Designrichtung' }), h('span', { class: 'spacer' }),
      onReroll ? h('button', { type: 'button', class: 'link', 'data-focus': 'ws-reroll', onClick: onReroll }, 'Andere Richtung') : null),
    h('div', { class: 'direction-name', text: d.name }),
    h('dl', { class: 'direction-facts' },
      h('dt', { text: 'Schrift' }), h('dd', { text: d.fonts }),
      h('dt', { text: 'Farben' }), h('dd', { text: d.palette }),
      h('dt', { text: 'Aufbau' }), h('dd', { text: d.layout }),
      h('dt', { text: 'Bewegung' }), h('dd', { text: d.motion })));
}

function siteForm() {
  const f = sites.form;
  const field = (key, label, el, full = true) => {
    el.value = f[key]; el.addEventListener('input', () => { f[key] = el.value; });
    return h('div', { class: `field${full ? ' full' : ''}` }, h('label', { for: el.id, text: label }), el);
  };
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    if (sites.busy) return;
    sites.busy = true; renderWebsitesBody();
    const r = await api.studioCreate({ ...f, direction: f.direction.id });
    sites.busy = false;
    if (!r.ok) { f.error = r.error; renderWebsitesBody(); return; }
    sites.form = null;
    resetChat(r.chat.gen, []);
    sendMessage(r.prompt);
  } },
  h('h2', { class: 'full', text: 'Neue Website' }),
  field('name', 'Name', h('input', { id: 'ws-name', type: 'text', maxlength: '60', placeholder: 'z. B. ESA Gebäudereinigung', 'data-focus': 'ws-name' })),
  field('purpose', 'Wofür ist die Seite?', h('textarea', { id: 'ws-purpose', rows: '2', maxlength: '400', placeholder: 'Firma vorstellen, Anfragen bekommen …', 'data-focus': 'ws-purpose' })),
  field('audience', 'Für wen?', h('input', { id: 'ws-audience', type: 'text', maxlength: '300', placeholder: 'Hausverwaltungen in Ulm', 'data-focus': 'ws-audience' }), false),
  field('goal', 'Was soll der Besucher tun?', h('input', { id: 'ws-goal', type: 'text', maxlength: '200', placeholder: 'Angebot anfragen', 'data-focus': 'ws-goal' }), false),
  field('notes', 'Inhalte, Wünsche, Vorbilder (optional)', h('textarea', { id: 'ws-notes', rows: '3', maxlength: '2000', 'data-focus': 'ws-notes' })),
  h('div', { class: 'full' }, directionCard(f.direction, async () => { f.direction = await api.studioSuggest(f.direction.id); renderWebsitesBody(); })),
  f.error ? h('div', { class: 'full sub warn', role: 'alert', text: f.error }) : null,
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: 'Legt ~/Websites/<name> an und öffnet einen Chat mit dem Webdesigner. Veröffentlicht wird nichts ohne dich.' }),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', 'data-focus': 'ws-new', onClick: () => { sites.form = null; renderWebsitesBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn', disabled: sites.busy || !ui.state.claude.found }, sites.busy ? 'Startet …' : 'Website starten')));
}

function siteRow(s) {
  return h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, s.name, s.direction ? h('span', { class: 'pill', text: s.direction.name }) : null),
      h('div', { class: 'sub', text: `${s.dir.replace(/^\/Users\/[^/]+/, '~')} · ${formatWhen(s.createdAt)}` })),
    h('button', { class: 'link', 'aria-label': `Weiterarbeiten: ${s.name}`, disabled: !ui.state.claude.found, onClick: () => newSession(s.dir) }, 'Weiterarbeiten'),
    h('button', { class: 'link', 'aria-label': `Vorschau starten: ${s.name}`, onClick: () => { setView('projects'); openStartForm(s.dir); } }, 'Vorschau starten'),
    h('button', { class: 'link', 'aria-label': `Im Finder: ${s.name}`, onClick: () => api.fsOpen(s.dir) }, 'Im Finder'),
    h('button', { class: 'icon-btn', 'aria-label': `${s.name} aus der Liste entfernen`, title: 'Aus der Liste entfernen (der Ordner bleibt)', onClick: async () => {
      if (confirm(`„${s.name}“ aus der Liste entfernen? Der Ordner bleibt.`)) { sites.data = await api.studioForget(s.id); renderWebsitesBody(); }
    } }, '×'));
}

function renderWebsitesBody() {
  const box = $('#ws-body');
  if (!box) return;
  const d = sites.data;
  keepFocus(() => fill(box,
    noticeEl(sites.message),
    sites.form ? siteForm() : h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-focus': 'ws-new', disabled: !ui.state.claude.found, onClick: openSiteForm }, '+ Neue Website')),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Meine Websites' }),
      d ? h('span', { class: 'sub', text: `${d.used.length} von ${d.directions.length} Designrichtungen schon benutzt` }) : null),
      h('div', { class: 'card list' }, !d ? h('div', { class: 'empty', text: 'Lädt …' })
        : d.sites.length ? [...d.sites].reverse().map(siteRow) : h('div', { class: 'empty', text: 'Noch keine Website aus der Werkstatt.' })))));
}

function renderWebsites() {
  sites.message = null;
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Websites' })),
    h('p', { class: 'date', text: 'Der Webdesigner baut komplette Websites – Konzept, Texte, Design, Technik, Google, Barrierefreiheit – und nimmt für jede Seite eine andere Designrichtung.' }),
    h('div', { id: 'ws-body', class: 'section' }));
  renderWebsitesBody();
  loadWebsites();
}

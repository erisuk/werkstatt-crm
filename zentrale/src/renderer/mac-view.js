// Ansicht „Mein Mac“: Apps starten, Ordner durchblättern, Dateien finden und öffnen.
// Nutzt die Helfer aus app.js (h, fill, ui, api …).

const macv = { tab: 'apps', apps: null, appsError: null, filter: '', places: null, dir: null, listing: null, hidden: false, query: '', results: null, searching: false };

const FILE_ICONS = [
  [/\.(png|jpe?g|gif|heic|webp|svg|tiff?)$/i, '🖼'], [/\.(mp4|mov|m4v|webm|mkv|avi)$/i, '🎞'], [/\.(mp3|wav|m4a|aac|flac)$/i, '🎵'],
  [/\.pdf$/i, '📕'], [/\.(docx?|pages|rtf|txt|md)$/i, '📝'], [/\.(xlsx?|numbers|csv)$/i, '📊'], [/\.(pptx?|key)$/i, '📽'],
  [/\.(zip|dmg|pkg|tar|gz|7z)$/i, '📦'], [/\.(js|ts|py|json|html|css|sh|swift|lua|gd)$/i, '⌨'],
];

function fileIcon(item) {
  if (item.dir) return '📁';
  for (const [re, icon] of FILE_ICONS) if (re.test(item.name)) return icon;
  return '📄';
}

function formatSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
}

async function openItem(p) {
  const res = await api.fsOpen(p);
  if (res && !res.ok) alert(res.error);
}

async function trashItem(item) {
  if (!confirm(`„${item.name}“ in den Papierkorb legen?`)) return;
  const res = await api.fsTrash(item.path);
  if (res && !res.ok) { alert(res.error); return; }
  goTo(macv.dir);
}

// ---------- Apps ----------

async function loadApps() {
  if (macv.apps) return;
  macv.apps = [];
  try { macv.apps = (await api.macApps()) || []; macv.appsError = null; } catch (e) { macv.appsError = e.message || 'Unbekannter Fehler'; }
  if (ui.view === 'mac') renderMacBody();
  loadAppIcons();
}

// Symbole kommen nach und nach, damit die Liste sofort erscheint.
async function loadAppIcons() {
  for (const a of macv.apps) {
    if (a.icon !== undefined) continue;
    try { a.icon = await api.fsIcon(a.path); } catch { a.icon = null; }
    const img = document.querySelector(`.app-tile[data-focus="app:${CSS.escape(a.path)}"] .app-icon`);
    if (img && a.icon) { const el = h('img', { class: 'app-icon', src: a.icon, alt: '', width: '48', height: '48' }); img.replaceWith(el); }
  }
}

function renderApps() {
  if (!macv.apps) { loadApps(); return h('div', { class: 'card empty', text: 'Lädt …' }); }
  if (macv.appsError) {
    return h('div', { class: 'card empty warn' }, `Die Apps konnten nicht gelesen werden: ${macv.appsError} `,
      h('button', { class: 'link', onClick: () => { macv.apps = null; macv.appsError = null; renderMacBody(); } }, 'Erneut versuchen'));
  }
  const list = macv.apps.filter((a) => !macv.filter || a.name.toLowerCase().includes(macv.filter));
  if (!list.length) return h('div', { class: 'card empty', text: macv.apps.length ? 'Keine passende App.' : 'Keine Apps gefunden.' });
  return h('div', { class: 'app-grid' }, list.map((a) => h('button', { class: 'app-tile', title: a.path, 'data-focus': `app:${a.path}`,
    onClick: () => openItem(a.path) },
    a.icon ? h('img', { class: 'app-icon', src: a.icon, alt: '', width: '48', height: '48' })
      : h('span', { class: 'app-fallback app-icon', 'aria-hidden': 'true', text: a.name.charAt(0) }),
    h('span', { class: 'app-name', text: a.name }))));
}

// ---------- Ordner ----------

async function goTo(dir) {
  macv.dir = dir;
  macv.listing = null;
  renderMacBody();
  let res;
  try { res = await api.fsList(dir, macv.hidden); } catch (e) { res = { ok: false, error: e.message }; }
  if (macv.dir !== dir) return; // inzwischen woanders hin
  macv.listing = res;
  if (ui.view === 'mac') renderMacBody();
}

async function loadPlaces() {
  if (macv.places) return;
  try { macv.places = await api.fsFavorites(); } catch { macv.places = { places: [], projects: [] }; }
  if (!macv.dir && macv.places.places[0]) goTo(macv.places.places[0].path); else renderMacBody();
}

function crumbs(p) {
  const parts = p.split('/').filter(Boolean);
  const out = [h('button', { class: 'crumb', onClick: () => goTo('/') }, 'Mac')];
  parts.forEach((part, i) => {
    const target = `/${parts.slice(0, i + 1).join('/')}`;
    out.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }));
    out.push(h('button', { class: 'crumb', onClick: () => goTo(target) }, part));
  });
  return h('nav', { class: 'crumbs', 'aria-label': 'Pfad' }, out);
}

function fileRow(item) {
  const open = () => (item.dir ? goTo(item.path) : openItem(item.path));
  return h('div', { class: 'row file-row' },
    h('button', { class: 'plain file-main', 'data-focus': `file:${item.path}`, title: item.path, onClick: open },
      h('span', { class: 'file-icon', 'aria-hidden': 'true', text: item.app ? '🚀' : fileIcon(item) }),
      h('span', { class: 'title', text: item.name })),
    h('span', { class: 'when', text: item.dir ? '' : formatSize(item.size) }),
    h('span', { class: 'when', text: formatWhen(item.modified) }),
    item.dir ? h('button', { class: 'link', title: 'Claude in diesem Ordner starten', onClick: () => newSession(item.path) }, 'Chat hier') : null,
    h('button', { class: 'link', onClick: () => api.fsReveal(item.path) }, 'Im Finder'),
    h('button', { class: 'icon-btn', 'aria-label': `„${item.name}“ löschen`, title: 'In den Papierkorb', onClick: () => trashItem(item) }, trashIcon()));
}

function renderFolders() {
  if (!macv.places) { loadPlaces(); return h('div', { class: 'card empty', text: 'Lädt …' }); }
  const place = (x) => h('button', { class: `place${macv.dir === x.path ? ' active' : ''}`, title: x.path, onClick: () => goTo(x.path) }, x.name);
  const side = h('div', { class: 'places' },
    h('div', { class: 'label', text: 'Orte' }), macv.places.places.map(place),
    macv.places.projects.length ? h('div', { class: 'label', text: 'Projekte' }) : null, macv.places.projects.map(place));
  const l = macv.listing;
  let list;
  if (!macv.dir) list = h('div', { class: 'card empty', text: 'Wähle links einen Ort.' });
  else if (!l) list = h('div', { class: 'card empty', text: 'Lädt …' });
  else if (!l.ok) list = h('div', { class: 'card empty warn' }, l.error, ' ',
    /erlaubt/.test(l.error) ? h('button', { class: 'link', onClick: () => api.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles') }, 'Einstellungen öffnen') : null);
  else {
    const items = l.items.filter((x) => !macv.filter || x.name.toLowerCase().includes(macv.filter));
    list = h('div', { class: 'card list' }, items.length ? items.map(fileRow) : h('div', { class: 'empty', text: 'Dieser Ordner ist leer.' }),
      l.truncated ? h('div', { class: 'empty', text: 'Es werden nur die ersten 2000 Einträge gezeigt.' }) : null);
  }
  const hiddenToggle = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(macv.hidden), 'aria-label': 'Versteckte Dateien zeigen', 'data-focus': 'show-hidden',
    onClick: () => { macv.hidden = !macv.hidden; goTo(macv.dir); } });
  return h('div', { class: 'folders' }, side,
    h('div', { class: 'folder-main' },
      macv.dir ? h('div', { class: 'section-head wrap' }, crumbs(macv.dir), h('span', { class: 'spacer' }),
        l && l.parent ? h('button', { class: 'btn ghost', onClick: () => goTo(l.parent) }, '↑ Nach oben') : null,
        h('button', { class: 'btn ghost', onClick: () => openItem(macv.dir) }, 'Im Finder öffnen'),
        h('button', { class: 'btn', disabled: !ui.state.claude.found, onClick: () => newSession(macv.dir) }, 'Claude hier starten')) : null,
      macv.dir ? h('label', { class: 'toggle-line' }, hiddenToggle, 'Versteckte Dateien zeigen') : null,
      list));
}

// ---------- Suche ----------

async function runSearch() {
  const q = macv.query.trim();
  if (!q) return;
  macv.searching = true;
  macv.results = null;
  renderMacBody();
  let res;
  try { res = await api.fsSearch(q); } catch (e) { res = { ok: false, error: e.message }; }
  macv.searching = false;
  macv.results = res;
  if (ui.view === 'mac') renderMacBody();
}

function renderSearch() {
  const input = h('input', { type: 'search', class: 'filter wide', placeholder: 'Datei- oder Ordnername, z. B. Rechnung Oktober', 'aria-label': 'Auf dem Mac suchen', 'data-focus': 'mac-search' });
  input.value = macv.query;
  input.addEventListener('input', () => { macv.query = input.value; });
  const r = macv.results;
  let body = null;
  if (macv.searching) body = h('div', { class: 'card empty', text: 'Sucht …' });
  else if (r && !r.ok) body = h('div', { class: 'card empty warn', text: r.error });
  else if (r) {
    body = h('div', { class: 'card list' }, r.data.length ? r.data.map((p) => {
      const name = p.split('/').pop();
      const parent = p.slice(0, p.length - name.length - 1) || '/';
      return h('div', { class: 'row file-row' },
        h('button', { class: 'plain file-main', title: p, onClick: () => openItem(p) },
          h('span', { class: 'file-icon', 'aria-hidden': 'true', text: fileIcon({ name, dir: !/\.[a-z0-9]{1,5}$/i.test(name) }) }),
          h('span', { class: 'grow' }, h('span', { class: 'title', text: name }), h('span', { class: 'sub block', text: parent }))),
        h('button', { class: 'link', onClick: () => { macv.tab = 'folders'; macv.filter = ''; renderMac(); goTo(parent); } }, 'Ordner zeigen'),
        h('button', { class: 'link', onClick: () => api.fsReveal(p) }, 'Im Finder'));
    }) : h('div', { class: 'empty', text: 'Nichts gefunden.' }));
  }
  return [h('form', { class: 'composer search-form', onSubmit: (e) => { e.preventDefault(); runSearch(); } }, input,
    h('button', { type: 'submit', class: 'btn' }, 'Suchen')),
  h('p', { class: 'date', text: 'Sucht mit Spotlight auf dem ganzen Mac (bis zu 60 Treffer).' }), body];
}

// ---------- Gerüst ----------

const MAC_TABS = [{ id: 'apps', label: 'Apps' }, { id: 'folders', label: 'Ordner' }, { id: 'search', label: 'Suchen' }];

function renderMacTabs() {
  keepFocus(() => fill($('#mac-tabs'), MAC_TABS.map((t) => h('button', { 'aria-pressed': String(macv.tab === t.id), 'data-focus': `mac-tab:${t.id}`,
    onClick: () => { macv.tab = t.id; macv.filter = ''; renderMac(); } }, t.label))));
}

function renderMacBody() {
  const box = $('#mac-body');
  if (!box) return;
  const body = macv.tab === 'apps' ? renderApps() : macv.tab === 'folders' ? renderFolders() : renderSearch();
  keepFocus(() => fill(box, body));
}

function renderMac() {
  const filter = macv.tab === 'search' ? null : h('input', { type: 'search', class: 'filter', 'aria-label': 'Filtern',
    placeholder: macv.tab === 'apps' ? 'App suchen …' : 'In diesem Ordner filtern …' });
  if (filter) {
    filter.value = macv.filter;
    filter.addEventListener('input', () => { macv.filter = filter.value.trim().toLowerCase(); renderMacBody(); });
  }
  keepFocus(() => fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Mein Mac' })),
    h('div', { class: 'section-head wrap' }, h('div', { class: 'tabs', id: 'mac-tabs', role: 'group', 'aria-label': 'Bereich wählen' }), h('span', { class: 'spacer' }), filter),
    h('div', { id: 'mac-body', class: 'section' })));
  renderMacTabs();
  renderMacBody();
  if (filter && macv.tab === 'apps' && !(document.activeElement && document.activeElement.dataset.focus)) filter.focus();
}

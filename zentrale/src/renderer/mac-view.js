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
  if (macv.apps || macv.appsLoading) return;
  macv.appsLoading = true;
  try { macv.apps = (await api.macApps()) || []; macv.appsError = null; } catch (e) { macv.apps = []; macv.appsError = e.message || 'Unbekannter Fehler'; }
  macv.appsLoading = false;
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

const MAC_TABS = [{ id: 'apps', label: 'Apps' }, { id: 'folders', label: 'Ordner' }, { id: 'search', label: 'Suchen' },
  { id: 'health', label: 'Gesundheit' }, { id: 'shortcuts', label: 'Kurzbefehle' }, { id: 'watch', label: 'Ordner-Wächter' }];

// ---------- Gesundheit ----------

async function loadHealth(refreshFolders) {
  macv.foldersLoading = true; // sofort, damit ein Doppelklick keine zweite Messung startet
  try { macv.health = await api.macHealth(); } catch (e) { macv.health = { error: e.message }; }
  if (ui.view === 'mac' && macv.tab === 'health') renderMacBody();
  macv.foldersLoading = true;
  try { macv.big = (await api.macBigFolders(refreshFolders === true)).data; } catch { macv.big = []; }
  macv.foldersLoading = false;
  if (ui.view === 'mac' && macv.tab === 'health') renderMacBody();
}

function meter(label, value, max, unit, warnAt) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return h('div', { class: 'card meter' },
    h('div', { class: 'label', text: label }),
    h('div', { class: 'value', text: `${value} ${unit}` }),
    h('div', { class: `bar${pct >= warnAt ? ' warn' : ''}`, role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
      h('span', { style: { width: `${pct}%` } })),
    h('div', { class: 'sub', text: `${pct} % von ${max} ${unit}` }));
}

function renderHealth() {
  const s = macv.health;
  if (!s) { loadHealth(false); return h('div', { class: 'card empty', text: 'Misst …' }); }
  if (s.error) return h('div', { class: 'card empty warn', text: s.error });
  const usedDisk = s.disk.ok ? Math.round((s.disk.total - s.disk.free) * 10) / 10 : 0;
  return [
    s.hints.length ? h('div', { class: 'notice' }, s.hints.map((t) => h('div', { text: t }))) : null,
    h('div', { class: 'stats health-stats' },
      s.disk.ok ? meter('Speicherplatz belegt', usedDisk, s.disk.total, 'GB', 85) : null,
      s.memory.ok ? meter('Arbeitsspeicher belegt', s.memory.used, s.memory.total, 'GB', 85) : null,
      h('div', { class: 'card meter' }, h('div', { class: 'label', text: 'Akku' }),
        h('div', { class: 'value', text: s.battery.present ? `${s.battery.percent} %` : '–' }),
        h('div', { class: 'sub', text: s.battery.present ? (s.battery.onPower ? 'am Strom' : 'im Akkubetrieb') : 'kein Akku' }),
        h('div', { class: 'sub', text: `Auslastung ${s.load} bei ${s.cpus} Kernen` }))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Programme mit dem meisten Arbeitsspeicher' })),
      h('div', { class: 'card list' }, s.processes.map((p) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: p.name })), h('span', { class: 'when', text: `${p.gb} GB` }))))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head wrap' }, h('h2', { text: 'Größte Ordner' }), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', disabled: macv.foldersLoading, onClick: () => { macv.big = null; loadHealth(true); } }, macv.foldersLoading ? 'Misst …' : 'Neu messen')),
      h('p', { class: 'date', text: 'Nur zum Anschauen – die Zentrale löscht hier nichts. Projektordner nie blind löschen; Hinweise stehen bei den bekannten Platzfressern.' }),
      h('div', { class: 'card list' }, !macv.big ? h('div', { class: 'empty', text: 'Misst die Ordner … (kann eine Minute dauern)' })
        : macv.big.map((d) => h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'title', text: d.name }),
            h('div', { class: 'sub', text: d.hint || d.path.replace(/^\/Users\/[^/]+/, '~') })),
          h('span', { class: 'when', text: `${d.gb} GB` }),
          d.name === 'Papierkorb' ? h('button', { class: 'btn ghost danger-text', onClick: async () => {
            const r = await api.macEmptyTrash(); if (r && r.ok) { macv.big = null; loadHealth(true); } else if (r && !r.cancelled) alert(r.error);
          } }, 'Leeren') : h('button', { class: 'link', 'aria-label': `${d.name} im Finder zeigen`, onClick: () => api.fsReveal(d.path) }, 'Im Finder'))))),
  ];
}

// ---------- Kurzbefehle ----------

async function loadShortcuts() {
  try { const r = await api.shortcutsList(); macv.shortcuts = r.ok ? r.data : []; macv.shortcutsError = r.ok ? null : r.error; } catch (e) { macv.shortcuts = []; macv.shortcutsError = e.message; }
  if (ui.view === 'mac' && macv.tab === 'shortcuts') renderMacBody();
}

function renderShortcuts() {
  if (!macv.shortcuts) { loadShortcuts(); return h('div', { class: 'card empty', text: 'Lädt …' }); }
  const list = macv.shortcuts.filter((n) => !macv.filter || n.toLowerCase().includes(macv.filter));
  return [
    h('p', { class: 'date', text: 'Kurzbefehle steuern fast alles am Mac und im Smart Home. Claude kann sie auf deinen Wunsch auch ausführen – mit Freigabe.' }),
    macv.shortcutsError ? h('div', { class: 'card empty warn', text: macv.shortcutsError }) : null,
    h('div', { class: 'card list' }, list.length ? list.map((n) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'title', text: n })),
      h('button', { class: 'btn ghost', 'aria-label': `Kurzbefehl ${n} ausführen`, onClick: async () => {
        macv.message = `„${n}“ läuft …`; renderMacBody();
        const r = await api.shortcutsRun(n);
        macv.message = r.ok ? `„${n}“: ${r.data}` : r.error; renderMacBody();
      } }, 'Ausführen')))
      : h('div', { class: 'empty' }, macv.shortcuts.length ? 'Nichts gefunden.' : 'Du hast noch keine Kurzbefehle. ',
        h('button', { class: 'link', onClick: () => api.fsOpen('/System/Applications/Shortcuts.app') }, 'Kurzbefehle-App öffnen'))),
    noticeEl(macv.message),
  ];
}

function renderMacTabs() {
  keepFocus(() => fill($('#mac-tabs'), MAC_TABS.map((t) => h('button', { 'aria-pressed': String(macv.tab === t.id), 'data-focus': `mac-tab:${t.id}`,
    onClick: () => { macv.tab = t.id; macv.filter = ''; if (t.id === 'health') macv.health = null; renderMac(); } }, t.label))));
}

function renderMacBody() {
  const box = $('#mac-body');
  if (!box) return;
  const body = macv.tab === 'apps' ? renderApps() : macv.tab === 'folders' ? renderFolders() : macv.tab === 'health' ? renderHealth()
    : macv.tab === 'shortcuts' ? renderShortcuts() : macv.tab === 'watch' ? renderWatcher() : renderSearch();
  keepFocus(() => fill(box, body));
}

function renderMac() {
  const filter = ['search', 'health', 'watch'].includes(macv.tab) ? null : h('input', { type: 'search', class: 'filter', 'aria-label': 'Filtern',
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

// ---------- Ordner-Wächter ----------

async function loadWatcher() {
  try { macv.watch = await api.watchState(); } catch { macv.watch = { rules: [], log: [], unsorted: [] }; }
  if (ui.view === 'mac' && macv.tab === 'watch') renderMacBody();
}

function watcherForm() {
  const f = macv.watchForm;
  const folder = h('input', { id: 'w-folder', type: 'text', placeholder: 'leer = Downloads', 'data-focus': 'w-folder' });
  folder.value = f.folder;
  folder.addEventListener('input', () => { f.folder = folder.value; });
  const pattern = h('input', { id: 'w-pattern', type: 'text', placeholder: 'z. B. *Rechnung*.pdf', 'data-focus': 'w-pattern' });
  pattern.value = f.pattern;
  pattern.addEventListener('input', () => { f.pattern = pattern.value; });
  const target = h('input', { id: 'w-target', type: 'text', placeholder: 'Zielordner', 'data-focus': 'w-target' });
  target.value = f.target;
  target.addEventListener('input', () => { f.target = target.value; });
  const pick = (key, el) => h('button', { type: 'button', class: 'btn ghost', onClick: async () => { const d = await api.pickFolder(); if (d) { f[key] = d; el.value = d; } } }, 'Wählen …');
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    const r = await api.watchSave({ id: f.id, folder: f.folder, pattern: f.pattern, target: f.target });
    if (!r.ok) { f.error = r.error; renderMacBody(); return; }
    macv.watchForm = null;
    await loadWatcher();
  } },
  h('h2', { class: 'full', text: f.id ? 'Regel bearbeiten' : 'Neue Regel' }),
  h('div', { class: 'field full' }, h('label', { for: 'w-folder', text: 'Überwachter Ordner' }), h('div', { class: 'folder' }, folder, pick('folder', folder))),
  h('div', { class: 'field full' }, h('label', { for: 'w-pattern', text: 'Dateiname passt zu' }), pattern,
    h('span', { class: 'hint', text: '* steht für beliebigen Text. Beispiele: *Rechnung*.pdf · Screenshot*.png · *.mp4' })),
  h('div', { class: 'field full' }, h('label', { for: 'w-target', text: 'Verschieben nach' }), h('div', { class: 'folder' }, target, pick('target', target))),
  f.error ? h('div', { class: 'full sub warn', role: 'alert', text: f.error }) : null,
  h('div', { class: 'actions full' }, h('span', { class: 'hint', text: 'Gilt für neue Dateien. Es wird nie etwas überschrieben – gleiche Namen bekommen „(2)“.' }),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: () => { macv.watchForm = null; renderMacBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn' }, 'Speichern')));
}

function renderWatcher() {
  const w = macv.watch;
  if (!w) { loadWatcher(); return h('div', { class: 'card empty', text: 'Lädt …' }); }
  const home = (p) => p.replace(/^\/Users\/[^/]+/, '~');
  return [
    h('p', { class: 'date', text: 'Neue Dateien landen automatisch am richtigen Platz – zum Beispiel Rechnungen aus Downloads im ESA-Büro. Jede Verschiebung lässt sich rückgängig machen.' }),
    macv.watchForm ? watcherForm() : h('div', { class: 'actions' }, h('button', { class: 'btn', onClick: () => {
      macv.watchForm = { id: null, folder: '', pattern: '', target: '', error: null };
      renderMacBody();
    } }, '+ Neue Regel')),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Regeln' })),
      h('div', { class: 'card list' }, w.rules.length ? w.rules.map((r) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: r.pattern }), h('div', { class: 'sub', text: `${home(r.folder)} → ${home(r.target)}` })),
        h('button', { class: 'link', onClick: () => { macv.watchForm = { ...r, error: null }; renderMacBody(); } }, 'Bearbeiten'),
        h('button', { class: 'icon-btn', 'aria-label': `Regel ${r.pattern} löschen`, onClick: async () => { if (confirm(`Regel „${r.pattern}“ löschen?`)) { macv.watch = await api.watchRemove(r.id); renderMacBody(); } } }, trashIcon())))
        : h('div', { class: 'empty', text: 'Noch keine Regeln.' }))),
    w.unsorted.length ? h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Neu, ohne passende Regel' })),
      h('div', { class: 'card list' }, w.unsorted.map((u) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: u.name }), h('div', { class: 'sub', text: `${home(u.path)} · ${formatWhen(u.at)}` })),
        h('button', { class: 'link', disabled: !ui.state.claude.found, onClick: () => sendMessage(`Die Datei „${u.path}“ ist neu. Schau sie dir an und schlag mir vor, in welchen Ordner sie gehört (meine Ordnerstruktur kennst du aus dem Gehirn). Verschiebe sie erst nach meinem Ja.`) }, 'Claude fragen'),
        h('button', { class: 'link', onClick: () => api.fsReveal(u.path) }, 'Im Finder'),
        h('button', { class: 'icon-btn', 'aria-label': 'Ausblenden', onClick: async () => { macv.watch = await api.watchDismiss(u.path); renderMacBody(); } }, '×'))))) : null,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Zuletzt einsortiert' })),
      h('div', { class: 'card list' }, w.log.length ? w.log.map((e) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: e.to.split('/').pop() }), h('div', { class: 'sub', text: `${home(e.from)} → ${home(e.to)} · ${formatWhen(e.at)}` })),
        e.undone ? h('span', { class: 'pill', text: 'rückgängig gemacht' }) : h('button', { class: 'link', onClick: async () => { const r = await api.watchUndo(e.id); if (!r.ok) alert(r.error); await loadWatcher(); } }, 'Rückgängig')))
        : h('div', { class: 'empty', text: 'Noch nichts einsortiert.' }))),
  ];
}

window.zentrale.onWatchState((s) => { macv.watch = s; if (typeof ui !== 'undefined' && ui.view === 'mac' && macv.tab === 'watch' && !macv.watchForm) renderMacBody(); });

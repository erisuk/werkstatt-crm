// Ansicht „Web“: eigene Webseiten als Tabs, dauerhaft angemeldet. Die Seite selbst zeichnet der
// Hauptprozess als eingebettete Browser-Ansicht über den Platzhalter #web-host; diese Datei meldet,
// wo der Platz ist. Nutzt die Helfer aus app.js (h, fill, ui, api …).

const webv = { state: null, adding: false, renaming: false, addError: null, observer: null, activity: null, profile: 'standard',
  mode: 'web', lastActive: {}, localServers: null };

// Zwei Bereiche links: „Web“ (Internetseiten) und „Localhost“ (lokale Projekte) – getrennte Tab-Leisten.
const isLocalUrl = (u) => { try { return /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(new URL(u).hostname); } catch { return false; } };
const inWebView = () => ui.view === 'web' || ui.view === 'local';
const modePortals = () => (webv.state ? webv.state.portals.filter((p) => (webv.mode === 'local') === isLocalUrl(p.url)) : []);

const profileLabel = (p) => (p === 'standard' ? 'Standard-Konto' : `Konto ${(/(\d+)$/.exec(p) || [])[1] || p}`);
const ACTIVITY_MS = 20000; // so lange gilt „Claude bedient gerade …“ nach der letzten Aktion

function activePortal() {
  const s = webv.state;
  return s && modePortals().find((p) => p.id === s.active) || null;
}

// Gesamtzahl der Ungelesenen neben „Web“ in der Seitenleiste.
function renderWebBadge() {
  const btn = document.querySelector('.nav-item[data-view="web"]');
  if (!btn || !webv.state) return;
  const total = webv.state.portals.filter((p) => !isLocalUrl(p.url)).reduce((n, p) => n + (p.unread || 0), 0);
  let badge = btn.querySelector('.nav-badge');
  if (!total) { if (badge) badge.remove(); return; }
  if (!badge) { badge = h('span', { class: 'nav-badge' }); btn.append(badge); }
  badge.textContent = total > 99 ? '99+' : String(total);
  badge.setAttribute('aria-label', `${total} ungelesen`);
}

// Wo die eingebettete Seite liegen soll; ohne aktive Seite oder mit offenem Formular ist sie unsichtbar.
function sendWebBounds() {
  const host = $('#web-host');
  const show = inWebView() && !!host && !!activePortal() && !webv.adding;
  if (show) {
    const r = host.getBoundingClientRect();
    api.webBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  api.webVisible(show);
}

async function addPortal(name, url) {
  const res = await api.webAdd(name, url, webv.profile);
  if (!res || !res.ok) { webv.addError = (res && res.error) || 'Das hat nicht geklappt.'; renderWebChrome(); return; }
  webv.adding = false;
  webv.addError = null;
}

// Localhost: laufende Server mit einem Klick als Tab, oder eine eigene Adresse.
function renderLocalAddForm() {
  const s = webv.state;
  const used = new Set(s.portals.map((p) => new URL(p.url).origin));
  if (!webv.localServers) api.serversList(false).then((l) => { webv.localServers = l || []; renderWebChrome(); }).catch(() => { webv.localServers = []; });
  const url = h('input', { id: 'web-url', type: 'text', placeholder: 'z. B. localhost:3000', 'aria-label': 'Lokale Adresse' });
  const free = (webv.localServers || []).filter((x) => !used.has(new URL(x.url).origin));
  return h('form', { class: 'card form web-add', onSubmit: (e) => {
    e.preventDefault();
    let u = url.value.trim();
    if (/^\d+$/.test(u)) u = `localhost:${u}`;
    if (!/^https?:\/\//.test(u)) u = `http://${u}`;
    if (!isLocalUrl(u)) { webv.addError = 'Hier nur lokale Adressen (localhost). Internetseiten gehören in den Bereich „Web“.'; renderWebChrome(); return; }
    addPortal('', u);
  } },
  h('h2', { class: 'full', text: 'Lokalen Server öffnen' }),
  h('div', { class: 'field full', role: 'group', 'aria-label': 'Laufende Server' }, h('span', { class: 'label', 'aria-hidden': 'true', text: 'Laufen gerade' }),
    h('div', { class: 'quick-actions' }, !webv.localServers ? h('span', { class: 'sub', text: 'Sucht …' })
      : free.length ? free.map((x) => h('button', { type: 'button', class: 'chip', onClick: () => addPortal(`${x.project || x.title || 'localhost'} :${x.port}`, x.url) },
        `${x.title || x.project || 'Server'} · :${x.port}`)) : h('span', { class: 'sub', text: 'Kein weiterer Server läuft. Starte einen unter „Projekte & Server“.' }))),
  h('div', { class: 'field full' }, h('label', { for: 'web-url', text: 'Oder Adresse / Port' }), url),
  webv.addError ? h('div', { class: 'full sub warn', role: 'alert', text: webv.addError }) : null,
  h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
    modePortals().length ? h('button', { type: 'button', class: 'btn ghost', onClick: () => { webv.adding = false; webv.addError = null; renderWebChrome(); } }, 'Abbrechen') : null,
    h('button', { type: 'submit', class: 'btn' }, 'Öffnen')));
}

function renderAddForm() {
  if (webv.mode === 'local') return renderLocalAddForm();
  const s = webv.state;
  const used = new Set(s.portals.map((p) => p.url));
  const name = h('input', { id: 'web-name', type: 'text', placeholder: 'z. B. Outlook', 'aria-label': 'Name der Seite' });
  const url = h('input', { id: 'web-url', type: 'text', placeholder: 'Adresse, z. B. outlook.com', 'aria-label': 'Webadresse' });
  // Konto: Standard, ein schon benutztes weiteres Konto oder ein neues (eigene Anmeldung, z. B. zweites Gmail).
  const options = [...s.profiles, s.nextProfile];
  if (!options.includes(webv.profile)) webv.profile = 'standard';
  const profile = h('select', { id: 'web-profile', 'data-focus': 'web-profile' },
    options.map((p) => h('option', { value: p }, p === s.nextProfile ? `+ Neues Konto (${profileLabel(p)})` : profileLabel(p))));
  profile.value = webv.profile;
  profile.addEventListener('change', () => { webv.profile = profile.value; });
  const form = h('form', { class: 'card form web-add', onSubmit: (e) => {
    e.preventDefault();
    if (isLocalUrl(/^https?:/.test(url.value) ? url.value : `http://${url.value}`)) { webv.addError = 'Lokale Adressen gehören in den Bereich „Localhost“.'; renderWebChrome(); return; }
    addPortal(name.value, url.value);
  } },
    h('h2', { class: 'full', text: 'Seite hinzufügen' }),
    h('div', { class: 'field full' }, h('label', { for: 'web-profile', text: 'Konto' }), profile,
      h('span', { class: 'hint', text: 'Jedes Konto hat eine eigene Anmeldung. Für ein zweites Gmail oder Outlook: „Neues Konto“ wählen und dann Gmail anklicken.' })),
    [...new Set(s.presets.map((p) => p.group))].map((group) => {
      // Im Standard-Konto nur, was es noch nicht gibt; in einem weiteren Konto alles (z. B. zweites Gmail).
      const items = s.presets.filter((p) => p.group === group && (webv.profile !== 'standard' || !used.has(p.url)));
      return items.length ? h('div', { class: 'field full', role: 'group', 'aria-label': group }, h('span', { class: 'label', 'aria-hidden': 'true', text: group }),
        h('div', { class: 'quick-actions' }, items.map((p) =>
          h('button', { type: 'button', class: 'chip', 'data-focus': `preset:${p.name}`, onClick: () => addPortal(p.name, p.url) }, p.name)))) : null;
    }),
    h('div', { class: 'field' }, h('label', { for: 'web-name', text: 'Name' }), name),
    h('div', { class: 'field' }, h('label', { for: 'web-url', text: 'Adresse' }), url),
    webv.addError ? h('div', { class: 'full sub warn', role: 'alert', text: webv.addError }) : null,
    h('div', { class: 'actions full' },
      h('span', { class: 'hint', text: 'Du meldest dich einmal auf der Seite an – die Zentrale merkt sich die Anmeldung. Passwörter gibst nur du ein.' }),
      h('span', { class: 'spacer' }),
      modePortals().length ? h('button', { type: 'button', class: 'btn ghost', onClick: () => { webv.adding = false; webv.addError = null; renderWebChrome(); } }, 'Abbrechen') : null,
      h('button', { type: 'submit', class: 'btn' }, 'Hinzufügen')));
  return form;
}

function webTab(p, active) {
  return h('div', { class: `web-tab${active ? ' active' : ''}` },
    h('button', { class: 'web-tab-main', 'aria-pressed': String(active), 'data-focus': `web-tab:${p.id}`, title: p.title || p.url,
      onClick: () => { webv.adding = false; api.webShow(p.id); } },
    p.loading ? h('span', { class: 'dot amber pulse', 'aria-hidden': 'true' }) : null,
    h('span', { class: 'web-tab-name', text: p.name }),
    p.profile && p.profile !== 'standard' ? h('span', { class: 'profile-dot', title: profileLabel(p.profile), 'aria-label': profileLabel(p.profile), text: (/(\d+)$/.exec(p.profile) || [])[1] || '•' }) : null,
    p.unread ? h('span', { class: 'count', 'aria-label': `${p.unread} ungelesen`, text: p.unread > 99 ? '99+' : String(p.unread) }) : null),
    h('button', { class: 'web-tab-close', 'aria-label': `${p.name} schließen`, title: 'Tab entfernen', 'data-focus': `web-close:${p.id}`,
      onClick: async () => {
        if (!confirm(`„${p.name}“ aus der Zentrale entfernen?\n\nDeine Anmeldung bei der Seite bleibt gespeichert.`)) return;
        await api.webClose(p.id);
      } }, '×'));
}

function renderToolbar(p) {
  if (!p) return null;
  const nav = (action, label, icon, disabled) => h('button', { class: 'icon-btn plain-icon', 'aria-label': label, title: label,
    'data-focus': `web-nav:${action}`, disabled, onClick: () => api.webNav(p.id, action) }, icon);
  let middle;
  if (webv.renaming) {
    const input = h('input', { class: 'filter wide', 'aria-label': 'Neuer Name', 'data-focus': 'web-rename' });
    input.value = p.name;
    const done = async (save) => { webv.renaming = false; if (save) await api.webRename(p.id, input.value); renderWebChrome(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => { if (webv.renaming) done(true); });
    setTimeout(() => input.select(), 0);
    middle = input;
  } else {
    middle = h('div', { class: 'web-url', title: p.current },
      p.error ? h('span', { class: 'warn', text: p.error }) : h('span', { text: p.current.replace(/^https:\/\//, '') }));
  }
  return h('div', { class: 'web-bar' },
    nav('back', 'Zurück', '←', !p.canGoBack), nav('forward', 'Vor', '→', !p.canGoForward),
    nav('reload', 'Neu laden', '↻', false), nav('home', 'Startseite der Seite', '⌂', false),
    middle,
    isVideoPage(p.current) ? h('button', { class: 'btn video-btn', 'data-focus': 'web-video', disabled: !ui.state.claude.found,
      title: 'Claude schaut sich das Video mit Bild und Ton an (Skill „watch“) und fragt dich danach, wo die Analyse hin soll',
      onClick: async () => { const r = await api.webAnalyzeVideo(p.id); if (!r.ok) { alert(r.error); return; } sendMessage(r.data); } }, '▶ Video analysieren') : null,
    h('button', { class: 'link', 'data-focus': 'web-rename-btn', onClick: () => { webv.renaming = true; renderWebChrome(); } }, 'Umbenennen'),
    h('button', { class: 'link', 'data-focus': 'web-browser', onClick: () => api.webOpenBrowser(p.id) }, 'Im Browser öffnen'));
}

// „Claude bedient gerade …“ – oben im Web-Bereich und als Hinweis in der rechten Seitenleiste.
function activityBanner() {
  const a = webv.activity;
  if (!a || Date.now() - a.at > ACTIVITY_MS) return null;
  return h('div', { class: 'web-activity', role: 'status' },
    h('span', { class: 'dot blue pulse', 'aria-hidden': 'true' }),
    h('span', { class: 'grow', text: `Claude bedient gerade „${a.name || 'Web-Tab'}“ (${a.action})` }),
    !inWebView() ? h('button', { class: 'link', onClick: () => setView(viewForTab(a.id)) }, 'Ansehen') : null,
    h('button', { class: 'btn ghost', onClick: () => api.stopChat() }, 'Stopp'));
}

function renderActivityHint() {
  const box = $('#web-activity-hint');
  if (!box) return;
  fill(box, inWebView() ? null : activityBanner());
}

// In welchem Bereich ein Tab liegt (Web oder Localhost).
function viewForTab(id) {
  const p = webv.state && webv.state.portals.find((x) => x.id === id);
  return p && isLocalUrl(p.url) ? 'local' : 'web';
}

// Alles außer der eingebetteten Seite: Tabs, Leiste, Formular.
function renderWebChrome() {
  const box = $('#web-chrome');
  if (!box) return;
  const s = webv.state;
  if (!s) { fill(box, h('div', { class: 'card empty', text: 'Lädt …' })); return; }
  const list = modePortals();
  // Der angezeigte Tab gehört zu diesem Bereich – sonst den zuletzt hier benutzten (oder den ersten) zeigen.
  if (list.length && !list.some((x) => x.id === s.active)) {
    const back = list.find((x) => x.id === webv.lastActive[webv.mode]) || list[0];
    api.webShow(back.id);
  }
  if (list.some((x) => x.id === s.active)) webv.lastActive[webv.mode] = s.active;
  const p = activePortal();
  const showForm = webv.adding || !list.length;
  keepFocus(() => fill(box,
    activityBanner(),
    list.length ? h('div', { class: 'web-tabs', role: 'group', 'aria-label': webv.mode === 'local' ? 'Lokale Server' : 'Webseiten' },
      list.map((x) => webTab(x, x.id === s.active && !showForm)),
      h('button', { class: 'web-tab-add', 'aria-label': 'Seite hinzufügen', title: 'Seite hinzufügen', 'data-focus': 'web-add',
        onClick: () => { webv.adding = true; renderWebChrome(); } }, '+')) : null,
    showForm ? renderAddForm() : renderToolbar(p)));
  $('#web-host').hidden = showForm || !p;
  sendWebBounds();
}

async function renderWeb(mode = 'web') {
  webv.mode = mode;
  webv.adding = false;
  webv.addError = null;
  webv.localServers = null;
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: mode === 'local' ? 'Localhost' : 'Web' }), h('span', { class: 'spacer' }),
      mode === 'local' ? h('button', { class: 'btn ghost', onClick: () => setView('projects') }, 'Projekte & Server')
        : h('button', { class: 'btn ghost', title: 'Löscht die gespeicherten Anmeldungen aller Tabs', onClick: () => api.webClearLogins() }, 'Überall abmelden')),
    h('div', { id: 'web-chrome', class: 'web-chrome' }),
    h('div', { id: 'web-host', class: 'web-host', 'aria-label': 'Webseite' }));
  $('#main').classList.add('web-mode');
  if (!webv.observer) {
    webv.observer = new ResizeObserver(() => { if (inWebView()) sendWebBounds(); });
    window.addEventListener('resize', () => { if (inWebView()) sendWebBounds(); });
  }
  webv.observer.disconnect();
  webv.observer.observe($('#web-host'));
  webv.observer.observe($('#main'));
  renderWebChrome();
  if (!webv.state) { webv.state = await api.webState(); renderWebChrome(); renderWebBadge(); }
}

// Beim Verlassen der Ansicht die Seite ausblenden (sie läuft im Hintergrund weiter).
function leaveWeb() {
  $('#main').classList.remove('web-mode');
  webv.renaming = false;
  api.webVisible(false);
}

// Läuft vor app.js: deshalb hier window.zentrale statt api.
window.zentrale.onWebState((s) => {
  webv.state = s;
  renderWebBadge();
  if (inWebView() && !webv.renaming) renderWebChrome();
});
window.zentrale.webState().then((s) => { webv.state = s; renderWebBadge(); }).catch(() => {});
window.zentrale.onWebActivity((a) => {
  // Beim ersten Schritt einer neuen Browser-Arbeit in den Web-Bereich wechseln, damit du zusiehst.
  const fresh = !webv.activity || a.at - webv.activity.at > ACTIVITY_MS;
  webv.activity = a;
  const target = viewForTab(a.id);
  if (fresh && ui.view !== target) setView(target);
  const redraw = () => { if (inWebView()) renderWebChrome(); else renderActivityHint(); };
  redraw();
  setTimeout(redraw, ACTIVITY_MS + 200);
});

// Grobe Erkennung für den Knopf; die genaue Prüfung macht die Zentrale beim Klick.
const VIDEO_PAGE = [/youtube\.com\/(watch|shorts\/|live\/)/, /youtu\.be\/[\w-]{6,}/, /instagram\.com\/(reels?|p|tv)\/[\w-]+/, /tiktok\.com\/@[^/]+\/video\/\d+/,
  /reddit\.com\/r\/[^/]+\/comments\//, /(x|twitter)\.com\/[^/]+\/status\/\d+/, /vimeo\.com\/\d+/, /loom\.com\/share\//, /facebook\.com\/(reel\/|watch|[^/]+\/videos\/)/];
function isVideoPage(url) {
  return typeof url === 'string' && url.startsWith('https://') && VIDEO_PAGE.some((re) => re.test(url));
}

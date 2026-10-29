// Oberfläche der Zentrale. Alle Texte werden mit textContent gesetzt, nie als HTML.
// Bereiche werden nur neu gezeichnet, wenn sich ihre Daten wirklich geändert haben,
// damit Fokus, Markierungen und Eingaben erhalten bleiben.
const api = window.zentrale;
if (api.platform === 'darwin') document.documentElement.classList.add('mac');

const ui = {
  state: null,
  view: 'overview',
  selected: null,
  messages: [],
  shown: 0,
  chatGen: null,
  search: '',
  editingTask: null,
  editingDirty: false,
  openResults: new Set(),
  sig: {},
  forceScroll: false,
  today: null,
  todayAt: 0,
  todayLoading: false,
  connections: null,
  connectionsLoading: false,
  macTest: null,
  notice: null,
  groupMode: 'topic',
  showArchived: false,
  prefill: null,
};

const $ = (sel) => document.querySelector(sel);

// Wie replaceChildren, lässt aber null und false weg (sonst stünde "null" im Fenster).
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    // Styles über das style-Objekt setzen: die CSP blockiert style-Attribute.
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// true, wenn sich der Wert seit dem letzten Aufruf mit diesem Schlüssel geändert hat.
function changed(key, value) {
  const s = JSON.stringify(value);
  if (ui.sig[key] === s) return false;
  ui.sig[key] = s;
  return true;
}

// Zeichnet einen Bereich neu und gibt den Fokus an dasselbe Element zurück.
function keepFocus(draw) {
  const active = document.activeElement;
  const key = active && active.dataset ? active.dataset.focus : null;
  draw();
  if (key) {
    const again = document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
    if (again) again.focus();
  }
}

const AVATAR_COLORS = ['#0064d2', '#dc2626', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#4d7c0f', '#1d4ed8'];
function colorFor(name) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

function pad(n) { return String(n).padStart(2, '0'); }
function clock(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

function formatWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const diff = now - d;
  if (diff >= 0 && diff < 60000) return 'gerade eben';
  if (diff >= 0 && diff < 3600000) return `vor ${Math.floor(diff / 60000)} Min.`;
  const today = startOfDay(now);
  if (ms >= today) return `Heute ${clock(d)}`;
  if (ms >= today - 86400000) return `Gestern ${clock(d)}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear();
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${year}`;
}

function greeting() {
  const hr = new Date().getHours();
  if (hr < 11) return 'Guten Morgen';
  if (hr < 18) return 'Guten Tag';
  return 'Guten Abend';
}

function todayLabel() {
  return new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Screenreader-Ansagen über einen festen Bereich (frisch eingefügte Live-Regionen liest nicht jeder vor).
let lastAnnounced = '';
function announce(text) {
  const box = document.getElementById('sr-live');
  if (!box || !text || text === lastAnnounced) return;
  lastAnnounced = text;
  box.textContent = '';
  setTimeout(() => { box.textContent = text; }, 50);
}
// Hinweiszeile oben in einer Ansicht; die Ansage macht announce().
function noticeEl(text) {
  if (!text) return null;
  announce(text);
  return h('div', { class: 'notice', text });
}
function projectKey(p) { return p.path || p.name; }
function projects() { return (ui.state && ui.state.projects) || []; }
function settings() { return (ui.state && ui.state.settings) || { theme: 'system', connections: { mac: false, chrome: false } }; }
function isMac() { return ui.state ? ui.state.platform === 'darwin' : api.platform === 'darwin'; }
function chatApprovals() {
  const s = ui.state;
  if (!s || !s.chat) return [];
  return (s.approvals || []).filter((a) => a.source.startsWith('Chat'));
}

function chatStatus() {
  const s = ui.state;
  if (!s) return { dot: '', text: 'Lädt …' };
  if (s.claude.checking) return { dot: 'amber pulse', text: 'Claude wird gestartet …' };
  if (!s.claude.found) return { dot: 'red', text: 'Claude Code nicht gefunden' };
  if ((s.approvals || []).length) return { dot: 'blue pulse', text: 'Claude wartet auf dich', pill: 'blue', short: 'wartet auf dich' };
  if (!s.chat) return { dot: '', text: 'Kein Chat offen' };
  if (s.chat.status === 'busy') return { dot: 'amber pulse', text: 'Claude arbeitet …', pill: 'amber', short: 'arbeitet' };
  if (s.chat.status === 'error') return { dot: 'red', text: 'Claude hatte einen Fehler', pill: 'red', short: 'Fehler' };
  return { dot: 'green', text: 'Claude bereit', pill: 'green', short: 'bereit' };
}

function chatBusy() {
  return !!(ui.state && ui.state.chat && ui.state.chat.status === 'busy');
}

// ---------- Titelleiste, Menü, Darstellung ----------

function renderStatus() {
  const st = chatStatus();
  const dry = ui.state && ui.state.dryRun;
  if (!changed('status', [st, dry])) return;
  fill($('#claude-status'), h('span', { class: `dot ${st.dot}` }), st.text);
  // Probelauf sichtbar machen: solange er läuft, passiert in Web-Tabs und n8n nichts Echtes.
  const box = $('#dryrun-status');
  box.hidden = !dry;
  if (dry) fill(box, h('span', { class: 'status-pill dryrun-pill', role: 'status', text: `Probelauf bis ${new Date(dry).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` }),
    h('button', { class: 'link', onClick: () => api.simDryRunStop() }, 'Beenden'));
}

function renderNav() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const on = b.dataset.view === ui.view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

// "Auto" folgt der Einstellung des Mac; Hell und Dunkel gelten fest.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function renderTheme() {
  const theme = settings().theme;
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelectorAll('.theme-switch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
  });
}
darkQuery.addEventListener('change', renderTheme);

// Beim Wechsel landet der Fokus auf der Überschrift, damit Tastatur und Vorlesefunktion mitkommen.
// Der Chat setzt seinen Fokus selbst ins Eingabefeld.
function setView(view, { focusHeading = true } = {}) {
  if ((ui.view === 'web' || ui.view === 'local') && view !== ui.view) leaveWeb();
  // Privaten Bereich beim Verlassen sofort sperren.
  if (ui.view === 'finance' && view !== 'finance' && typeof fin !== 'undefined' && fin.open) { api.finLock(); finClear(); }
  ui.view = view;
  api.kontrolleView(view).catch(() => {}); // Data Layer: welche Seiten benutzt werden (nur der Name)
  // Im privaten Bereich gibt es kein Eingabefeld zu Claude – so landet nichts versehentlich dort.
  $('#quick-section').hidden = view === 'finance';
  ui.sig.main = null;
  renderNav();
  renderMain();
  if (ui.state) renderApprovals();
  const heading = focusHeading && view !== 'chat' && $('#main h1');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

// Mülleimer-Symbol für Löschknöpfe (fester Inhalt, keine fremden Daten).
function trashIcon() {
  const span = h('span', { 'aria-hidden': 'true' });
  span.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  return span;
}

// ---------- Freigaben ----------

function approvalCard(a, compact) {
  const busy = { done: false };
  const decide = async (decision) => {
    if (busy.done) return;
    busy.done = true;
    try { await api.respondApproval(a.id, decision); } catch (e) { busy.done = false; alert(`Die Antwort kam nicht an: ${e.message || e}`); }
  };
  return h('div', { class: `card approval${compact ? ' compact' : ''}` },
    h('div', { class: 'approval-head' },
      h('span', { class: 'approval-icon', 'aria-hidden': 'true', text: '!' }),
      h('div', { class: 'grow' },
        h('div', { class: 'name', text: a.title }),
        h('div', { class: 'where', text: a.source }))),
    a.detail ? h('pre', { class: 'approval-detail', tabindex: '0', text: a.detail }) : null,
    h('div', { class: 'approval-actions' },
      h('button', { class: 'btn ghost', 'data-focus': `deny:${a.id}`, onClick: () => decide('deny') }, 'Ablehnen'),
      a.canAlways ? h('button', { class: 'btn ghost always', 'data-focus': `always:${a.id}`,
        title: 'Erlaubt genau diese Aktion mit genau diesen Angaben, solange dieser Chat offen ist', onClick: () => decide('always') }, 'Immer erlauben') : null,
      a.truncated ? null : h('button', { class: 'btn', 'data-focus': `allow:${a.id}`, onClick: () => decide('allow') }, 'Erlauben')));
}

// Rechts stehen alle offenen Freigaben – außer denen, die im offenen Chat ohnehin zu sehen sind.
function renderApprovals() {
  const all = (ui.state && ui.state.approvals) || [];
  const inChat = ui.view === 'chat' && $('#chat-approvals');
  const list = inChat ? all.filter((a) => !a.source.startsWith('Chat')) : all;
  if (!changed('approvals', [list.map((a) => a.id), all.map((a) => a.id)])) return;
  $('#approvals-section').hidden = !list.length;
  keepFocus(() => fill($('#approvals'), list.map((a) => approvalCard(a, true))));
  renderChatApprovals();
}

function renderChatApprovals() {
  const box = $('#chat-approvals');
  if (!box) return;
  keepFocus(() => fill(box, chatApprovals().map((a) => approvalCard(a, false))));
  const msgs = $('#messages');
  if (msgs && chatApprovals().length) msgs.scrollTop = msgs.scrollHeight;
}

// ---------- Übersicht ----------

function matches(text) {
  return !ui.search || String(text || '').toLowerCase().includes(ui.search);
}

const QUICK_ACTIONS = [
  { label: 'Mein Tag', prompt: 'Gib mir einen kurzen Überblick über meinen Tag: heutige Termine, offene Erinnerungen und wichtige ungelesene Mails (Gmail, Outlook, Apple Mail – was davon verbunden ist). Kurz und in Stichpunkten.' },
  { label: 'Mails zusammenfassen', prompt: 'Fasse meine ungelesenen Mails von heute zusammen (Gmail, Outlook und Apple Mail – was davon verbunden ist). Sag mir, was wichtig ist und worauf ich antworten sollte. Sende nichts ohne meine Freigabe.' },
  { label: 'Diese Woche', prompt: 'Was steht diese Woche an? Schau in meinen Kalender und meine Erinnerungen und gib mir eine kurze Übersicht nach Tagen.' },
];

function needTodayRefresh() {
  return isMac() && settings().connections.mac && !ui.todayLoading && Date.now() - ui.todayAt > 5 * 60000;
}

// Beim ersten Laden und auf Knopfdruck dürfen Kalender und Erinnerungen gestartet werden;
// die automatische Aktualisierung fragt nur Apps ab, die schon laufen, und behält sonst den alten Stand.
// Jede Karte lädt für sich und erscheint, sobald sie fertig ist. Läuft schon eine Abfrage, startet keine zweite –
// zwei gleichzeitige Kalenderabfragen würden sich nur gegenseitig ausbremsen.
const TODAY_PARTS = ['events', 'reminders', 'mail', 'outlook'];
async function loadToday(force) {
  if (ui.todayLoading || (!force && !needTodayRefresh())) return;
  const launch = force || !ui.today;
  ui.todayLoading = true;
  ui.todayAt = Date.now();
  if (!ui.today) ui.today = {};
  if (ui.view === 'overview') renderOverview();
  await Promise.all(TODAY_PARTS.map(async (part) => {
    let fresh = null;
    try { fresh = await api.macToday(launch, part); } catch {}
    // Geschlossene App: den letzten Stand behalten statt „geschlossen“ anzuzeigen.
    if (fresh && fresh.notRunning && ui.today[part]) fresh = ui.today[part];
    ui.today = { ...ui.today, [part]: fresh || { ok: false, error: 'Konnte nicht geladen werden.' } };
    if (ui.view === 'overview') renderOverview();
  }));
  ui.todayLoading = false;
  if (ui.view === 'overview') renderOverview();
}

function timeOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : clock(d);
}

function todayCard(title, res, renderItems, emptyText) {
  let body;
  if (!res) body = h('div', { class: 'sub', text: 'Lädt …' });
  else if (!res.ok) body = h('div', { class: 'sub warn', text: res.error });
  else if (res.notRunning) body = h('div', { class: 'sub', text: 'Die App ist geschlossen. „Aktualisieren“ öffnet sie.' });
  else {
    const items = renderItems(res.data);
    body = items.length ? h('ul', { class: 'today-list' }, items) : h('div', { class: 'sub', text: emptyText });
  }
  return h('div', { class: 'card today-card' }, h('div', { class: 'label', text: title }), body);
}

// Lage auf einen Blick: Ungelesenes in den Web-Tabs, Fehler, Server, einsortierte Dateien.
const COCKPIT_REFRESH_MS = 60000;
async function loadCockpit() {
  if (ui.cockpitLoading || (ui.cockpitAt && Date.now() - ui.cockpitAt < COCKPIT_REFRESH_MS)) return;
  ui.cockpitLoading = true;
  ui.cockpitAt = Date.now();
  try { ui.cockpit = await api.cockpit(); } catch {}
  ui.cockpitLoading = false;
  if (ui.view === 'overview') renderOverview();
}

function renderCockpit() {
  const c = ui.cockpit;
  if (!c) return null;
  const m = settings().morning || { enabled: false, time: '08:00' };
  const time = h('input', { type: 'time', value: m.time, 'aria-label': 'Uhrzeit der Morgen-Mitteilung', 'data-focus': 'morning-time',
    onChange: (e) => api.updateSettings({ morning: { time: e.target.value } }) });
  const tile = (label, value, sub, onClick, tone) => h('button', { class: `card cockpit-tile${tone ? ` ${tone}` : ''}`, 'data-focus': `cockpit:${label}`, onClick },
    h('span', { class: 'label', text: label }), h('span', { class: 'value', text: String(value) }), h('span', { class: 'sub', text: sub }));
  const unread = c.web.reduce((n, p) => n + p.unread, 0);
  return h('section', { class: 'section' },
    h('div', { class: 'section-head wrap' }, h('h2', { text: 'Lage' }), h('span', { class: 'spacer' }),
      h('label', { class: 'toggle-line' },
        h('button', { class: 'switch', role: 'switch', 'aria-checked': String(m.enabled), 'aria-label': 'Morgen-Mitteilung: jeden Morgen eine Zusammenfassung', 'data-focus': 'morning-on',
          onClick: () => api.updateSettings({ morning: { enabled: !m.enabled } }) }), 'Morgen-Mitteilung um'), time),
    h('div', { class: 'cockpit' },
      tile('Ungelesen', unread, unread ? c.web.slice(0, 3).map((p) => `${p.name} ${p.unread}`).join(' · ') : 'in deinen Web-Tabs', () => setView('web')),
      tile('Fehler', c.alerts.length, c.alerts.length ? c.alerts[0].body : 'seit gestern keine', () => setView(c.alerts[0] ? c.alerts[0].view : 'projects'), c.alerts.length ? 'warn' : ''),
      tile('Server', c.servers, c.servers === 1 ? 'läuft gerade' : 'laufen gerade', () => setView('projects')),
      tile('Einsortiert', c.sorted, c.unsorted ? `${c.unsorted} neu ohne Platz` : 'Dateien seit gestern', () => { if (typeof macv !== 'undefined') macv.tab = 'watch'; setView('mac'); }, c.unsorted ? 'warn' : '')));
}

function renderToday() {
  if (!isMac() || !settings().connections.mac) return null;
  const t = ui.today || {};
  const mailItems = () => {
    const out = [];
    for (const [name, r] of [['Apple Mail', t.mail], ['Outlook', t.outlook]]) {
      if (!r) continue;
      if (!r.ok) { if (name === 'Outlook' && !/läuft gerade nicht/.test(r.error)) out.push(h('li', { class: 'warn', text: `${name}: nicht lesbar` })); continue; }
      if (!r.data.running) continue;
      out.push(h('li', {}, h('strong', { text: `${name}: ` }), plural(r.data.unread, 'ungelesene Mail', 'ungelesene Mails')));
      for (const m of r.data.messages.slice(0, 2)) out.push(h('li', { class: 'sub', text: `${m.subject || '(ohne Betreff)'} – ${m.from || ''}` }));
    }
    return out;
  };
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Heute' }), h('span', { class: 'spacer' }),
      h('button', { class: 'link', 'data-focus': 'today-refresh', onClick: () => loadToday(true) }, ui.todayLoading ? 'Lädt …' : 'Aktualisieren')),
    h('div', { class: 'today' },
      todayCard('Termine', t.events, (list) => list.slice(0, 5).map((e) =>
        h('li', {}, h('span', { class: 'time-tag', text: e.allDay ? 'ganztägig' : timeOf(e.start) }), e.title)), 'Heute keine Termine.'),
      todayCard('Erinnerungen', t.reminders, (list) => list.slice(0, 5).map((r) =>
        h('li', { text: r.title })), 'Nichts offen.'),
      todayCard('Mails', (t.mail || t.outlook) ? { ok: true, data: null } : null, mailItems,
        'Öffne Mail oder Outlook, um ungelesene Mails zu sehen. Gmail fragst du über „Mails zusammenfassen“ ab.')));
}

// Gruppen für die Übersicht: nach Thema (Standard) oder nach Projektordner.
// In der Claude-App archivierte Gespräche sind standardmäßig ausgeblendet.
function visibleSessions(list) {
  return ui.showArchived ? list : list.filter((x) => !x.archived);
}

function overviewGroups() {
  if (ui.groupMode === 'folder') {
    return projects().map((p) => {
      const sessions = visibleSessions(p.sessions);
      return { key: `f:${projectKey(p)}`, name: p.name, emoji: null, path: p.path, sessions, updatedAt: sessions.length ? sessions[0].updatedAt : 0 };
    }).filter((g) => g.sessions.length);
  }
  const all = visibleSessions(projects().flatMap((p) => p.sessions));
  return ((ui.state && ui.state.topics) || []).map((t) => {
    const sessions = all.filter((x) => x.topic === t.id).sort((a, b) => b.updatedAt - a.updatedAt);
    return { key: `t:${t.id}`, topicId: t.id, name: t.label, emoji: t.emoji, path: null, sessions, updatedAt: sessions.length ? sessions[0].updatedAt : 0 };
  }).filter((g) => g.sessions.length);
}

function folderName(cwd) {
  return cwd ? cwd.split('/').filter(Boolean).pop() || cwd : '';
}

// Gibt zurück, ob alle Gespräche gelöscht wurden.
async function trashSessions(list, label) {
  if (!list.length) return false;
  const what = list.length === 1 ? `„${list[0].title}“` : `${list.length} Gespräche${label ? ` aus „${label}“` : ''}`;
  if (!confirm(`${what} in den Papierkorb legen?\n\nSolange du den Papierkorb nicht leerst, kannst du sie dort zurückholen.`)) return false;
  const res = await api.trashSessions(list.map((x) => x.id));
  if (res && res.skipped && res.skipped.length) {
    alert(`${plural(res.trashed, 'Gespräch', 'Gespräche')} gelöscht. Nicht gelöscht:\n\n${res.skipped.map((x) => `• ${x.title}: ${x.reason}`).join('\n')}`);
  }
  return !!res && res.trashed === list.length;
}

// Löscht nur, was gerade zu sehen ist (die Suche filtert mit). Den Ordner gibt es nur dazu,
// wenn wirklich alle Gespräche des Projekts weg sind.
async function trashGroup(g) {
  const shown = g.sessions.filter((x) => matches(x.title) || matches(g.name));
  const all = shown.length === g.sessions.length;
  const done = await trashSessions(shown, g.name);
  if (!done || !all || !g.path) return;
  if (!confirm(`Soll auch der Projektordner selbst in den Papierkorb?\n\n${g.path}\n\nAbbrechen = Ordner bleibt, nur die Gespräche sind weg.`)) return;
  const res = await api.trashProjectFolder(g.path);
  if (res && !res.ok) alert(res.error);
}

function topicSelect(x) {
  const sel = h('select', { class: 'topic-select', 'aria-label': `Thema von ${x.title}`, 'data-focus': `topic:${x.id}`,
    title: x.topicManual ? 'Von dir gewählt' : 'Automatisch einsortiert' });
  sel.append(h('option', { value: '' }, 'Automatisch'));
  for (const t of (ui.state.topics || [])) {
    const o = h('option', { value: t.id }, `${t.emoji} ${t.label}`);
    if (x.topicManual && x.topic === t.id) o.selected = true;
    sel.append(o);
  }
  if (!x.topicManual) sel.value = '';
  sel.addEventListener('change', async () => {
    await api.setTopic([x.id], sel.value || null);
    sel.blur(); // erst danach darf die Übersicht neu zeichnen (siehe renderOverview)
    renderOverview(true);
  });
  return sel;
}

function sessionRow(x, s, showFolder) {
  const isChat = !!s.chat && s.chat.sessionId === x.id;
  const busy = isChat && s.chat.status === 'busy';
  const sub = isChat ? (busy ? 'Claude arbeitet gerade daran' : 'Im Chat geöffnet')
    : [x.archived ? 'archiviert' : null, showFolder ? folderName(x.cwd) : null].filter(Boolean).join(' · ') || null;
  return h('div', { class: 'row session-row' },
    h('span', { class: `dot ${busy ? 'amber pulse' : isChat ? 'green' : ''}` }),
    h('div', { class: 'grow' },
      h('div', { class: 'title', text: x.title, title: x.title }),
      sub ? h('div', { class: 'sub', text: sub }) : null),
    h('span', { class: 'when', text: formatWhen(x.updatedAt) }),
    topicSelect(x),
    h('button', { class: 'link', 'data-focus': `open:${x.id}`, onClick: () => openSession(x) }, 'Öffnen'),
    h('button', { class: 'icon-btn', 'aria-label': `„${x.title}“ löschen`, title: 'In den Papierkorb', 'data-focus': `trash:${x.id}`,
      disabled: busy, onClick: () => trashSessions([x]) }, trashIcon()));
}

function renderOverview(force) {
  const s = ui.state;
  const list = projects();
  const groups = overviewGroups();
  const visible = groups.filter((g) => matches(g.name) || g.sessions.some((x) => matches(x.title)));
  // Ist die gewählte Gruppe durch die Suche ausgeblendet, nehmen wir die erste sichtbare (nicht die Automatik).
  const sel = visible.find((g) => g.key === ui.selected) || visible.find((g) => g.topicId !== 'auto') || visible[0] || null;
  const chat = s.chat ? { id: s.chat.sessionId, status: s.chat.status } : null;
  const enabledTasks = s.tasks.filter((t) => t.enabled).length;
  const minute = Math.floor(Date.now() / 60000);
  // Ist gerade ein Auswahlfeld offen, nicht neu zeichnen – sonst klappt es unter der Maus zu.
  const picking = document.activeElement && document.activeElement.tagName === 'SELECT' && $('#main').contains(document.activeElement);
  if (picking && !force) return;
  if (!changed('main', ['overview', list, chat, enabledTasks, s.claude, ui.search, sel && sel.key, ui.groupMode, ui.showArchived, minute, settings().connections, settings().morning, ui.today, ui.todayLoading, ui.cockpit]) && !force) return;
  loadToday(false);
  loadCockpit();

  const totalSessions = list.reduce((n, p) => n + p.sessions.length, 0);
  const archivedCount = list.reduce((n, p) => n + p.sessions.filter((x) => x.archived).length, 0);
  const groupCards = visible.map((g) => {
    const isSel = !!sel && g.key === sel.key;
    return h('button', {
      class: `project${isSel ? ' selected' : ''}`,
      'aria-pressed': String(isSel),
      'data-focus': `group:${g.key}`,
      title: g.path || g.name,
      onClick: () => { ui.selected = g.key; renderOverview(); },
    },
    g.emoji ? h('span', { class: 'avatar emoji', 'aria-hidden': 'true', text: g.emoji })
      : h('span', { class: 'avatar', style: { background: colorFor(g.name) }, text: g.name.charAt(0).toUpperCase() }),
    h('span', { class: 'text' },
      h('span', { class: 'name', text: g.name }),
      h('span', { class: 'meta', text: `${plural(g.sessions.length, 'Gespräch', 'Gespräche')} · ${formatWhen(g.updatedAt)}` })));
  });
  groupCards.push(h('button', { class: 'project add', 'data-focus': 'add-project', onClick: addProject }, '+ Neues Projekt'));

  let sessionsBox;
  if (!list.length) {
    sessionsBox = h('div', { class: 'card empty', text: 'Noch keine Gespräche. Lege mit „+ Neues Projekt“ los.' });
  } else if (!sel) {
    sessionsBox = h('div', { class: 'card empty', text: `Nichts gefunden für „${ui.search}“.` });
  } else {
    const rows = sel.sessions.filter((x) => matches(x.title) || matches(sel.name)).map((x) => sessionRow(x, s, ui.groupMode !== 'folder'));
    sessionsBox = h('div', { class: 'card list' }, rows.length ? rows : h('div', { class: 'empty', text: 'Keine passenden Gespräche.' }));
  }
  const modeBtn = (mode, label) => h('button', { 'aria-pressed': String(ui.groupMode === mode), 'data-focus': `mode:${mode}`,
    onClick: () => { ui.groupMode = mode; ui.selected = null; renderOverview(); } }, label);
  const newCwd = sel && sel.path ? sel.path : null;

  keepFocus(() => fill($('#main'),
    h('div', {}, h('div', { class: 'date', text: todayLabel() }), h('h1', { text: greeting() })),
    s.claude.found || s.claude.checking ? null : h('div', { class: 'notice' },
      'Claude Code wurde auf diesem Mac nicht gefunden. Installiere es im Terminal mit ',
      h('code', { text: 'npm install -g @anthropic-ai/claude-code' }),
      ', melde dich mit ', h('code', { text: 'claude' }), ' an und starte die Zentrale neu.'),
    h('div', { class: 'quick-actions' }, QUICK_ACTIONS.map((q) =>
      h('button', { class: 'chip', 'data-focus': `quick:${q.label}`, disabled: !s.claude.found, onClick: () => sendMessage(q.prompt) }, q.label))),
    renderCockpit(),
    renderToday(),
    h('div', { class: 'stats' },
      stat('Projekte', list.length), stat('Gespräche', totalSessions), stat('Tägliche Aufgaben', enabledTasks)),
    h('section', { class: 'section' },
      h('div', { class: 'section-head wrap' }, h('h2', { text: ui.groupMode === 'folder' ? 'Meine Projektordner' : 'Meine Themen' }),
        h('span', { class: 'spacer' }),
        archivedCount ? h('label', { class: 'toggle-line' },
          h('button', { class: 'switch', role: 'switch', 'aria-checked': String(ui.showArchived), 'aria-label': `Archivierte zeigen (${archivedCount})`,
            'data-focus': 'show-archived', onClick: () => { ui.showArchived = !ui.showArchived; renderOverview(); } }),
          `Archivierte zeigen (${archivedCount})`) : null,
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Gespräche sortieren' },
          modeBtn('topic', 'Nach Thema'), modeBtn('folder', 'Nach Ordner'))),
      h('div', { class: 'projects' }, groupCards)),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('h2', { text: 'Gespräche' }),
        h('span', { class: 'sub', text: sel ? `${sel.emoji ? `${sel.emoji} ` : ''}${sel.name}` : '' }),
        h('span', { class: 'spacer' }),
        sel && sel.sessions.length ? h('button', { class: 'btn ghost danger-text', 'data-focus': 'trash-group', onClick: () => trashGroup(sel) },
          ui.groupMode === 'folder' ? 'Projekt löschen …' : 'Alle löschen …') : null,
        sel ? h('button', { class: 'btn', 'data-focus': 'new-session', disabled: !s.claude.found,
          onClick: () => (newCwd ? newSession(newCwd) : addProject()) }, newCwd ? '+ Neues Gespräch' : '+ Neues Gespräch …') : null),
      sel && sel.topicId === 'auto' ? h('p', { class: 'date', text: 'Hier landen Läufe von geplanten Aufgaben und Testaufträge – Titel, die fünfmal oder öfter vorkommen, oder wörtliche Befehle wie „Antworte nur mit …“. Liegt etwas falsch, wähle rechts das richtige Thema.' }) : null,
      sessionsBox)));
}

function stat(label, value) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: String(value) }));
}

// Fragt nach, bevor ein arbeitender Claude unterbrochen wird.
function okToLeaveBusyChat() {
  if (!chatBusy()) return true;
  return confirm(`Claude arbeitet noch an „${ui.state.chat.title || 'Neues Gespräch'}“. Trotzdem wechseln? Die laufende Arbeit wird dann abgebrochen.`);
}

async function addProject() {
  const dir = await api.pickFolder();
  if (dir) newSession(dir);
}

async function newSession(cwd) {
  if (!okToLeaveBusyChat()) return;
  const res = await api.newSession({ cwd });
  if (!res || res.error || !res.chat) { if (res && res.error) alert(res.error); return; }
  resetChat(res.chat.gen, []);
  setView('chat');
}

async function openSession(session) {
  const cur = ui.state.chat;
  // Dasselbe Gespräch ist schon offen: nur hinwechseln, nichts neu starten.
  if (cur && cur.sessionId === session.id && ui.chatGen === cur.gen) { setView('chat'); return; }
  if (!okToLeaveBusyChat()) return;
  const res = await api.openSession({ sessionId: session.id });
  if (!res || res.error || !res.chat) { alert((res && res.error) || 'Claude Code wurde nicht gefunden.'); return; }
  resetChat(res.chat.gen, res.history.map((m) => ({ kind: m.role, text: m.text, tool: m.tool, detail: m.detail })));
  setView('chat');
}

// ---------- Chat ----------

function resetChat(gen, messages) {
  ui.chatGen = gen;
  ui.messages = messages;
  ui.shown = 0;
  ui.forceScroll = true;
}

function renderChat() {
  const s = ui.state;
  const main = $('#main');
  if (!s.chat) {
    const recent = projects().find((p) => p.path);
    fill(main, h('div', { class: 'card empty chat-empty' },
      h('p', { text: s.claude.found ? 'Gerade ist kein Chat offen.' : 'Claude Code wurde nicht gefunden.' }),
      s.claude.found ? h('div', { class: 'actions center' },
        recent ? h('button', { class: 'btn', onClick: () => newSession(recent.path) }, `Neuer Chat in ${recent.name}`) : null,
        h('button', { class: 'btn ghost', onClick: addProject }, 'Ordner wählen …')) : null));
    return;
  }
  if (ui.chatGen !== s.chat.gen) resetChat(s.chat.gen, []);

  const input = h('textarea', { id: 'chat-input', rows: '1', placeholder: `Nachricht an Claude in ${s.chat.name} … (Dateien einfach hineinziehen)` });
  const sendBtn = h('button', { type: 'submit', class: 'send', 'aria-label': 'Senden' });
  const shotBtn = isMac() ? h('button', { type: 'button', class: 'icon-btn shot-btn', 'aria-label': 'Bildschirm zeigen', title: 'Bildschirm zeigen (Cmd+Shift+Leertaste): Bereich wählen, Leertaste für ein Fenster, Esc bricht ab',
    onClick: async () => { const r = await api.screenCapture(); if (r && r.ok) attachScreenshot(r.path); else if (r && r.error) alert(r.error); } }) : null;
  const fileBtn = h('button', { type: 'button', class: 'icon-btn shot-btn', 'aria-label': 'Datei anhängen', title: 'Datei anhängen (oder einfach ins Feld ziehen)',
    onClick: async () => { const files = await api.pickFiles(); if (files && files.length) insertPaths(input, files); } });
  fileBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>';
  if (shotBtn) shotBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>';
  sendBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const form = h('form', { class: 'composer chat-composer', onSubmit: (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.style.height = 'auto';
    sendMessage(t);
  } }, h('label', { for: 'chat-input', class: 'sr-only', text: 'Nachricht an Claude' }), input,
    h('div', { class: 'composer-tools' }, fileBtn, shotBtn, h('span', { class: 'spacer' }), sendBtn));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
  attachDrop(form, input);

  const typing = h('div', { class: 'typing', id: 'typing', role: 'status', hidden: true },
    h('span', { class: 'spark', 'aria-hidden': 'true', text: '✻' }), h('span', { class: 'typing-text', text: 'Claude arbeitet …' }));
  fill(main, h('div', { class: 'chat' },
    h('div', { class: 'chat-head', id: 'chat-head' }),
    h('div', { class: 'messages', id: 'messages' }, typing),
    h('div', { class: 'chat-bottom' },
      h('div', { id: 'chat-approvals', class: 'chat-approvals' }),
      form)));
  ui.sig.chatHead = null;
  ui.shown = 0;
  updateChatHead();
  renderMessages();
  renderChatApprovals();
  // Aus „Skills & Agenten“: der Skill-Name steht schon im Eingabefeld.
  if (ui.prefill) { input.value = ui.prefill; ui.prefill = null; }
  input.focus();
}

// Dateien in den Chat ziehen: der Pfad landet im Eingabefeld, Claude liest die Datei dann selbst
// (Bilder, PDFs, Videos, Tabellen …). Hochgeladen oder kopiert wird nichts.
const MAX_DROP_FILES = 10;
function insertPaths(input, paths) {
  const lines = paths.map((p) => `Datei: ${p}`).join('\n');
  input.value = input.value.trim() ? `${input.value.trimEnd()}\n${lines}\n` : `${lines}\n`;
  input.dispatchEvent(new Event('input'));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  announce(paths.length === 1 ? 'Eine Datei angehängt.' : `${paths.length} Dateien angehängt.`);
}

function attachDrop(zone, input) {
  const insert = (paths) => insertPaths(input, paths);
  let depth = 0;
  zone.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth += 1; zone.classList.add('drop-on'); } });
  zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('drop-on'); });
  zone.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  zone.addEventListener('drop', (e) => {
    depth = 0; zone.classList.remove('drop-on');
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const paths = files.slice(0, MAX_DROP_FILES).map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) insert(paths);
    if (files.length > MAX_DROP_FILES) alert(`Es werden nur die ersten ${MAX_DROP_FILES} Dateien übernommen.`);
  });
}

// Bildschirm-Helfer: Bild an den Chat hängen. Abgeschickt wird erst, wenn du auf Senden drückst –
// so siehst du vorher, dass ein Bildschirmfoto mitgeht.
async function attachScreenshot(file) {
  const text = `Datei: ${file}\nDas ist ein Bildschirmfoto von mir. `;
  if (!ui.state.chat) {
    const recent = projects().find((p) => p.path);
    if (!recent) { alert('Öffne zuerst einen Chat – das Bildschirmfoto liegt hier:\n' + file); return; }
    ui.prefill = text;
    await newSession(recent.path);
    if (!ui.state.chat) ui.prefill = null; // Start ging nicht – nicht später woanders einfügen
    return;
  }
  const input = $('#chat-input');
  if (ui.view === 'chat' && input) {
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n${text}` : text;
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  } else { ui.prefill = text; setView('chat'); }
}
api.onScreenShot((file) => { if (typeof file === 'string') attachScreenshot(file); });

// Eine danebengezogene Datei soll die Zentrale nicht verlassen (sonst öffnet das Fenster die Datei).
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

function updateChatHead() {
  const head = $('#chat-head');
  if (!head || !ui.state.chat) return;
  const c = ui.state.chat;
  const st = chatStatus();
  if (!changed('chatHead', [c, st])) return;
  keepFocus(() => fill(head,
    h('span', { class: 'avatar', style: { background: colorFor(c.name) }, text: c.name.charAt(0).toUpperCase() }),
    h('div', { class: 'grow' },
      h('div', { class: 'date', text: c.careful ? `${c.name} · kein Projektordner: Claude fragt vor jeder Dateiänderung` : c.name, title: c.cwd }),
      h('h1', { text: c.title || 'Neues Gespräch' })),
    h('span', { class: `pill ${st.pill || ''}`, text: st.short || st.text }),
    c.status === 'busy' ? h('button', { class: 'btn ghost', 'data-focus': 'stop', onClick: () => api.stopChat() }, 'Stoppen') : null,
    h('button', { class: 'btn ghost', 'data-focus': 'chat-new', onClick: () => newSession(c.cwd) }, 'Neues Gespräch')));
}

// Wie in der Claude-App: deine Nachricht als Blase rechts (angehängte Dateien als Kärtchen),
// Claudes Antwort ohne Blase über die volle Breite mit Markdown.
const FILE_LINE = /^Datei: (\/.+)$/;
function userMessageEl(text) {
  const lines = String(text).split('\n');
  const files = lines.map((l) => FILE_LINE.exec(l)).filter(Boolean).map((m) => m[1]);
  const rest = lines.filter((l) => !FILE_LINE.test(l)).join('\n').trim();
  return h('div', { class: 'msg user' },
    files.length ? h('div', { class: 'msg-files' }, files.map((f) => h('span', { class: 'file-chip', title: f }, h('span', { class: 'file-ext', text: (f.split('.').pop() || '').slice(0, 4).toUpperCase() }), h('span', { class: 'file-name', text: f.split('/').pop() })))) : null,
    rest ? h('div', { class: 'msg-text', text: rest }) : null);
}

function messageEl(m) {
  if (m.kind === 'error') {
    return h('div', { class: 'msg error' }, m.text,
      m.details ? h('details', {}, h('summary', { text: 'Details' }), h('pre', { text: m.details })) : null);
  }
  if (m.kind === 'user') return userMessageEl(m.text);
  if (m.kind === 'assistant') return h('div', { class: 'msg assistant' }, mdRender(m.text));
  return h('div', { class: `msg ${m.kind}`, text: m.text });
}

// Arbeitsschritte wie in der Claude-App: eine Zeile pro Werkzeug mit Symbol, Tätigkeit und Ziel.
const STEP_ICONS = {
  terminal: '<path d="M4 6l5 5-5 5M11 17h8"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  agent: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
};
function stepInfo(tool) {
  const t = String(tool || '');
  if (t === 'Bash') return ['terminal', 'Befehl ausgeführt'];
  if (t === 'Read') return ['file', 'Gelesen'];
  if (t === 'Write') return ['edit', 'Erstellt'];
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(t)) return ['edit', 'Bearbeitet'];
  if (t === 'Grep' || t === 'Glob') return ['search', 'Gesucht'];
  if (t === 'WebFetch') return ['globe', 'Webseite gelesen'];
  if (t === 'WebSearch') return ['globe', 'Im Netz gesucht'];
  if (t === 'Task' || t === 'Agent') return ['agent', 'Agent beauftragt'];
  if (t === 'TodoWrite') return ['list', 'Aufgabenliste aktualisiert'];
  if (t === 'Skill') return ['tool', 'Skill benutzt'];
  if (t.startsWith('mcp__')) return ['tool', t.split('__').slice(1).join(' · ').replace(/_/g, ' ')];
  return ['tool', t || 'Werkzeug benutzt'];
}
function stepIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = STEP_ICONS[kind] || STEP_ICONS.tool; // feste Symbole aus dieser Datei, nie aus einer Antwort
  return svg;
}
function stepRow(m) {
  // Ältere Einträge haben nur Text („Edit · src/app.js“).
  const tool = m.tool || String(m.text || '').split(' · ')[0];
  const detail = m.tool ? m.detail : String(m.text || '').split(' · ').slice(1).join(' · ');
  const [icon, label] = stepInfo(tool);
  return h('li', { class: 'step' }, stepIcon(icon), h('span', { class: 'step-label', text: label }), detail ? h('span', { class: 'step-detail', text: detail, title: detail }) : null);
}

// Aufeinanderfolgende Arbeitsschritte landen in einer aufklappbaren Gruppe; zu sieht man den neuesten.
function addStep(box, typing, m) {
  let group = typing.previousElementSibling;
  if (!group || !group.classList.contains('steps')) {
    group = h('details', { class: 'steps' }, h('summary', {}, h('span', { class: 'steps-count' }), h('span', { class: 'steps-last' })), h('ol', { class: 'steps-list' }));
    group.dataset.count = '0';
    box.insertBefore(group, typing);
  }
  const count = Number(group.dataset.count) + 1;
  group.dataset.count = String(count);
  const row = stepRow(m);
  group.querySelector('.steps-list').append(row);
  group.querySelector('.steps-count').textContent = count === 1 ? '1 Schritt' : `${count} Schritte`;
  fill(group.querySelector('.steps-last'), [...row.cloneNode(true).childNodes]);
}

// Hängt nur neue Nachrichten an; bestehende bleiben unberührt (Markierung bleibt erhalten).
function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  const typing = $('#typing');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (ui.shown > ui.messages.length) ui.shown = 0;
  if (ui.shown === 0) {
    for (const el of [...box.children]) if (el !== typing) el.remove();
    if (!ui.messages.length) box.insertBefore(h('div', { class: 'chat-hint', id: 'chat-hint' }, h('span', { class: 'spark big', 'aria-hidden': 'true', text: '✻' }), h('p', { text: 'Was soll Claude für dich tun?' })), typing);
  }
  if (ui.messages.length > ui.shown) {
    const hint = $('#chat-hint');
    if (hint) hint.remove();
    for (const m of ui.messages.slice(ui.shown)) {
      if (m.kind === 'tool') addStep(box, typing, m);
      else box.insertBefore(messageEl(m), typing);
    }
    ui.shown = ui.messages.length;
  }
  typing.hidden = !chatBusy() || chatApprovals().length > 0;
  if (nearBottom || ui.forceScroll) box.scrollTop = box.scrollHeight;
  ui.forceScroll = false;
}

// stay: true = in der aktuellen Ansicht bleiben (z. B. der n8n-Assistent zeigt den Chat selbst an).
async function sendMessage(text, { stay = false } = {}) {
  if (ui.state && ui.state.chat && ui.chatGen !== ui.state.chat.gen) resetChat(ui.state.chat.gen, []);
  ui.messages.push({ kind: 'user', text });
  ui.forceScroll = true;
  if (stay) notifyChatMirror();
  else if (ui.view !== 'chat') setView('chat'); else renderMessages();
  const res = await api.send(text);
  if (!res.ok) {
    ui.messages.push({ kind: 'error', text: res.error || 'Die Nachricht konnte nicht gesendet werden.' });
    if (ui.view === 'chat') renderMessages(); else notifyChatMirror();
  }
}

// Ansichten mit eigenem Chat-Fenster (n8n-Assistent) zeichnen bei neuen Nachrichten nach.
function notifyChatMirror() {
  if (ui.view === 'automations' && typeof renderAssistant === 'function') renderAssistant();
}

api.onChatEvent((ev) => {
  if (ev.gen !== ui.chatGen) return; // Ereignis eines früheren Chats
  if (ev.kind === 'text') ui.messages.push({ kind: 'assistant', text: ev.text });
  else if (ev.kind === 'tool') ui.messages.push({ kind: 'tool', text: ev.text, tool: ev.tool, detail: ev.detail });
  else if (ev.kind === 'error') ui.messages.push({ kind: 'error', text: ev.text, details: ev.details });
  else return;
  if (ui.view === 'chat') renderMessages();
  else notifyChatMirror();
});

// ---------- Seitenleiste rechts ----------

function renderAside() {
  const s = ui.state;
  const minute = Math.floor(Date.now() / 60000);
  renderApprovals();
  if (!changed('aside', [s.chat, s.tasks, s.claude.found, minute, (s.approvals || []).length])) return;
  const agents = [];
  if (s.chat) {
    const st = chatStatus();
    agents.push(h('div', { class: 'card agent' },
      h('div', { class: 'top' },
        h('div', { class: 'claude-avatar', text: 'C' }),
        h('div', { class: 'grow' },
          h('div', { class: 'name', text: s.chat.title || 'Neues Gespräch' }),
          h('div', { class: 'where', text: s.chat.name })),
        h('span', { class: `pill ${st.pill || ''}`, text: st.short || st.text })),
      h('button', { class: 'link start', 'data-focus': 'aside-chat', onClick: () => setView('chat') }, 'Zum Chat')));
  }
  for (const t of s.tasks.filter((x) => x.running)) {
    agents.push(h('div', { class: 'card agent' },
      h('div', { class: 'top' },
        h('div', { class: 'claude-avatar', text: 'C' }),
        h('div', { class: 'grow' },
          h('div', { class: 'name', text: t.name }),
          h('div', { class: 'where', text: 'Tägliche Aufgabe' })),
        h('span', { class: 'pill amber', text: 'arbeitet' }))));
  }
  const tasks = s.tasks.map((t) => h('div', { class: 'card task' },
    h('div', { class: 'time', text: t.time }),
    h('button', { class: 'grow plain', 'data-focus': `aside-task:${t.id}`, title: 'Bearbeiten', onClick: () => editTask(t) },
      h('div', { class: 'name', text: t.name }),
      h('div', { class: 'info', text: taskInfo(t) })),
    taskSwitch(t, 'aside')));
  keepFocus(() => {
    fill($('#agents'), agents.length ? agents : h('div', { class: 'card empty', text: 'Gerade arbeitet kein Agent.' }));
    fill($('#aside-tasks'), tasks.length ? tasks : h('div', { class: 'card empty', text: 'Noch keine Aufgaben.' }));
  });
  $('#quick-input').placeholder = s.chat ? `Frag Claude zu ${s.chat.name} …` : 'Frag Claude …';
}

// ---------- Ablauf ----------

function renderMain() {
  if (!ui.state) return;
  if (ui.view === 'overview') renderOverview(true);
  else if (ui.view === 'chat') renderChat();
  else if (ui.view === 'connections') { renderConnections(); if (!ui.connections) loadConnections(); }
  else if (ui.view === 'library') renderLibrary();
  else if (ui.view === 'mac') renderMac();
  else if (ui.view === 'web') renderWeb('web');
  else if (ui.view === 'local') renderWeb('local');
  else if (ui.view === 'automations') renderAutomations();
  else if (ui.view === 'brain') renderBrain();
  else if (ui.view === 'projects') renderProjects();
  else if (ui.view === 'planner') renderPlanner();
  else if (ui.view === 'websites') renderWebsites();
  else if (ui.view === 'finance') renderFinance();
  else if (ui.view === 'kontrolle') renderKontrolle();
  else if (ui.view === 'lernen') renderLernen();
  else if (ui.view === 'bitvideos') renderBitVideos();
  else renderTasks();
}

function applyState(next) {
  const firstLoad = !ui.state;
  // Ohne „projects“ hat sich die Gesprächsliste nicht geändert (spart bei jeder Meldung ~200 KB).
  const s = 'projects' in next ? next : { ...next, projects: ui.state ? ui.state.projects : [] };
  ui.state = s;
  // Chat geschlossen (z. B. sein Gespräch gelöscht): alter Verlauf weg, damit die nächste Nachricht stehen bleibt.
  if (!s.chat && ui.chatGen !== null) resetChat(null, []);
  // Neuer Chat (auch der beim Start): ab jetzt gehören seine Ereignisse zu uns,
  // egal welche Ansicht gerade offen ist.
  const newChat = !!s.chat && ui.chatGen !== s.chat.gen;
  if (newChat) {
    // Hat erst unsere Nachricht den Chat gestartet, bleibt sie stehen.
    const onlyOurs = ui.chatGen === null && ui.messages.length && ui.messages.every((m) => m.kind === 'user' || m.kind === 'error');
    if (onlyOurs) { ui.chatGen = s.chat.gen; ui.shown = 0; } else resetChat(s.chat.gen, []);
  }
  renderStatus();
  renderTheme();
  renderAside();
  if (firstLoad) { renderMain(); return; }
  if (ui.view === 'overview') renderOverview();
  else if (ui.view === 'chat') {
    const head = $('#chat-head');
    // Neu aufbauen nur, wenn ein Chat dazukam, wegfiel oder wechselte; sonst bleibt die Eingabe erhalten.
    if (!head !== !s.chat || newChat) renderChat();
    else { updateChatHead(); renderMessages(); }
  } else if (ui.view === 'connections') {
    if (changed('connView', [settings(), s.claude.found])) renderConnections();
  } else if (ui.view === 'library') {
    renderRunning();
  } else if (ui.view === 'automations') {
    renderAssistant(); // Status, Freigaben und Antworten des Assistenten
  } else if (['mac', 'web', 'local', 'brain', 'projects', 'planner', 'websites', 'finance', 'bitvideos', 'kontrolle', 'lernen'].includes(ui.view)) {
    // „Mein Mac“ und „Web“ laden ihre Daten selbst.
  } else {
    const addBtn = $('#add-task');
    if (addBtn) addBtn.disabled = !s.claude.found;
    renderTaskList();
  }
}

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('.theme-switch button').forEach((b) => b.addEventListener('click', () => api.updateSettings({ theme: b.dataset.theme })));
$('#search').addEventListener('input', (e) => {
  ui.search = e.target.value.trim().toLowerCase();
  if (ui.view !== 'overview') setView('overview', { focusHeading: false }); else renderOverview();
});
$('#aside-new-task').addEventListener('click', () => editTask({}));
$('#lock-btn').addEventListener('click', () => api.appLock());
$('#quick-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#quick-input');
  const t = input.value.trim();
  if (!t) return;
  input.value = '';
  sendMessage(t);
});
window.addEventListener('focus', () => { if (ui.view === 'overview') loadToday(false); });

// Einmal pro Minute die Zeitangaben ("vor 3 Min.") auffrischen.
setInterval(() => { if (ui.state) applyState(ui.state); }, 60000);

api.onState(applyState);
// Klick auf eine Mitteilung kann eine bestimmte Ansicht öffnen.
api.onGoView((v) => { if (typeof v === 'string') setView(v); });
renderNav();
api.getState().then((s) => {
  applyState(s);
  // Nach dem Entsperren lädt die Seite neu – den Verlauf des offenen Gesprächs wieder holen.
  if (s && s.chat && !ui.messages.length) {
    api.chatHistory().then((hist) => {
      if (!hist || !hist.length || ui.messages.length) return;
      ui.messages = hist.map((m) => ({ kind: m.role, text: m.text, tool: m.tool, detail: m.detail }));
      ui.shown = 0;
      if (ui.view === 'chat') renderMessages();
    }).catch(() => {});
  }
});
// Data Layer: Fehler in der Oberfläche melden (nur Ort und Fehlerart, keine Inhalte).
window.addEventListener('error', (e) => { api.kontrolleError(ui.view, (e.error && e.error.name) || 'Fehler').catch(() => {}); });
window.addEventListener('unhandledrejection', (e) => { api.kontrolleError(ui.view, (e.reason && e.reason.name) || 'Promise').catch(() => {}); });

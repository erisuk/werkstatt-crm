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
  if (!changed('status', st)) return;
  fill($('#claude-status'), h('span', { class: `dot ${st.dot}` }), st.text);
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
function setView(view) {
  if (ui.view === 'web' && view !== 'web') leaveWeb();
  ui.view = view;
  ui.sig.main = null;
  renderNav();
  renderMain();
  if (ui.state) renderApprovals();
  const heading = view !== 'chat' && $('#main h1');
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
    await api.respondApproval(a.id, decision);
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
async function loadToday(force) {
  if (!force && !needTodayRefresh()) return;
  const launch = force || !ui.today;
  ui.todayLoading = true;
  ui.todayAt = Date.now();
  let fresh = null;
  try { fresh = await api.macToday(launch); } catch {}
  if (fresh) {
    const old = ui.today || {};
    for (const key of Object.keys(fresh)) if (fresh[key] && fresh[key].notRunning && old[key]) fresh[key] = old[key];
  }
  ui.today = fresh;
  ui.todayLoading = false;
  if (ui.view === 'overview') renderOverview(true);
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
  if (!changed('main', ['overview', list, chat, enabledTasks, s.claude, ui.search, sel && sel.key, ui.groupMode, ui.showArchived, minute, settings().connections]) && !force) return;
  loadToday(false);

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
  resetChat(res.chat.gen, res.history.map((m) => ({ kind: m.role, text: m.text })));
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

  const input = h('textarea', { id: 'chat-input', rows: '1', placeholder: `Nachricht an Claude in ${s.chat.name} …` });
  const sendBtn = h('button', { type: 'submit', class: 'send', 'aria-label': 'Senden' });
  sendBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const form = h('form', { class: 'composer', onSubmit: (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.style.height = 'auto';
    sendMessage(t);
  } }, h('label', { for: 'chat-input', class: 'sr-only', text: 'Nachricht an Claude' }), input, sendBtn);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });

  const typing = h('div', { class: 'typing', id: 'typing', role: 'status', hidden: true },
    h('span'), h('span'), h('span'), h('span', { class: 'sr-only', text: 'Claude schreibt' }));
  fill(main, h('div', { class: 'chat' },
    h('div', { class: 'chat-head', id: 'chat-head' }),
    h('div', { class: 'messages', id: 'messages' }, typing),
    h('div', { id: 'chat-approvals', class: 'chat-approvals' }),
    form));
  ui.sig.chatHead = null;
  ui.shown = 0;
  updateChatHead();
  renderMessages();
  renderChatApprovals();
  // Aus „Skills & Agenten“: der Skill-Name steht schon im Eingabefeld.
  if (ui.prefill) { input.value = ui.prefill; ui.prefill = null; }
  input.focus();
}

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

function messageEl(m) {
  if (m.kind === 'error') {
    return h('div', { class: 'msg error' }, m.text,
      m.details ? h('details', {}, h('summary', { text: 'Details' }), h('pre', { text: m.details })) : null);
  }
  return h('div', { class: `msg ${m.kind}`, text: m.text });
}

// Aufeinanderfolgende Arbeitsschritte landen in einer aufklappbaren Gruppe.
function addStep(box, typing, text) {
  let group = typing.previousElementSibling;
  if (!group || !group.classList.contains('steps')) {
    group = h('details', { class: 'steps' }, h('summary'), h('ol', { class: 'steps-list' }));
    group.dataset.count = '0';
    box.insertBefore(group, typing);
  }
  const count = Number(group.dataset.count) + 1;
  group.dataset.count = String(count);
  group.querySelector('.steps-list').append(h('li', { text }));
  group.querySelector('summary').textContent = `Claude hat ${plural(count, 'Schritt', 'Schritte')} erledigt`;
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
    if (!ui.messages.length) box.insertBefore(h('div', { class: 'empty', id: 'chat-hint', text: 'Schreib Claude, was du brauchst.' }), typing);
  }
  if (ui.messages.length > ui.shown) {
    const hint = $('#chat-hint');
    if (hint) hint.remove();
    for (const m of ui.messages.slice(ui.shown)) {
      if (m.kind === 'tool') addStep(box, typing, m.text);
      else box.insertBefore(messageEl(m), typing);
    }
    ui.shown = ui.messages.length;
  }
  typing.hidden = !chatBusy() || chatApprovals().length > 0;
  if (nearBottom || ui.forceScroll) box.scrollTop = box.scrollHeight;
  ui.forceScroll = false;
}

async function sendMessage(text) {
  if (ui.state && ui.state.chat && ui.chatGen !== ui.state.chat.gen) resetChat(ui.state.chat.gen, []);
  ui.messages.push({ kind: 'user', text });
  ui.forceScroll = true;
  if (ui.view !== 'chat') setView('chat'); else renderMessages();
  const res = await api.send(text);
  if (!res.ok) {
    ui.messages.push({ kind: 'error', text: res.error || 'Die Nachricht konnte nicht gesendet werden.' });
    renderMessages();
  }
}

api.onChatEvent((ev) => {
  if (ev.gen !== ui.chatGen) return; // Ereignis eines früheren Chats
  if (ev.kind === 'text') ui.messages.push({ kind: 'assistant', text: ev.text });
  else if (ev.kind === 'tool') ui.messages.push({ kind: 'tool', text: ev.text });
  else if (ev.kind === 'error') ui.messages.push({ kind: 'error', text: ev.text, details: ev.details });
  else return;
  if (ui.view === 'chat') renderMessages();
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
  else if (ui.view === 'web') renderWeb();
  else renderTasks();
}

function applyState(s) {
  const firstLoad = !ui.state;
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
  } else if (ui.view === 'mac' || ui.view === 'web') {
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
  if (ui.view !== 'overview') setView('overview'); else renderOverview();
});
$('#aside-new-task').addEventListener('click', () => editTask({}));
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
renderNav();
api.getState().then(applyState);

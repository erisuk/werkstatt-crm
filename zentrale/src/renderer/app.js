// Oberfläche der Zentrale. Alle Texte werden mit textContent gesetzt, nie als HTML.
const api = window.zentrale;
if (api.platform === 'darwin') document.documentElement.classList.add('mac');

const ui = {
  state: null,
  view: 'overview',
  selected: null,
  messages: [],
  search: '',
  editingTask: null,
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

const AVATAR_COLORS = ['#0064d2', '#dc2626', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#4d7c0f', '#1d4ed8'];
function colorFor(name) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= start) return `Heute ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ms >= start - 86400000) return 'Gestern';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear()}`;
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

function projectKey(p) { return p.path || p.name; }
function projects() { return (ui.state && ui.state.projects) || []; }
function selectedProject() {
  const list = projects();
  return list.find((p) => projectKey(p) === ui.selected) || list[0] || null;
}

function chatStatus() {
  const s = ui.state;
  if (!s) return { dot: '', text: 'Lädt …' };
  if (!s.claude.found) return { dot: 'red', text: 'Claude Code nicht gefunden' };
  if (!s.chat) return { dot: '', text: 'Getrennt' };
  if (s.chat.status === 'busy') return { dot: 'amber pulse', text: 'Claude arbeitet …', pill: 'amber', short: 'arbeitet' };
  if (s.chat.status === 'ready') return { dot: 'green', text: 'Claude verbunden', pill: 'green', short: 'bereit' };
  return { dot: '', text: 'Pausiert', short: 'pausiert' };
}

// ---------- Titelleiste und Menü ----------

function renderStatus() {
  const st = chatStatus();
  const el = $('#claude-status');
  fill(el, h('span', { class: `dot ${st.dot}` }), st.text);
}

function renderNav() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const on = b.dataset.view === ui.view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

function setView(view) {
  ui.view = view;
  renderNav();
  renderMain();
}

// ---------- Übersicht ----------

function matches(text) {
  return !ui.search || String(text || '').toLowerCase().includes(ui.search);
}

function renderOverview() {
  const s = ui.state;
  const main = $('#main');
  const list = projects();
  const sel = selectedProject();
  const totalSessions = list.reduce((n, p) => n + p.sessions.length, 0);
  const activeTasks = s.tasks.filter((t) => t.enabled).length;

  const visible = list.filter((p) => matches(p.name) || p.sessions.some((x) => matches(x.title)));

  const projectCards = visible.map((p) => {
    const n = p.sessions.length;
    return h('button', {
      class: `project${sel && projectKey(p) === projectKey(sel) ? ' selected' : ''}`,
      'aria-pressed': String(!!sel && projectKey(p) === projectKey(sel)),
      title: p.path || p.name,
      onClick: () => { ui.selected = projectKey(p); renderOverview(); },
    },
    h('span', { class: 'avatar', style: { background: colorFor(p.name) }, text: p.name.charAt(0).toUpperCase() }),
    h('span', { class: 'text' },
      h('span', { class: 'name', text: p.name }),
      h('span', { class: 'meta', text: `${n === 1 ? '1 Sitzung' : `${n} Sitzungen`} · ${formatWhen(p.updatedAt)}` })));
  });
  projectCards.push(h('button', { class: 'project add', onClick: addProject }, '+ Neues Projekt'));

  let sessionsBox;
  if (!sel) {
    sessionsBox = h('div', { class: 'card empty', text: 'Noch keine Sitzungen. Lege mit „+ Neues Projekt“ los.' });
  } else {
    const rows = sel.sessions.filter((x) => matches(x.title) || matches(sel.name)).map((x) => {
      const isChat = s.chat && s.chat.sessionId === x.id;
      const busy = isChat && s.chat.status === 'busy';
      return h('div', { class: 'row' },
        h('span', { class: `dot ${busy ? 'amber pulse' : isChat ? 'green' : ''}` }),
        h('div', { class: 'grow' },
          h('div', { class: 'title', text: x.title }),
          h('div', { class: 'sub', text: isChat ? (busy ? 'Claude arbeitet gerade daran' : 'Im Chat geöffnet') : (sel.path || '') })),
        h('span', { class: 'when', text: formatWhen(x.updatedAt) }),
        h('button', { class: 'link', onClick: () => openSession(x, sel) }, 'Öffnen'));
    });
    sessionsBox = h('div', { class: 'card list' }, rows.length ? rows : h('div', { class: 'empty', text: 'Keine passenden Sitzungen.' }));
  }

  fill(main,
    h('div', {}, h('div', { class: 'date', text: todayLabel() }), h('h1', { text: greeting() })),
    s.claude.found ? null : h('div', { class: 'notice' },
      'Claude Code wurde auf diesem Mac nicht gefunden. Installiere es im Terminal mit ',
      h('code', { text: 'npm install -g @anthropic-ai/claude-code' }),
      ', melde dich mit ', h('code', { text: 'claude' }), ' an und starte die Zentrale neu.'),
    h('div', { class: 'stats' },
      stat('Projekte', list.length), stat('Sitzungen', totalSessions), stat('Tägliche Aufgaben', activeTasks)),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Meine Projekte' })),
      h('div', { class: 'projects' }, projectCards)),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('h2', { text: 'Sitzungen' }),
        h('span', { class: 'sub', text: sel ? sel.name : '' }),
        h('span', { class: 'spacer' }),
        sel ? h('button', { class: 'btn', disabled: !s.claude.found, onClick: () => newSession(sel.path) }, '+ Neue Sitzung') : null),
      sessionsBox));
}

function stat(label, value) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: String(value) }));
}

async function addProject() {
  const dir = await api.pickFolder();
  if (dir) newSession(dir);
}

async function newSession(cwd) {
  const res = await api.newSession({ cwd });
  if (!res.chat) return;
  ui.messages = [];
  setView('chat');
}

async function openSession(session, project) {
  const res = await api.openSession({ sessionId: session.id, cwd: project.path, title: session.title });
  if (res.error || !res.chat) { alert(res.error || 'Claude Code wurde nicht gefunden.'); return; }
  ui.messages = res.history.map((m) => ({ kind: m.role, text: m.text }));
  setView('chat');
}

// ---------- Chat ----------

function renderChat() {
  const s = ui.state;
  const main = $('#main');
  if (!s.chat) {
    fill(main, h('div', { class: 'card empty' },
      s.claude.found ? 'Wähle in der Übersicht ein Projekt und öffne eine Sitzung.' : 'Claude Code wurde nicht gefunden.'));
    return;
  }
  const input = h('textarea', { id: 'chat-input', rows: '1', placeholder: `Nachricht an Claude in ${s.chat.name} …` });
  const sendBtn = h('button', { type: 'submit', class: 'send', 'aria-label': 'Senden' });
  sendBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
  const form = h('form', { class: 'composer', onSubmit: (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.style.height = 'auto';
    sendMessage(t);
  } }, h('label', { for: 'chat-input', class: 'sr-only', text: 'Nachricht an Claude' }), input, sendBtn);

  fill(main, h('div', { class: 'chat' },
    h('div', { class: 'chat-head', id: 'chat-head' }),
    h('div', { class: 'messages', id: 'messages', 'aria-live': 'polite' }),
    form));
  updateChatHead();
  renderMessages();
  input.focus();
}

function updateChatHead() {
  const head = $('#chat-head');
  if (!head || !ui.state.chat) return;
  const c = ui.state.chat;
  const st = chatStatus();
  fill(head,
    h('span', { class: 'avatar', style: { background: colorFor(c.name) }, text: c.name.charAt(0).toUpperCase() }),
    h('div', { class: 'grow' },
      h('div', { class: 'date', text: c.name }),
      h('h1', { text: c.title || 'Neue Sitzung' })),
    h('span', { class: `pill ${st.pill || ''}`, text: st.short || st.text }),
    c.status === 'busy' ? h('button', { class: 'btn ghost', onClick: () => api.stopChat() }, 'Stoppen') : null,
    h('button', { class: 'btn ghost', onClick: () => newSession(c.cwd) }, 'Neue Sitzung'));
}

function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const items = ui.messages.map((m) => {
    if (m.kind === 'tool') return h('div', { class: 'tool', text: `› ${m.text}` });
    return h('div', { class: `msg ${m.kind}`, text: m.text });
  });
  if (!items.length) items.push(h('div', { class: 'empty', text: 'Schreib Claude, was du brauchst.' }));
  if (ui.state.chat && ui.state.chat.status === 'busy') {
    items.push(h('div', { class: 'typing', 'aria-label': 'Claude schreibt' }, h('span'), h('span'), h('span')));
  }
  fill(box, ...items);
  if (nearBottom || ui.forceScroll) box.scrollTop = box.scrollHeight;
  ui.forceScroll = false;
}

async function sendMessage(text) {
  ui.messages.push({ kind: 'user', text });
  ui.forceScroll = true;
  if (ui.view !== 'chat') setView('chat'); else renderMessages();
  const res = await api.send(text);
  if (!res.ok) {
    ui.messages.push({ kind: 'error', text: res.error || 'Nachricht konnte nicht gesendet werden.' });
    renderMessages();
  }
}

api.onChatEvent((ev) => {
  if (ev.kind === 'text') ui.messages.push({ kind: 'assistant', text: ev.text });
  else if (ev.kind === 'tool') ui.messages.push({ kind: 'tool', text: ev.text });
  else if (ev.kind === 'result' && ev.isError && ev.text) ui.messages.push({ kind: 'error', text: ev.text });
  else return;
  if (ui.view === 'chat') renderMessages();
});

// ---------- Tägliche Aufgaben ----------

function taskInfo(t) {
  if (!t.enabled) return 'Pausiert';
  if (t.running) return 'Läuft gerade …';
  if (!t.lastRunAt) return 'Täglich · noch nie gelaufen';
  return `Täglich · zuletzt ${formatWhen(t.lastRunAt)} ${t.lastStatus === 'ok' ? 'erfolgreich' : 'mit Fehler'}`;
}

function taskSwitch(t) {
  return h('button', {
    class: 'switch', role: 'switch', 'aria-checked': String(!!t.enabled),
    'aria-label': `${t.name} ${t.enabled ? 'pausieren' : 'einschalten'}`,
    onClick: () => api.toggleTask(t.id),
  });
}

function renderTasks() {
  const main = $('#main');
  fill(main,
    h('div', { class: 'section-head' },
      h('h1', { text: 'Tägliche Aufgaben' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', disabled: !ui.state.claude.found, onClick: () => editTask({}) }, '+ Neue Aufgabe')),
    h('p', { class: 'date', text: 'Diese Aufgaben laufen jeden Tag zur eingestellten Uhrzeit auf deinem Mac, solange die Zentrale geöffnet ist. Verpasste Aufgaben holt sie beim nächsten Start nach. Deine Cloud-Aufgaben laufen davon unabhängig weiter.' }),
    h('div', { id: 'task-form' }),
    h('div', { id: 'task-list', class: 'section' }));
  renderTaskForm();
  renderTaskList();
}

function renderTaskList() {
  const box = $('#task-list');
  if (!box) return;
  const tasks = ui.state.tasks;
  if (!tasks.length) {
    fill(box, h('div', { class: 'card empty', text: 'Noch keine Aufgaben. Lege eine mit „+ Neue Aufgabe“ an.' }));
    return;
  }
  fill(box, ...tasks.map((t) => h('div', { class: 'card' },
    h('div', { class: 'task' },
      h('div', { class: 'time', text: t.time }),
      h('div', { class: 'grow' },
        h('div', { class: 'name', text: t.name }),
        h('div', { class: 'info', text: `${taskInfo(t)}${t.cwd ? ` · ${t.cwd.split('/').pop()}` : ''}` })),
      h('button', { class: 'link', onClick: () => editTask(t) }, 'Bearbeiten'),
      h('button', { class: 'link', disabled: t.running || !ui.state.claude.found, onClick: () => api.runTask(t.id) }, 'Jetzt ausführen'),
      h('button', { class: 'btn danger', onClick: () => { if (confirm(`„${t.name}“ löschen?`)) api.removeTask(t.id); } }, 'Löschen'),
      taskSwitch(t)),
    t.lastText ? h('details', { class: 'row' },
      h('summary', { text: 'Letztes Ergebnis' }),
      h('div', { class: 'msg assistant result', text: t.lastText })) : null)));
}

function editTask(t) {
  ui.editingTask = { id: t.id || null, name: t.name || '', time: t.time || '08:00', prompt: t.prompt || '', cwd: t.cwd || null };
  if (ui.view !== 'tasks') setView('tasks'); else renderTaskForm();
}

function renderTaskForm() {
  const box = $('#task-form');
  if (!box) return;
  const t = ui.editingTask;
  if (!t) { fill(box); return; }
  const folderLabel = h('span', { text: t.cwd || 'Kein Projekt (Benutzerordner)' });
  const name = h('input', { id: 'task-name', type: 'text', value: t.name, placeholder: 'z. B. Tagesplan' });
  const time = h('input', { id: 'task-time', type: 'time', value: t.time, required: true });
  const prompt = h('textarea', { id: 'task-prompt', placeholder: 'Was soll Claude jeden Tag tun?' });
  prompt.value = t.prompt;
  const form = h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    if (!prompt.value.trim()) { prompt.focus(); return; }
    await api.saveTask({ id: t.id, name: name.value, time: time.value, prompt: prompt.value, cwd: t.cwd });
    ui.editingTask = null;
    renderTaskForm();
  } },
  h('div', { class: 'field' }, h('label', { for: 'task-name', text: 'Name' }), name),
  h('div', { class: 'field' }, h('label', { for: 'task-time', text: 'Uhrzeit' }), time),
  h('div', { class: 'field full' }, h('label', { text: 'Projekt' }),
    h('div', { class: 'folder' }, folderLabel,
      h('button', { type: 'button', class: 'btn ghost', onClick: async () => {
        const dir = await api.pickFolder();
        if (dir) { t.cwd = dir; folderLabel.textContent = dir; }
      } }, 'Ordner wählen'))),
  h('div', { class: 'field full' }, h('label', { for: 'task-prompt', text: 'Auftrag an Claude' }), prompt,
    h('span', { class: 'hint', text: 'Claude darf dabei Dateien im Projektordner bearbeiten.' })),
  h('div', { class: 'actions full' },
    h('button', { type: 'button', class: 'btn ghost', onClick: () => { ui.editingTask = null; renderTaskForm(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn' }, 'Speichern')));
  fill(box, form);
  name.focus();
}

// ---------- Seitenleiste rechts ----------

function renderAside() {
  const s = ui.state;
  const agents = [];
  if (s.chat) {
    const st = chatStatus();
    agents.push(h('div', { class: 'card agent' },
      h('div', { class: 'top' },
        h('div', { class: 'claude-avatar', text: 'C' }),
        h('div', { class: 'grow' },
          h('div', { class: 'name', text: s.chat.title || 'Neue Sitzung' }),
          h('div', { class: 'where', text: s.chat.name })),
        h('span', { class: `pill ${st.pill || ''}`, text: st.short || st.text })),
      h('button', { class: 'link start', onClick: () => setView('chat') }, 'Zum Chat')));
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
  fill($('#agents'), ...(agents.length ? agents : [h('div', { class: 'card empty', text: 'Kein Agent aktiv.' })]));

  const tasks = s.tasks.map((t) => h('div', { class: 'card task' },
    h('div', { class: 'time', text: t.time }),
    h('div', { class: 'grow' },
      h('div', { class: 'name', text: t.name }),
      h('div', { class: 'info', text: taskInfo(t) })),
    taskSwitch(t)));
  fill($('#aside-tasks'), ...(tasks.length ? tasks : [h('div', { class: 'card empty', text: 'Noch keine Aufgaben.' })]));

  $('#quick-input').placeholder = s.chat ? `Frag Claude zu ${s.chat.name} …` : 'Frag Claude …';
}

// ---------- Ablauf ----------

function renderMain() {
  if (!ui.state) return;
  if (ui.view === 'overview') renderOverview();
  else if (ui.view === 'chat') renderChat();
  else renderTasks();
}

function applyState(s) {
  const firstLoad = !ui.state;
  ui.state = s;
  renderStatus();
  renderAside();
  if (firstLoad) { renderMain(); return; }
  if (ui.view === 'overview') renderOverview();
  else if (ui.view === 'chat') {
    // Der Chat wird nur neu aufgebaut, wenn er vorher leer war; sonst bleibt die Eingabe erhalten.
    if (!$('#chat-head')) renderChat();
    else { updateChatHead(); renderMessages(); }
  } else renderTaskList();
}

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
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

api.onState(applyState);
renderNav();
api.getState().then(applyState);

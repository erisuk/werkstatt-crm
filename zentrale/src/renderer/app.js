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

function projectKey(p) { return p.path || p.name; }
function projects() { return (ui.state && ui.state.projects) || []; }

function chatStatus() {
  const s = ui.state;
  if (!s) return { dot: '', text: 'Lädt …' };
  if (s.claude.checking) return { dot: 'amber pulse', text: 'Claude wird gestartet …' };
  if (!s.claude.found) return { dot: 'red', text: 'Claude Code nicht gefunden' };
  if (!s.chat) return { dot: '', text: 'Kein Chat offen' };
  if (s.chat.status === 'busy') return { dot: 'amber pulse', text: 'Claude arbeitet …', pill: 'amber', short: 'arbeitet' };
  if (s.chat.status === 'error') return { dot: 'red', text: 'Claude hatte einen Fehler', pill: 'red', short: 'Fehler' };
  return { dot: 'green', text: 'Claude bereit', pill: 'green', short: 'bereit' };
}

function chatBusy() {
  return !!(ui.state && ui.state.chat && ui.state.chat.status === 'busy');
}

// ---------- Titelleiste und Menü ----------

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

function setView(view) {
  ui.view = view;
  ui.sig.main = null;
  renderNav();
  renderMain();
}

// ---------- Übersicht ----------

function matches(text) {
  return !ui.search || String(text || '').toLowerCase().includes(ui.search);
}

function renderOverview(force) {
  const s = ui.state;
  const list = projects();
  const visible = list.filter((p) => matches(p.name) || p.sessions.some((x) => matches(x.title)));
  // Ist das gewählte Projekt durch die Suche ausgeblendet, nehmen wir das erste sichtbare.
  const sel = visible.find((p) => projectKey(p) === ui.selected) || visible[0] || null;
  const chat = s.chat ? { id: s.chat.sessionId, status: s.chat.status } : null;
  const enabledTasks = s.tasks.filter((t) => t.enabled).length;
  const minute = Math.floor(Date.now() / 60000);
  if (!changed('main', ['overview', list, chat, enabledTasks, s.claude, ui.search, sel && projectKey(sel), minute]) && !force) return;

  const totalSessions = list.reduce((n, p) => n + p.sessions.length, 0);
  const projectCards = visible.map((p) => {
    const key = projectKey(p);
    const isSel = !!sel && key === projectKey(sel);
    const n = p.sessions.length;
    return h('button', {
      class: `project${isSel ? ' selected' : ''}`,
      'aria-pressed': String(isSel),
      'data-focus': `project:${key}`,
      title: p.path || p.name,
      onClick: () => { ui.selected = key; renderOverview(); },
    },
    h('span', { class: 'avatar', style: { background: colorFor(p.name) }, text: p.name.charAt(0).toUpperCase() }),
    h('span', { class: 'text' },
      h('span', { class: 'name', text: p.name }),
      h('span', { class: 'meta', text: `${n === 1 ? '1 Sitzung' : `${n} Sitzungen`} · ${formatWhen(p.updatedAt)}` })));
  });
  projectCards.push(h('button', { class: 'project add', 'data-focus': 'add-project', onClick: addProject }, '+ Neues Projekt'));

  let sessionsBox;
  if (!list.length) {
    sessionsBox = h('div', { class: 'card empty', text: 'Noch keine Sitzungen. Lege mit „+ Neues Projekt“ los.' });
  } else if (!sel) {
    sessionsBox = h('div', { class: 'card empty', text: `Nichts gefunden für „${ui.search}“.` });
  } else {
    const rows = sel.sessions.filter((x) => matches(x.title) || matches(sel.name)).map((x) => {
      const isChat = !!s.chat && s.chat.sessionId === x.id;
      const busy = isChat && s.chat.status === 'busy';
      return h('div', { class: 'row' },
        h('span', { class: `dot ${busy ? 'amber pulse' : isChat ? 'green' : ''}` }),
        h('div', { class: 'grow' },
          h('div', { class: 'title', text: x.title }),
          isChat ? h('div', { class: 'sub', text: busy ? 'Claude arbeitet gerade daran' : 'Im Chat geöffnet' }) : null),
        h('span', { class: 'when', text: formatWhen(x.updatedAt) }),
        h('button', { class: 'link', 'data-focus': `open:${x.id}`, onClick: () => openSession(x) }, 'Öffnen'));
    });
    sessionsBox = h('div', { class: 'card list' }, rows.length ? rows : h('div', { class: 'empty', text: 'Keine passenden Sitzungen.' }));
  }

  keepFocus(() => fill($('#main'),
    h('div', {}, h('div', { class: 'date', text: todayLabel() }), h('h1', { text: greeting() })),
    s.claude.found || s.claude.checking ? null : h('div', { class: 'notice' },
      'Claude Code wurde auf diesem Mac nicht gefunden. Installiere es im Terminal mit ',
      h('code', { text: 'npm install -g @anthropic-ai/claude-code' }),
      ', melde dich mit ', h('code', { text: 'claude' }), ' an und starte die Zentrale neu.'),
    h('div', { class: 'stats' },
      stat('Projekte', list.length), stat('Sitzungen', totalSessions), stat('Tägliche Aufgaben', enabledTasks)),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Meine Projekte' })),
      h('div', { class: 'projects' }, projectCards)),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('h2', { text: 'Sitzungen' }),
        h('span', { class: 'sub', text: sel ? sel.name : '' }),
        h('span', { class: 'spacer' }),
        sel ? h('button', { class: 'btn', 'data-focus': 'new-session', disabled: !s.claude.found, onClick: () => newSession(sel.path) }, '+ Neue Sitzung') : null),
      sessionsBox)));
}

function stat(label, value) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: String(value) }));
}

// Fragt nach, bevor ein arbeitender Claude unterbrochen wird.
function okToLeaveBusyChat() {
  if (!chatBusy()) return true;
  return confirm(`Claude arbeitet noch an „${ui.state.chat.title || 'Neue Sitzung'}“. Trotzdem wechseln? Die laufende Arbeit wird dann abgebrochen.`);
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
  // Dieselbe Sitzung ist schon offen: nur hinwechseln, nichts neu starten.
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
    const list = projects();
    fill(main, h('div', { class: 'card empty chat-empty' },
      h('p', { text: s.claude.found ? 'Gerade ist kein Chat offen.' : 'Claude Code wurde nicht gefunden.' }),
      s.claude.found ? h('div', { class: 'actions center' },
        list[0] ? h('button', { class: 'btn', onClick: () => newSession(list[0].path) }, `Neuer Chat in ${list[0].name}`) : null,
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
    form));
  ui.sig.chatHead = null;
  ui.shown = 0;
  updateChatHead();
  renderMessages();
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
      h('div', { class: 'date', text: c.name, title: c.cwd }),
      h('h1', { text: c.title || 'Neue Sitzung' })),
    h('span', { class: `pill ${st.pill || ''}`, text: st.short || st.text }),
    c.status === 'busy' ? h('button', { class: 'btn ghost', 'data-focus': 'stop', onClick: () => api.stopChat() }, 'Stoppen') : null,
    h('button', { class: 'btn ghost', 'data-focus': 'chat-new', onClick: () => newSession(c.cwd) }, 'Neue Sitzung')));
}

function messageEl(m) {
  if (m.kind === 'tool') return h('div', { class: 'tool', text: `› ${m.text}` });
  if (m.kind === 'error') {
    return h('div', { class: 'msg error' }, m.text,
      m.details ? h('details', {}, h('summary', { text: 'Details' }), h('pre', { text: m.details })) : null);
  }
  return h('div', { class: `msg ${m.kind}`, text: m.text });
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
    for (const m of ui.messages.slice(ui.shown)) box.insertBefore(messageEl(m), typing);
    ui.shown = ui.messages.length;
  }
  typing.hidden = !chatBusy();
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
    return;
  }
  // Wurde dabei ein neuer Chat gestartet, gehört die Nachricht zu ihm.
  if (res.gen != null && res.gen !== ui.chatGen) {
    ui.chatGen = res.gen;
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

// ---------- Tägliche Aufgaben ----------

function nextRunLabel(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.time || '');
  if (!m) return '';
  const now = new Date();
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const today = now < at && t.lastRunDay !== todayKey && t.skipDay !== todayKey;
  return `Nächster Lauf: ${today ? 'heute' : 'morgen'} ${t.time}`;
}

function taskInfo(t) {
  if (!t.enabled) return 'Pausiert';
  if (t.running) return 'Läuft gerade …';
  const last = t.lastRunAt ? ` · zuletzt ${formatWhen(t.lastRunAt)} ${t.lastStatus === 'ok' ? 'erfolgreich' : 'mit Fehler'}` : '';
  return `${nextRunLabel(t)}${last}`;
}

function taskSwitch(t, where) {
  return h('button', {
    class: 'switch', role: 'switch', 'aria-checked': String(!!t.enabled),
    'aria-label': t.name, 'data-focus': `switch:${where}:${t.id}`,
    onClick: () => api.toggleTask(t.id),
  });
}

function renderTasks() {
  fill($('#main'),
    h('div', { class: 'section-head wrap' },
      h('h1', { text: 'Tägliche Aufgaben' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', disabled: !ui.state.claude.found, onClick: () => editTask({}) }, '+ Neue Aufgabe')),
    h('p', { class: 'date', text: 'Diese Aufgaben laufen jeden Tag zur eingestellten Uhrzeit auf deinem Mac, solange die Zentrale geöffnet ist. War sie zu der Uhrzeit geschlossen, läuft die Aufgabe, sobald du die Zentrale am selben Tag öffnest. Deine Cloud-Aufgaben laufen davon unabhängig weiter.' }),
    h('div', { id: 'task-form' }),
    h('div', { id: 'task-list', class: 'section' }));
  ui.sig.tasks = null;
  renderTaskForm();
  renderTaskList();
}

function renderTaskList() {
  const box = $('#task-list');
  if (!box) return;
  const tasks = ui.state.tasks;
  const minute = Math.floor(Date.now() / 60000);
  if (!changed('tasks', [tasks, ui.state.claude.found, minute])) return;
  if (!tasks.length) {
    fill(box, h('div', { class: 'card empty', text: 'Noch keine Aufgaben. Lege eine mit „+ Neue Aufgabe“ an.' }));
    return;
  }
  keepFocus(() => fill(box, tasks.map((t) => {
    const result = t.lastText ? h('details', { class: 'result-box' },
      h('summary', { text: t.lastStatus === 'ok' ? 'Letztes Ergebnis' : 'Letzter Fehler' }),
      h('div', { class: 'msg assistant result', text: t.lastText })) : null;
    if (result) {
      result.open = ui.openResults.has(t.id);
      result.addEventListener('toggle', () => {
        if (result.open) ui.openResults.add(t.id); else ui.openResults.delete(t.id);
      });
    }
    return h('div', { class: 'card' },
      h('div', { class: 'task wide' },
        h('div', { class: 'time', text: t.time }),
        h('div', { class: 'grow' },
          h('div', { class: 'name', text: t.name }),
          h('div', { class: 'info', text: `${taskInfo(t)}${t.cwd ? ` · ${t.cwd.split('/').pop()}` : ''}` })),
        h('div', { class: 'task-actions' },
          h('button', { class: 'link', 'data-focus': `edit:${t.id}`, onClick: () => editTask(t) }, 'Bearbeiten'),
          h('button', { class: 'link', 'data-focus': `run:${t.id}`, disabled: t.running || !ui.state.claude.found, onClick: () => api.runTask(t.id) }, 'Jetzt ausführen'),
          taskSwitch(t, 'list'))),
      result);
  })));
}

function editTask(t) {
  const cur = ui.editingTask;
  if (cur && ui.editingDirty && cur.id !== (t.id || null) && !confirm('Deine Änderungen an der Aufgabe sind noch nicht gespeichert. Verwerfen?')) return;
  if (cur && cur.id === (t.id || null) && cur.id) { if (ui.view !== 'tasks') setView('tasks'); return; }
  ui.editingTask = { id: t.id || null, name: t.name || '', time: t.time || '08:00', prompt: t.prompt || '', cwd: t.cwd || null };
  ui.editingDirty = false;
  if (ui.view !== 'tasks') setView('tasks'); else renderTaskForm();
}

function renderTaskForm() {
  const box = $('#task-form');
  if (!box) return;
  const t = ui.editingTask;
  if (!t) { fill(box); return; }
  const dirty = () => { ui.editingDirty = true; };
  const folderLabel = h('span', { text: t.cwd || 'Kein Projekt (Benutzerordner)' });
  const name = h('input', { id: 'task-name', type: 'text', placeholder: 'z. B. Tagesplan' });
  name.value = t.name;
  name.addEventListener('input', () => { t.name = name.value; dirty(); });
  const time = h('input', { id: 'task-time', type: 'time', required: true });
  time.value = t.time;
  time.addEventListener('input', () => { t.time = time.value; dirty(); });
  const prompt = h('textarea', { id: 'task-prompt', placeholder: 'Was soll Claude jeden Tag tun?' });
  prompt.value = t.prompt;
  prompt.addEventListener('input', () => { t.prompt = prompt.value; dirty(); });
  const close = () => { ui.editingTask = null; ui.editingDirty = false; renderTaskForm(); };

  const form = h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    if (!t.prompt.trim()) { prompt.focus(); return; }
    await api.saveTask({ id: t.id, name: t.name, time: t.time, prompt: t.prompt, cwd: t.cwd });
    close();
  } },
  h('h2', { class: 'full', text: t.id ? 'Aufgabe bearbeiten' : 'Neue Aufgabe' }),
  h('div', { class: 'field' }, h('label', { for: 'task-name', text: 'Name' }), name),
  h('div', { class: 'field' }, h('label', { for: 'task-time', text: 'Uhrzeit' }), time),
  h('div', { class: 'field full' }, h('span', { class: 'label', text: 'Projekt' }),
    h('div', { class: 'folder' }, folderLabel,
      h('button', { type: 'button', class: 'btn ghost', onClick: async () => {
        const dir = await api.pickFolder();
        if (dir) { t.cwd = dir; folderLabel.textContent = dir; dirty(); }
      } }, 'Ordner wählen'))),
  h('div', { class: 'field full' }, h('label', { for: 'task-prompt', text: 'Auftrag an Claude' }), prompt,
    h('span', { class: 'hint', text: 'Claude darf dabei Dateien im Projektordner bearbeiten.' })),
  h('div', { class: 'actions full' },
    t.id ? h('button', { type: 'button', class: 'btn danger', onClick: async () => {
      if (!confirm(`„${t.name || 'Aufgabe'}“ löschen?`)) return;
      await api.removeTask(t.id);
      close();
    } }, 'Löschen') : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: close }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn' }, 'Speichern')));
  fill(box, form);
  name.focus();
}

// ---------- Seitenleiste rechts ----------

function renderAside() {
  const s = ui.state;
  const minute = Math.floor(Date.now() / 60000);
  if (!changed('aside', [s.chat, s.tasks, s.claude.found, minute])) return;
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
    const head = $('#chat-head');
    // Neu aufbauen nur, wenn ein Chat dazukam oder wegfiel; sonst bleibt die Eingabe erhalten.
    if (!head !== !s.chat) renderChat();
    else if (s.chat && ui.chatGen !== s.chat.gen) renderChat();
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

// Einmal pro Minute die Zeitangaben ("vor 3 Min.") auffrischen.
setInterval(() => { if (ui.state) applyState(ui.state); }, 60000);

api.onState(applyState);
renderNav();
api.getState().then(applyState);

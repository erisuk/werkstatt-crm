// Ansicht „Tägliche Aufgaben“. Nutzt die Helfer aus app.js (h, fill, ui, api …).
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
      h('button', { class: 'btn', id: 'add-task', disabled: !ui.state.claude.found, onClick: () => editTask({}) }, '+ Neue Aufgabe')),
    h('p', { class: 'date', text: 'Diese Aufgaben laufen jeden Tag zur eingestellten Uhrzeit auf deinem Mac, solange die Zentrale geöffnet ist. War sie zu der Uhrzeit geschlossen, läuft die Aufgabe, sobald du die Zentrale am selben Tag öffnest. Braucht Claude dabei eine Freigabe, meldet sich die Zentrale. Deine Cloud-Aufgaben laufen davon unabhängig weiter.' }),
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
  // Dieselbe Aufgabe (oder schon eine neue) ist bereits offen: nur hinwechseln.
  if (cur && cur.id === (t.id || null)) { if (ui.view !== 'tasks') setView('tasks'); return; }
  if (cur && ui.editingDirty && !confirm('Deine Änderungen an der Aufgabe sind noch nicht gespeichert. Verwerfen?')) return;
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
  const prompt = h('textarea', { id: 'task-prompt', placeholder: 'Was soll Claude jeden Tag tun? z. B. „Fasse meine ungelesenen Mails zusammen und lege mir eine Notiz an.“' });
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
    h('span', { class: 'hint', text: 'Claude darf Dateien im gewählten Projektordner ohne Rückfrage bearbeiten. Ohne Projektordner und für alles andere fragt die Zentrale dich vorher.' })),
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


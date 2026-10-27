// Ansicht „Gehirn“: dein Obsidian-Vault – suchen, lesen, in Obsidian öffnen, schnell etwas merken,
// und Claude fragen, was er dazu weiß. Nutzt die Helfer aus app.js (h, fill, ui, api …).

const brain = { vault: undefined, query: '', results: null, note: null, loading: false, quickTitle: '', quickText: '', message: null, timer: null };

async function loadBrain() {
  if (brain.vault === undefined) {
    try { brain.vault = (await api.vaultInfo()).vault; } catch { brain.vault = null; }
    const sub = $('#brain-sub');
    if (sub && brain.vault) sub.textContent = `Dein Obsidian-Vault „${brain.vault.name}“. Claude in der Zentrale kennt ihn und schaut dort nach, bevor er zu deinen Projekten antwortet.`;
  }
  if (!brain.vault) { renderBrainBody(); return; }
  brain.loading = true;
  const res = await api.vaultSearch(brain.query);
  brain.loading = false;
  brain.results = res && res.ok ? res.data : [];
  brain.message = res && !res.ok ? res.error : null;
  renderBrainBody();
}

async function openNote(rel) {
  const res = await api.vaultRead(rel);
  brain.note = res.ok ? res.data : null;
  brain.message = res.ok ? null : res.error;
  renderBrainBody();
}

function noteItem(n) {
  const active = brain.note && brain.note.rel === n.rel;
  return h('button', { class: `note-item${active ? ' active' : ''}`, 'data-focus': `note:${n.rel}`, 'aria-pressed': String(!!active), onClick: () => openNote(n.rel) },
    h('span', { class: 'title', text: n.title }),
    h('span', { class: 'sub', text: [n.folder, formatWhen(n.modified)].filter(Boolean).join(' · ') }),
    n.snippet ? h('span', { class: 'snippet', text: n.snippet }) : null);
}

function quickCapture() {
  const title = h('input', { id: 'brain-title', type: 'text', placeholder: 'Titel (optional)', 'data-focus': 'brain-title' });
  title.value = brain.quickTitle;
  title.addEventListener('input', () => { brain.quickTitle = title.value; });
  const text = h('textarea', { id: 'brain-text', rows: '3', placeholder: 'Was soll ins Gehirn? Idee, Info, Erkenntnis …', 'data-focus': 'brain-text' });
  text.value = brain.quickText;
  text.addEventListener('input', () => { brain.quickText = text.value; });
  const clear = () => { brain.quickTitle = ''; brain.quickText = ''; };
  return h('form', { class: 'card form compact-form', onSubmit: async (e) => {
    e.preventDefault();
    const res = await api.vaultAdd(title.value, text.value);
    brain.message = res.ok ? `Gespeichert im Eingang: ${res.data.rel}` : res.error;
    if (res.ok) { clear(); await loadBrain(); openNote(res.data.rel); } else renderBrainBody();
  } },
  h('h2', { class: 'full', text: 'Schnell merken' }),
  h('div', { class: 'field full' }, h('label', { for: 'brain-title', class: 'sr-only', text: 'Titel' }), title),
  h('div', { class: 'field full' }, h('label', { for: 'brain-text', class: 'sr-only', text: 'Text' }), text),
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: 'Landet als neue Notiz im Ordner „Eingang“.' }), h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', disabled: !ui.state.claude.found, onClick: () => {
      const t = [title.value.trim(), text.value.trim()].filter(Boolean).join(': ');
      if (!t) return;
      clear();
      sendMessage(`/merk-dir ${t}`);
    } }, 'Claude ordnet es ein'),
    h('button', { type: 'submit', class: 'btn' }, 'Im Eingang speichern')));
}

function notePreview() {
  const n = brain.note;
  if (!n) return h('div', { class: 'card empty', text: 'Wähle links eine Notiz.' });
  return h('article', { class: 'card note-view' },
    h('div', { class: 'section-head wrap' },
      h('h2', { text: n.rel.split('/').pop().replace(/\.md$/, '') }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: async () => { const r = await api.vaultOpen(n.rel); if (r && !r.ok) alert(r.error); } }, 'In Obsidian öffnen'),
      h('button', { class: 'btn', disabled: !ui.state.claude.found, onClick: () =>
        sendMessage(`Lies die Notiz „${n.rel}“ in meinem Obsidian-Vault und fass sie mir kurz zusammen. Was ist davon heute noch wichtig?`) }, 'Mit Claude besprechen')),
    h('div', { class: 'sub', text: n.rel }),
    h('pre', { class: 'note-text', tabindex: '0', text: n.text }),
    n.truncated ? h('div', { class: 'sub', text: 'Gekürzt – die vollständige Notiz siehst du in Obsidian.' }) : null);
}

function renderBrainBody() {
  const box = $('#brain-body');
  if (!box) return;
  if (brain.vault === null) {
    fill(box, h('div', { class: 'card empty warn', text: 'Kein Obsidian-Vault gefunden. Öffne Obsidian einmal mit deinem Vault und klick dann auf „Aktualisieren“.' }));
    return;
  }
  const list = brain.results || [];
  keepFocus(() => fill(box,
    brain.message ? h('div', { class: 'notice', role: 'status', text: brain.message }) : null,
    quickCapture(),
    brain.query && ui.state.claude.found ? h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onClick: () => sendMessage(`/was-weiss-ich ${brain.query}`) }, `Claude: Was weiß ich über „${brain.query}“?`)) : null,
    h('div', { class: 'brain-grid' },
      h('div', { class: 'card note-list', role: 'group', 'aria-label': brain.query ? 'Suchergebnisse' : 'Zuletzt geändert' },
        h('div', { class: 'label', text: brain.loading ? 'Sucht …' : brain.query ? `${list.length} Treffer` : 'Zuletzt geändert' }),
        list.length ? list.slice(0, 80).map(noteItem) : h('div', { class: 'empty', text: brain.loading ? '' : 'Nichts gefunden.' })),
      notePreview())));
}

function renderBrain() {
  const search = h('input', { type: 'search', class: 'filter', placeholder: 'Im Gehirn suchen …', 'aria-label': 'Im Gehirn suchen', 'data-focus': 'brain-search' });
  search.value = brain.query;
  search.addEventListener('input', () => {
    brain.query = search.value.trim();
    clearTimeout(brain.timer);
    brain.timer = setTimeout(loadBrain, 250); // erst suchen, wenn kurz nicht getippt wird
  });
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Gehirn' }), h('span', { class: 'spacer' }), search,
      h('button', { class: 'btn ghost', onClick: () => { brain.vault = undefined; loadBrain(); } }, 'Aktualisieren')),
    h('p', { class: 'date', id: 'brain-sub', text: brain.vault ? `Dein Obsidian-Vault „${brain.vault.name}“. Claude in der Zentrale kennt ihn und schaut dort nach, bevor er zu deinen Projekten antwortet.` : 'Dein Obsidian-Vault – Notizen, Projekte, Wissen.' }),
    h('div', { id: 'brain-body', class: 'section' }));
  renderBrainBody();
  loadBrain();
}

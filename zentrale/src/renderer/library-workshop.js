// Werkstatt in „Skills & Agenten“: Agenten anlegen, bearbeiten, mit Rollen ordnen, ihnen Aufgaben geben
// (einzeln oder als Team), Skills als Tabelle mit Bearbeiten/Löschen, neue Skills bauen und Plugins entdecken.
// Nutzt lib aus library-view.js und die Helfer aus app.js (h, fill, ui, api …).

const TOOL_CHOICES = [
  { id: 'lesen', label: 'Dateien lesen', tools: ['Read', 'Grep', 'Glob'] },
  { id: 'schreiben', label: 'Dateien ändern', tools: ['Write', 'Edit'] },
  { id: 'terminal', label: 'Terminal', tools: ['Bash'] },
  { id: 'web', label: 'Internet', tools: ['WebSearch', 'WebFetch'] },
];
const MODEL_CHOICES = [['inherit', 'wie der Chat'], ['sonnet', 'Sonnet (ausgewogen)'], ['opus', 'Opus (am stärksten)'], ['haiku', 'Haiku (schnell, günstig)']];

const ws = { editor: null, taskFor: null, focusTask: false, team: new Set(), teamOpen: false, roles: {}, roleFilter: 'all',
  market: null, marketCat: 'all', drafts: {}, open: {} };

// Halb getippte Texte überleben jedes Neuzeichnen (Filter, Schalter, Neuladen).
function draft(el, key) {
  el.value = ws.drafts[key] || '';
  el.addEventListener('input', () => { ws.drafts[key] = el.value; });
  return el;
}

// Einklappbarer Bereich, der sich merkt, ob er offen ist.
function foldable(key, summary, content) {
  const box = h('details', { class: 'builder', open: !!ws.open[key] || !!ws.drafts[key] }, h('summary', { text: summary }), content);
  box.addEventListener('toggle', () => { ws.open[key] = box.open; });
  return box;
}

// window.zentrale statt api: diese Datei läuft vor app.js.
async function loadRoles() {
  try { ws.roles = (await window.zentrale.agentRoles()) || {}; } catch { ws.roles = {}; }
}

function roleOf(a) {
  return a.id ? ws.roles[a.id] || '' : '';
}

function sendToChat(text) {
  if (!ui.state.claude.found) { alert('Claude Code wurde nicht gefunden.'); return; }
  sendMessage(text);
}

// ---------- Agent-Editor ----------

async function openAgentEditor(id) {
  // Neue Agenten dürfen zunächst nur lesen – mehr schaltest du bewusst dazu.
  if (!id) { ws.editor = { kind: 'agent', data: { name: '', description: '', model: 'inherit', tools: ['Read', 'Grep', 'Glob'], body: '', role: '' } }; renderLibraryBody(); return; }
  const res = await api.readAgent(id);
  if (!res.ok) { alert(res.error); return; }
  ws.editor = { kind: 'agent', data: { ...res.data, role: ws.roles[id] || '' } };
  renderLibraryBody();
}

function agentEditor() {
  const d = ws.editor.data;
  const val = (tag, attrs, value) => { const el = h(tag, attrs); el.value = value || ''; return el; };
  const name = val('input', { id: 'ag-name', type: 'text', placeholder: 'z. B. shop-texter' }, d.name);
  const role = val('input', { id: 'ag-role', type: 'text', list: 'ag-roles', placeholder: 'z. B. Marketing, Recherche, Trading' }, d.role);
  const desc = val('input', { id: 'ag-desc', type: 'text', placeholder: 'Wofür ist er da – und wann soll Claude ihn einsetzen?' }, d.description);
  const model = h('select', { id: 'ag-model' }, MODEL_CHOICES.map(([v, l]) => h('option', { value: v }, l)));
  model.value = d.model || 'inherit';
  const body = val('textarea', { id: 'ag-body', rows: '8', placeholder: 'Wie arbeitet der Agent? Ziel, Schritte, worauf er achtet, wie das Ergebnis aussehen soll.' }, d.body);
  if (!MODEL_CHOICES.some(([v]) => v === d.model)) { model.prepend(h('option', { value: d.model }, `${d.model} (unverändert)`)); model.value = d.model; }
  // Was getippt wird, landet sofort in ws.editor – so geht beim Neuzeichnen nichts verloren.
  for (const [el, key] of [[name, 'name'], [role, 'role'], [desc, 'description'], [body, 'body'], [model, 'model']]) {
    el.addEventListener('input', () => { d[key] = el.value; });
    el.addEventListener('change', () => { d[key] = el.value; });
  }
  const keep = d.customTools ? h('input', { type: 'checkbox', id: 'ag-keep-tools' }) : null;
  if (keep) keep.checked = d.keepTools !== false;
  const has = new Set(d.tools || []);
  const allTools = !has.size; // ohne Angabe darf er alles
  const boxes = TOOL_CHOICES.map((c) => {
    const box = h('input', { type: 'checkbox', id: `ag-tool-${c.id}` });
    box.checked = allTools || c.tools.every((t) => has.has(t));
    return { c, box };
  });
  const roles = [...new Set(Object.values(ws.roles))].sort();
  const close = () => { ws.editor = null; renderLibraryBody(); };
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    const keepTools = !!(keep && keep.checked);
    const chosen = boxes.filter((b) => b.box.checked).flatMap((b) => b.c.tools);
    const tools = chosen.length === TOOL_CHOICES.flatMap((c) => c.tools).length ? [] : chosen;
    d.tools = chosen; d.keepTools = keepTools;
    if (!keepTools && !chosen.length) { ws.editor.error = 'Wähle mindestens einen Bereich, sonst kann der Agent nichts tun.'; renderLibraryBody(); return; }
    const res = await api.saveAgent({ id: d.id, name: name.value, description: desc.value, model: model.value, tools, keepTools, body: body.value });
    if (!res.ok) { ws.editor = { ...ws.editor, data: { ...d, name: name.value, description: desc.value, model: model.value, body: body.value, role: role.value }, error: res.error }; renderLibraryBody(); return; }
    if (d.id && d.id !== res.id) await api.setAgentRole(d.id, '');
    await api.setAgentRole(res.id, role.value);
    await loadRoles();
    ws.editor = null;
    await loadLibrary(true);
  } },
  h('h2', { class: 'full', text: d.id ? `Agent „${d.name}“ bearbeiten` : 'Neuer Agent' }),
  h('div', { class: 'field' }, h('label', { for: 'ag-name', text: 'Name' }), name),
  h('div', { class: 'field' }, h('label', { for: 'ag-role', text: 'Rolle / Team' }), role,
    h('datalist', { id: 'ag-roles' }, roles.map((r) => h('option', { value: r })))),
  h('div', { class: 'field full' }, h('label', { for: 'ag-desc', text: 'Aufgabe in einem Satz' }), desc,
    h('span', { class: 'hint', text: 'Daran erkennt Claude, wann er diesen Agenten einsetzt. Gut: „Prüft Shop-Texte auf Verkaufsstärke und Rechtschreibung. Nutzen, wenn ein Produkttext fertig ist.“' })),
  h('div', { class: 'field' }, h('label', { for: 'ag-model', text: 'Modell' }), model),
  h('fieldset', { class: 'field checks-field' }, h('legend', { class: 'label', text: 'Darf …' }),
    keep ? h('label', { class: 'check', for: 'ag-keep-tools' }, keep, `Werkzeuge unverändert lassen (${d.tools.join(', ')})`) : null,
    h('div', { class: 'checks' }, boxes.map(({ c, box }) => h('label', { class: 'check', for: box.id }, box, c.label)))),
  h('div', { class: 'field full' }, h('label', { for: 'ag-body', text: 'Anweisungen' }), body),
  ws.editor.error ? h('div', { class: 'full sub warn', role: 'alert', text: ws.editor.error }) : null,
  h('div', { class: 'actions full' },
    d.id ? h('button', { type: 'button', class: 'btn danger', onClick: async () => {
      if (!confirm(`Agent „${d.name}“ in den Papierkorb legen?`)) return;
      const res = await api.trashAgent(d.id);
      if (!res.ok) { alert(res.error); return; }
      ws.editor = null; await loadRoles(); await loadLibrary(true);
    } }, 'In den Papierkorb') : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: close }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn' }, 'Speichern')));
}

// ---------- Agenten mit Claude entwerfen ----------

function agentBuilder() {
  const wish = draft(h('textarea', { id: 'ag-wish', rows: '2', placeholder: 'z. B. „Ein Agent, der jeden Montag meine Shop-Zahlen auswertet und mir drei konkrete Verbesserungen vorschlägt“' }), 'agWish');
  return foldable('agWish', '＋ Neuen Agenten anlegen', h('form', { class: 'card form compact-form', onSubmit: (e) => {
    e.preventDefault();
    const text = wish.value.trim();
    if (!text) return;
    delete ws.drafts.agWish;
    sendToChat(`Erstelle mir einen neuen Claude-Code-Subagenten: ${text}

Lege dafür eine Datei ~/.claude/agents/<kurzer-name>.md an, mit Kopfbereich (name, description – ein Satz, wann er eingesetzt wird –, optional model und tools) und klaren Anweisungen: Ziel, Arbeitsschritte, worauf er achtet, Form des Ergebnisses. Gib ihm nur die Werkzeuge, die er wirklich braucht. Schau dir vorher zwei bestehende Agenten in ~/.claude/agents als Vorbild an. Erkläre mir danach kurz, was er kann und wie ich ihm eine Aufgabe gebe.`);
  } },
  h('div', { class: 'field full' }, h('label', { for: 'ag-wish', text: 'Oder beschreib einfach, was du brauchst – Claude baut den Agenten' }), wish),
  h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: () => openAgentEditor(null) }, 'Selbst ausfüllen'),
    h('button', { type: 'submit', class: 'btn' }, 'Claude baut den Agenten'))));
}

// ---------- Aufgaben geben: einzeln oder als Team ----------

function taskBox(a) {
  const text = draft(h('textarea', { rows: '3', 'aria-label': `Aufgabe für ${a.name}`, placeholder: `Was soll „${a.name}“ tun?`, 'data-focus': `task-text:${a.name}` }), `task:${a.name}`);
  if (ws.focusTask) { ws.focusTask = false; setTimeout(() => text.focus(), 0); }
  return h('form', { class: 'task-box', onSubmit: (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t) return;
    ws.taskFor = null;
    delete ws.drafts[`task:${a.name}`];
    sendToChat(`Setze den Subagenten „${a.name}“ ein (Agent-Werkzeug, subagent_type "${a.name}") für diese Aufgabe:\n\n${t}\n\nGib mir danach sein Ergebnis kurz zusammengefasst.`);
  } }, text,
  h('div', { class: 'actions' }, h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: () => { ws.taskFor = null; renderLibraryBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn' }, 'Losschicken')));
}

function teamBox(list) {
  const members = list.filter((a) => ws.team.has(a.name));
  const text = draft(h('textarea', { rows: '3', 'aria-label': 'Aufgabe für das Team', placeholder: 'Was soll das Team gemeinsam erledigen?', 'data-focus': 'team-text' }), 'teamText');
  return h('form', { class: 'card form compact-form', onSubmit: (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t || !members.length) return;
    const names = members.map((a) => `„${a.name}“`).join(', ');
    ws.teamOpen = false; ws.team.clear(); delete ws.drafts.teamText;
    sendToChat(`Verteile diese Aufgabe auf ein Team aus Subagenten: ${names}.\n\nAufgabe: ${t}\n\nTeil die Arbeit passend zu ihren Rollen auf, lass unabhängige Teile parallel laufen (Agent-Werkzeug mit dem jeweiligen subagent_type) und fasse am Ende alle Ergebnisse in einer klaren Übersicht zusammen.`);
  } },
  h('h2', { class: 'full', text: 'Team-Auftrag' }),
  h('div', { class: 'full sub', role: 'status', text: members.length ? `Im Team: ${members.map((a) => a.name).join(', ')}` : 'Hak unten in der Liste die Agenten an, die mitarbeiten sollen.' }),
  h('div', { class: 'field full' }, text),
  h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: () => { ws.teamOpen = false; ws.team.clear(); renderLibraryBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn', disabled: !members.length }, `An ${plural(members.length, 'Agent', 'Agenten')} verteilen`)));
}

function agentRow(a) {
  const role = roleOf(a);
  const teamCheck = ws.teamOpen && a.active ? (() => {
    const box = h('input', { type: 'checkbox', 'aria-label': `${a.name} ins Team`, 'data-focus': `team:${a.name}` });
    box.checked = ws.team.has(a.name);
    box.addEventListener('change', () => { if (box.checked) ws.team.add(a.name); else ws.team.delete(a.name); renderLibraryBody(); });
    return box;
  })() : null;
  return h('div', { class: 'agent-item' },
    h('div', { class: 'row lib-row' },
      teamCheck,
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, a.name, role ? h('span', { class: 'pill blue', text: role }) : null,
          h('span', { class: 'pill', text: a.source }), a.model ? h('span', { class: 'pill', text: a.model }) : null),
        a.description ? h('div', { class: 'sub clamp', text: a.description, title: a.description }) : null),
      a.active ? h('button', { class: 'link', 'data-focus': `task:${a.name}`, 'aria-label': `${a.name} eine Aufgabe geben`,
        onClick: () => { ws.taskFor = a.name; ws.focusTask = true; renderLibraryBody(); } }, 'Aufgabe geben') : null,
      a.id ? h('button', { class: 'link', 'data-focus': `edit:${a.id}`, 'aria-label': `${a.name} bearbeiten`, onClick: () => openAgentEditor(a.id) }, 'Bearbeiten') : null,
      a.id ? h('button', { class: 'switch', role: 'switch', 'aria-checked': String(a.active), 'aria-label': a.name, 'data-focus': `agent:${a.id}`,
        title: a.active ? 'Aktiv – Claude kann ihn einsetzen' : 'Ausgeschaltet',
        onClick: async () => {
          const res = await api.toggleAgent(a.id, !a.active);
          if (res && !res.ok) alert(res.error);
          await loadLibrary(true);
        } }) : h('span', { class: 'pill green', text: 'über Plugin' })),
    ws.taskFor === a.name ? taskBox(a) : null);
}

// Ersetzt die einfache Agentenliste: Rollen-Filter, neue Agenten, Aufgaben, Team.
function renderAgentsWorkshop(list) {
  const roles = [...new Set(list.map(roleOf).filter(Boolean))].sort();
  if (ws.roleFilter !== 'all' && ws.roleFilter !== 'none' && !roles.includes(ws.roleFilter)) ws.roleFilter = 'all';
  const filtered = list.filter(libMatches)
    .filter((a) => lib.agentFilter === 'all' || (lib.agentFilter === 'on') === a.active)
    .filter((a) => ws.roleFilter === 'all' || (ws.roleFilter === 'none' ? !roleOf(a) : roleOf(a) === ws.roleFilter));
  const on = list.filter((a) => a.active).length;
  const seg = (id, label, cur, set) => h('button', { 'aria-pressed': String(cur === id), 'data-focus': `seg:${label}`, onClick: () => { set(id); renderLibraryBody(); } }, label);
  if (ws.editor && ws.editor.kind === 'agent') return [agentEditor()];
  return [
    agentBuilder(),
    ws.teamOpen ? teamBox(list) : null,
    h('div', { class: 'section-head wrap' },
      h('span', { class: 'sub', text: `${on} aktiv · ${list.length - on} ausgeschaltet` }), h('span', { class: 'spacer' }),
      ws.teamOpen ? null : h('button', { class: 'btn ghost', 'data-focus': 'team-open', onClick: () => { ws.teamOpen = true; renderLibraryBody(); } }, 'Team-Auftrag …'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Agenten filtern' },
        seg('all', 'Alle', lib.agentFilter, (v) => { lib.agentFilter = v; }), seg('on', 'Aktiv', lib.agentFilter, (v) => { lib.agentFilter = v; }),
        seg('off', 'Aus', lib.agentFilter, (v) => { lib.agentFilter = v; }))),
    roles.length ? h('div', { class: 'quick-actions', role: 'group', 'aria-label': 'Nach Rolle filtern' },
      [['all', 'Alle Rollen'], ...roles.map((r) => [r, r]), ['none', 'Ohne Rolle']].map(([id, label]) =>
        h('button', { class: `chip${ws.roleFilter === id ? ' chip-on' : ''}`, 'aria-pressed': String(ws.roleFilter === id), 'data-focus': `role:${id}`,
          onClick: () => { ws.roleFilter = id; renderLibraryBody(); } }, label))) : null,
    h('div', { class: 'card list' }, filtered.length ? filtered.map(agentRow) : h('div', { class: 'empty', text: 'Keine passenden Agenten.' })),
  ];
}

// ---------- Skills als Tabelle ----------

async function openSkillEditor(file) {
  if (!file) { ws.editor = { kind: 'skill', data: { name: '', description: '', body: '' } }; renderLibraryBody(); return; }
  const res = await api.readSkill(file);
  if (!res.ok) { alert(res.error); return; }
  ws.editor = { kind: 'skill', data: { ...res.data, file, edit: true } };
  renderLibraryBody();
}

function skillEditor() {
  const d = ws.editor.data;
  const name = h('input', { id: 'sk-name', type: 'text', placeholder: 'z. B. angebot-schreiben', disabled: !!d.edit });
  name.value = d.name;
  const desc = h('input', { id: 'sk-desc', type: 'text', placeholder: 'Was er tut und bei welchen Worten Claude ihn benutzen soll' });
  desc.value = d.description;
  const body = h('textarea', { id: 'sk-body', rows: '10', placeholder: 'Schritt für Schritt: Was Claude tun soll, worauf er achtet, ein Beispiel für das Ergebnis.' });
  body.value = d.body;
  for (const [el, key] of [[name, 'name'], [desc, 'description'], [body, 'body']]) el.addEventListener('input', () => { d[key] = el.value; });
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    const res = await api.saveSkill({ name: name.value, file: d.file, description: desc.value, body: body.value, edit: !!d.edit });
    if (!res.ok) { ws.editor = { ...ws.editor, data: { ...d, name: name.value, description: desc.value, body: body.value }, error: res.error }; renderLibraryBody(); return; }
    ws.editor = null;
    await loadLibrary(true);
  } },
  h('h2', { class: 'full', text: d.edit ? `Skill „${d.name}“ bearbeiten` : 'Neuer Skill' }),
  h('div', { class: 'field full' }, h('label', { for: 'sk-name', text: 'Name' }), name),
  h('div', { class: 'field full' }, h('label', { for: 'sk-desc', text: 'Wann benutzen?' }), desc,
    h('span', { class: 'hint', text: 'Daran erkennt Claude den Skill. Gut: „Schreibt ESA-Angebote im Firmenstil. Benutzen bei: Angebot schreiben, Kostenvoranschlag.“' })),
  h('div', { class: 'field full' }, h('label', { for: 'sk-body', text: 'Anleitung' }), body),
  ws.editor.error ? h('div', { class: 'full sub warn', role: 'alert', text: ws.editor.error }) : null,
  h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: () => { ws.editor = null; renderLibraryBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn' }, 'Speichern')));
}

function skillBuilder() {
  const wish = draft(h('textarea', { id: 'sk-wish', rows: '2', placeholder: 'z. B. „Ein Skill, der aus meinen Stichpunkten ein fertiges ESA-Angebot als Word-Datei macht“' }), 'skWish');
  return foldable('skWish', '＋ Neuen Skill bauen', h('form', { class: 'card form compact-form', onSubmit: (e) => {
    e.preventDefault();
    const text = wish.value.trim();
    if (!text) return;
    delete ws.drafts.skWish;
    sendToChat(`Baue mir einen neuen Claude-Code-Skill: ${text}

Lege ihn als ~/.claude/skills/<kurzer-name>/SKILL.md an. Der Kopfbereich braucht name und eine description, die genau sagt, was der Skill tut und bei welchen Formulierungen Claude ihn benutzen soll. Darunter eine klare Anleitung Schritt für Schritt, mit einem Beispiel für das Ergebnis. Hilfsskripte nur, wenn sie wirklich nötig sind, im selben Ordner. Schau dir vorher einen bestehenden Skill in ~/.claude/skills als Vorbild an. Erkläre mir danach, wie ich ihn benutze.`);
  } },
  h('div', { class: 'field full' }, h('label', { for: 'sk-wish', text: 'Welchen Skill willst du? Beschreib ihn – Claude baut ihn' }), wish),
  h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', onClick: () => openSkillEditor(null) }, 'Selbst schreiben'),
    h('button', { type: 'submit', class: 'btn' }, 'Claude baut den Skill'))));
}

function renderSkillsTable(list) {
  if (ws.editor && ws.editor.kind === 'skill') return [skillEditor()];
  const filtered = list.filter(libMatches);
  const own = list.filter((s) => s.own).length;
  return [
    skillBuilder(),
    h('div', { class: 'section-head' }, h('span', { class: 'sub', text: `${list.length} Skills · ${own} eigene (bearbeitbar)` })),
    h('div', { class: 'card table-wrap' }, filtered.length ? h('table', { class: 'table skills-table' },
      h('caption', { class: 'sr-only', text: 'Skills' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Skill' }), h('th', { scope: 'col', text: 'Quelle' }),
        h('th', { scope: 'col', text: 'Wofür' }), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Aktionen' })))),
      h('tbody', {}, filtered.map((s) => h('tr', {},
        h('th', { scope: 'row', class: 'name', text: s.name }),
        h('td', {}, h('span', { class: `pill ${s.own ? 'green' : ''}`, text: s.own ? 'Eigene' : s.source })),
        h('td', { class: 'desc' }, h('span', { class: 'clamp', text: s.description, title: s.description })),
        h('td', { class: 'actions-cell' },
          h('button', { class: 'link', 'aria-label': `Skill ${s.name} im Chat nutzen`, onClick: () => useInChat(`/${s.name} `) }, 'Im Chat nutzen'),
          s.own ? h('button', { class: 'link', 'aria-label': `Skill ${s.name} bearbeiten`, onClick: () => openSkillEditor(s.file) }, 'Bearbeiten') : null,
          h('button', { class: 'link', 'aria-label': `Skill ${s.name} im Finder zeigen`, onClick: () => api.fsReveal(s.file) }, 'Im Finder'),
          s.own ? h('button', { class: 'icon-btn', 'aria-label': `Skill ${s.name} löschen`, title: 'In den Papierkorb', onClick: async () => {
            if (!confirm(`Skill „${s.name}“ in den Papierkorb legen?`)) return;
            const res = await api.trashSkill(s.file);
            if (!res.ok) { alert(res.error); return; }
            await loadLibrary(true);
          } }, trashIcon()) : null))))) : h('div', { class: 'empty', text: 'Keine passenden Skills.' })),
  ];
}

// ---------- Entdecken: Plugins aus dem Marktplatz ----------

async function loadMarket() {
  try {
    const res = await api.marketplace();
    ws.market = Array.isArray(res) ? res : [];
    ws.marketError = Array.isArray(res) ? null : (res && res.error) || 'Der Marktplatz konnte nicht gelesen werden.';
  } catch (e) { ws.market = []; ws.marketError = e.message; }
  if (ui.view === 'library' && lib.tab === 'discover') renderLibraryBody();
}

function renderDiscover() {
  if (!ws.market) { loadMarket(); return h('div', { class: 'card empty', text: 'Lädt …' }); }
  const cats = [...new Set(ws.market.map((p) => p.category))].sort();
  const sel = h('select', { 'aria-label': 'Kategorie', class: 'topic-select', 'data-focus': 'market-cat' }, h('option', { value: 'all' }, 'Alle Kategorien'),
    cats.map((c) => h('option', { value: c }, c)));
  sel.value = ws.marketCat;
  sel.addEventListener('change', () => { ws.marketCat = sel.value; renderLibraryBody(); });
  const list = ws.market.filter(libMatches).filter((p) => ws.marketCat === 'all' || p.category === ws.marketCat);
  if (ws.marketError) return h('div', { class: 'card empty warn' }, ws.marketError, ' ', h('button', { class: 'link', onClick: () => { ws.market = null; renderLibraryBody(); } }, 'Erneut versuchen'));
  return [
    h('div', { class: 'section-head wrap' },
      h('span', { class: 'sub multi', text: `${ws.market.length} Plugins im Marktplatz · ${list.length > 200 ? `die ersten 200 von ${list.length} Treffern – Suche eingrenzen` : `${list.length} angezeigt`}` }), h('span', { class: 'spacer' }), sel),
    h('p', { class: 'date', text: 'Plugins bringen fertige Skills, Agenten und Verbindungen mit. „Installieren“ bittet Claude darum' + (settings().askFirst ? ' – bevor er etwas ausführt, fragt die Zentrale dich.' : '.') }),
    h('div', { class: 'card list' }, list.length ? list.slice(0, 200).map((p) => h('div', { class: 'row lib-row' },
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, p.name, h('span', { class: 'pill', text: p.category })),
        p.description ? h('div', { class: 'sub clamp', text: p.description, title: p.description }) : null),
      p.installed ? h('span', { class: 'pill green', text: 'installiert' })
        : h('button', { class: 'link', 'aria-label': `Plugin ${p.name} installieren`, onClick: () => sendToChat(`Installiere das Claude-Code-Plugin „${p.name}“ aus dem Marktplatz „${p.marketplace}“ (Befehl: claude plugin install ${p.name}@${p.marketplace}) und sag mir danach, welche Skills, Agenten oder Befehle es mitbringt.`) }, 'Installieren')))
      : h('div', { class: 'empty', text: 'Nichts gefunden.' })),
  ];
}

loadRoles();

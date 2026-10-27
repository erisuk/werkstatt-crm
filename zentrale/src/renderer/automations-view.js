// Ansicht „Automatisierungen“: dein n8n – Status, Workflows an/aus, letzte Läufe,
// Editor als Tab und „Mit Claude bauen“. Nutzt die Helfer aus app.js (h, fill, ui, api …).

const auto = { status: null, workflows: null, runs: null, error: null, filter: '', connectError: null, loading: false, wish: '', formUrl: null, formKey: '' };

const RUN_LABEL = { success: ['erfolgreich', 'green'], error: ['Fehler', 'red'], crashed: ['abgestürzt', 'red'], running: ['läuft', 'amber'],
  waiting: ['wartet', 'amber'], canceled: ['abgebrochen', ''], new: ['neu', ''] };

async function loadAutomations() {
  if (auto.loading) return;
  auto.loading = true;
  try {
    auto.status = await api.n8nStatus();
    auto.error = null;
    if (auto.status.hasKey && auto.status.running) {
      const [w, r] = await Promise.all([api.n8nWorkflows(), api.n8nExecutions()]);
      if (w.ok) auto.workflows = w.data; else auto.error = w.error;
      auto.runs = r.ok ? r.data : [];
    }
  } catch (e) {
    auto.error = e.message || 'Unbekannter Fehler';
  }
  auto.loading = false;
  if (ui.view === 'automations') renderAutomationsBody();
}

// Letzter Lauf je Workflow (die Liste von n8n ist neueste zuerst).
function lastRuns() {
  const map = new Map();
  for (const r of auto.runs || []) if (!map.has(r.workflowId)) map.set(r.workflowId, r);
  return map;
}

async function openN8nEditor(id) {
  const res = await api.n8nOpenEditor(id || null);
  if (res && res.ok === false) { alert(res.error); return; }
  setView('web');
}

function buildWithClaude(text) {
  const wish = text.trim();
  if (!wish) return;
  sendMessage(`Baue mir in meinem n8n einen Workflow: ${wish}

So gehst du vor:
1. Schau mit n8n_list_workflows nach, ob es schon etwas Ähnliches gibt, und nutze bei Bedarf n8n_get_workflow als Vorlage.
2. Lege den Workflow mit n8n_create_workflow an – ausgeschaltet und ohne Zugangsdaten.
3. Erkläre mir danach in einfachen Worten, was der Workflow tut, welche Zugangsdaten ich in n8n noch verbinden muss, und gib mir den Link zum Workflow.`);
}

function connectForm() {
  const url = h('input', { id: 'n8n-url', type: 'text', 'aria-label': 'Adresse von n8n' });
  url.value = auto.formUrl || (auto.status && auto.status.url) || 'http://localhost:5678';
  url.addEventListener('input', () => { auto.formUrl = url.value; });
  const key = h('input', { id: 'n8n-key', type: 'password', autocomplete: 'off', placeholder: 'API-Schlüssel aus n8n einfügen', 'aria-label': 'n8n-API-Schlüssel', 'data-focus': 'n8n-key' });
  // Bis zum Absenden nur im Speicher halten, damit ein Neuzeichnen das Feld nicht leert.
  key.value = auto.formKey;
  key.addEventListener('input', () => { auto.formKey = key.value; });
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    auto.connectError = null;
    const res = await api.n8nConnect(url.value, key.value);
    key.value = '';
    auto.formKey = '';
    if (!res.ok) { auto.connectError = res.error; renderAutomationsBody(); return; }
    await loadAutomations();
  } },
  h('h2', { class: 'full', text: 'n8n verbinden' }),
  h('div', { class: 'full auto-connect' },
    h('p', { class: 'sub', text: 'Am einfachsten: Melde dich einmal im n8n-Tab an und klick dann auf „Automatisch verbinden“. Die Zentrale legt den Schlüssel selbst an und speichert ihn verschlüsselt im Schlüsselbund – niemand bekommt ihn zu sehen.' }),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', 'data-focus': 'n8n-auto', onClick: async () => {
        auto.connectError = null;
        const res = await api.n8nAutoConnect(url.value);
        if (res && res.needLogin) { auto.connectError = res.error; renderAutomationsBody(); openN8nEditor(); return; }
        if (!res.ok) { auto.connectError = res.error; renderAutomationsBody(); return; }
        await loadAutomations();
      } }, 'Automatisch verbinden'),
      h('button', { type: 'button', class: 'btn ghost', 'data-focus': 'n8n-clip', onClick: async () => {
        auto.connectError = null;
        const res = await api.n8nConnectClipboard(url.value);
        if (!res.ok) { auto.connectError = res.error; renderAutomationsBody(); return; }
        await loadAutomations();
      } }, 'Aus Zwischenablage verbinden'))),
  h('p', { class: 'full sub', text: 'Oder von Hand: In n8n unter Einstellungen → n8n API einen Schlüssel erstellen und hier einfügen. Bitte nie in den Chat kopieren.' }),
  h('div', { class: 'field' }, h('label', { for: 'n8n-url', text: 'Adresse' }), url),
  h('div', { class: 'field' }, h('label', { for: 'n8n-key', text: 'API-Schlüssel' }), key),
  auto.connectError ? h('div', { class: 'full sub warn', role: 'alert', text: auto.connectError }) : null,
  h('div', { class: 'actions full' },
    h('button', { type: 'button', class: 'btn ghost', onClick: () => openN8nEditor() }, 'n8n öffnen, um den Schlüssel zu erstellen'),
    h('span', { class: 'spacer' }),
    h('button', { type: 'submit', class: 'btn' }, 'Verbinden')));
}

function builderCard() {
  const text = h('textarea', { id: 'n8n-wish', rows: '3', 'data-focus': 'n8n-wish', placeholder: 'z. B. „Jeden Morgen um 7 die Wettervorhersage für Ulm per Telegram an mich“ oder „Neue Shopify-Bestellung → Zeile in Google Sheets + Nachricht an mich“' });
  text.value = auto.wish;
  text.addEventListener('input', () => { auto.wish = text.value; });
  return h('form', { class: 'card form', onSubmit: (e) => { e.preventDefault(); const t = text.value; auto.wish = ''; buildWithClaude(t); } },
    h('h2', { class: 'full', text: 'Neue Automatisierung mit Claude bauen' }),
    h('div', { class: 'field full' }, h('label', { for: 'n8n-wish', text: 'Was soll automatisch passieren?' }), text,
      h('span', { class: 'hint', text: 'Claude baut den Workflow in deinem n8n und legt ihn ausgeschaltet an. Bevor er etwas anlegt, fragt die Zentrale dich. Zugangsdaten verbindest du danach selbst in n8n.' })),
    h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
      h('button', { type: 'submit', class: 'btn', disabled: !ui.state.claude.found }, 'Mit Claude bauen')));
}

function workflowRow(w, last) {
  const run = last ? (RUN_LABEL[last.status] || [last.status, '']) : null;
  return h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title', text: w.name, title: w.name }),
      h('div', { class: 'sub', text: [w.nodes != null ? plural(w.nodes, 'Knoten', 'Knoten') : null, w.tags.length ? w.tags.join(', ') : null,
        w.updatedAt ? `geändert ${formatWhen(Date.parse(w.updatedAt))}` : null].filter(Boolean).join(' · ') })),
    run ? h('span', { class: `pill ${run[1]}`, title: last.startedAt ? `Letzter Lauf: ${new Date(last.startedAt).toLocaleString('de-DE')}` : '', text: run[0] }) : null,
    h('button', { class: 'link', 'data-focus': `n8n-edit:${w.id}`, 'aria-label': `${w.name} in n8n öffnen`, onClick: () => openN8nEditor(w.id) }, 'In n8n öffnen'),
    h('button', { class: 'switch', role: 'switch', 'aria-checked': String(w.active), 'aria-label': w.name, 'data-focus': `n8n-active:${w.id}`,
      title: w.active ? 'Eingeschaltet – läuft automatisch' : 'Ausgeschaltet',
      onClick: async () => {
        if (!w.active && !confirm(`„${w.name}“ einschalten?\n\nDer Workflow läuft dann automatisch, sobald sein Auslöser eintritt.`)) return;
        const res = await api.n8nSetActive(w.id, !w.active);
        if (res && !res.ok) alert(res.error);
        await loadAutomations();
      } }));
}

function renderAutomationsBody() {
  const box = $('#auto-body');
  if (!box) return;
  const s = auto.status;
  if (!s) { fill(box, h('div', { class: 'card empty', text: 'Lädt …' })); return; }
  const parts = [];
  parts.push(h('div', { class: 'auto-status' },
    h('span', { class: `pill ${s.running ? 'green' : 'red'}`, text: s.running ? 'n8n läuft' : 'n8n nicht erreichbar' }),
    h('span', { class: `pill ${s.hasKey ? 'green' : ''}`, text: s.hasKey ? 'verbunden' : 'nicht verbunden' }),
    h('span', { class: 'sub', text: s.url }),
    h('span', { class: 'spacer' }),
    s.hasKey ? h('button', { class: 'link', onClick: async () => {
      if (!confirm('Verbindung zu n8n trennen? Der gespeicherte Schlüssel wird gelöscht.')) return;
      await api.n8nDisconnect(); auto.workflows = null; await loadAutomations();
    } }, 'Trennen') : null));
  if (!s.running) {
    parts.push(h('div', { class: 'notice' }, 'n8n antwortet nicht unter ', h('code', { text: s.url }),
      '. Starte n8n (z. B. im Terminal mit ', h('code', { text: 'n8n start' }), ') und klick auf „Aktualisieren“.'));
  }
  if (!s.hasKey) parts.push(connectForm());
  else {
    parts.push(builderCard());
    if (auto.error) parts.push(h('div', { class: 'card empty warn' }, auto.error, ' ', h('button', { class: 'link', onClick: loadAutomations }, 'Erneut versuchen')));
    if (auto.workflows) {
      const last = lastRuns();
      const list = auto.workflows.filter((w) => !auto.filter || `${w.name} ${w.tags.join(' ')}`.toLowerCase().includes(auto.filter))
        .sort((a, b) => (b.active - a.active) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const active = auto.workflows.filter((w) => w.active).length;
      parts.push(h('section', { class: 'section' },
        h('div', { class: 'section-head wrap' }, h('h2', { text: 'Meine Workflows' }),
          h('span', { class: 'sub', text: `${active} an · ${auto.workflows.length - active} aus` })),
        h('div', { class: 'card list' }, list.length ? list.map((w) => workflowRow(w, last.get(w.id)))
          : h('div', { class: 'empty', text: auto.workflows.length ? 'Nichts gefunden.' : 'Noch keine Workflows – lass Claude oben den ersten bauen.' }))));
    }
  }
  keepFocus(() => fill(box, parts));
}

function renderAutomations() {
  const filter = h('input', { type: 'search', class: 'filter', placeholder: 'Workflows filtern …', 'aria-label': 'Workflows filtern' });
  filter.value = auto.filter;
  filter.addEventListener('input', () => { auto.filter = filter.value.trim().toLowerCase(); renderAutomationsBody(); });
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Automatisierungen' }), h('span', { class: 'spacer' }), filter,
      h('button', { class: 'btn ghost', onClick: loadAutomations }, 'Aktualisieren'),
      h('button', { class: 'btn', onClick: () => openN8nEditor() }, 'n8n-Editor öffnen')),
    h('p', { class: 'date', text: 'Automatisierungen laufen in deinem n8n von selbst – zum Beispiel jeden Morgen oder sobald eine Mail kommt. Claude baut sie dir nach deiner Beschreibung.' }),
    h('div', { id: 'auto-body', class: 'section' }));
  renderAutomationsBody();
  loadAutomations();
}

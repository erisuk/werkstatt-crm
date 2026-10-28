// Ansicht „Lernen & Training“: Lernthemen für Claude (mit Protokoll und Nachprüfung) und tägliche
// Mini-Aufgaben aus deinen Projekten, die isoliert in Trainings-Kopien laufen. Nutzt die Helfer aus app.js.

const lern = { tab: 'themen', data: null, train: null, form: { topic: '', problem: '', example: '' }, open: null, changes: {}, busy: false, message: null };
const LERN_STATUS = { offen: ['offen', 'amber'], gelernt: ['gelernt', 'blue'], geprüft: ['sitzt', 'green'] };
const TRAIN_STATUS = { offen: ['neu', 'amber'], läuft: ['läuft', 'blue'], fertig: ['fertig', 'green'] };

async function loadLernen() {
  try {
    const [d, t] = await Promise.all([api.learnList(), api.trainList()]);
    lern.data = d; lern.train = t;
  } catch (e) { lern.message = e.message; }
  if (ui.view === 'lernen') renderLernenBody();
}

async function lernStart(id, review) {
  if (!okToLeaveBusyChat()) return;
  const r = await api.learnPrompt(id, review);
  if (!r || !r.ok) { lern.message = (r && r.error) || 'Ging nicht.'; renderLernenBody(); return; }
  sendMessage(r.prompt);
}

function lernForm() {
  const f = lern.form;
  const bind = (el, key) => { el.value = f[key]; el.addEventListener('input', () => { f[key] = el.value; }); return el; };
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    const r = await api.learnAdd({ ...f, activate: true });
    if (!r.ok) { lern.message = r.error; renderLernenBody(); return; }
    lern.form = { topic: '', problem: '', example: '' };
    lern.message = `„${r.lesson.topic}“ ist jetzt dein Lernthema für heute.`;
    await loadLernen();
  } },
  h('h2', { class: 'full', text: 'Was soll Claude lernen?' }),
  h('div', { class: 'field full' }, h('label', { for: 'ln-topic', text: 'Thema' }),
    bind(h('input', { id: 'ln-topic', type: 'text', maxlength: '120', placeholder: 'z. B. „Bei Videos immer erst anschauen, dann urteilen“', 'data-focus': 'ln-topic' }), 'topic')),
  h('div', { class: 'field full' }, h('label', { for: 'ln-problem', text: 'Was hat nicht geklappt oder dir nicht gefallen?' }),
    bind(h('textarea', { id: 'ln-problem', rows: '3', maxlength: '2000', 'data-focus': 'ln-problem' }), 'problem')),
  h('div', { class: 'field full' }, h('label', { for: 'ln-example', text: 'Beispiel (optional: Gespräch, Datei, Link)' }),
    bind(h('input', { id: 'ln-example', type: 'text', maxlength: '1000', 'data-focus': 'ln-example' }), 'example')),
  h('div', { class: 'actions full' }, h('span', { class: 'hint', text: 'Wird sofort zum Thema des Tages: Jedes Gespräch der Zentrale achtet darauf.' }), h('span', { class: 'spacer' }),
    h('button', { type: 'submit', class: 'btn', 'data-focus': 'ln-save' }, 'Als Lernthema anlegen')));
}

function lernProtocol(l) {
  const p = l.protocol;
  if (!p) return h('div', { class: 'sub', text: 'Noch kein Protokoll – starte die Lernrunde.' });
  const sec = (title, text) => text ? h('div', { class: 'ln-sec' }, h('h3', { text: title }), h('p', { text })) : null;
  return h('div', { class: 'ln-protocol' },
    sec('Was verbessert wurde', p.improved), sec('Was ich noch nicht verstehe', p.unclear), sec('Wie ich es verstehen werde', p.plan),
    sec('Was ich dafür tue', p.todo), sec('Wie ich am besten gelernt habe', p.method),
    p.reviews.length ? h('div', { class: 'sub', text: `Nachprüfungen: ${p.reviews.map((r) => `${r.day} ${r.passed ? '✓' : '✗'}`).join(' · ')}` }) : null);
}

function lernRow(l) {
  const [label, tone] = LERN_STATUS[l.status] || LERN_STATUS.offen;
  const active = lern.data.active === l.id;
  const isOpen = lern.open === l.id;
  return h('div', { class: 'row ln-row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, l.topic, h('span', { class: `pill ${tone}`, text: label }), active ? h('span', { class: 'pill blue', text: 'heute' }) : null,
        l.reviewDue ? h('span', { class: 'pill amber', text: 'Nachprüfung fällig' }) : null),
      h('div', { class: 'sub', text: [l.problem, l.nextReview && !l.reviewDue ? `nächste Prüfung ${new Date(l.nextReview).toLocaleDateString('de-DE')}` : null].filter(Boolean).join(' · ') }),
      isOpen ? lernProtocol(l) : null),
    l.status === 'offen' ? h('button', { class: 'btn', 'aria-label': `Lernrunde starten: ${l.topic}`, 'data-focus': `ln-go:${l.id}`, disabled: !ui.state.claude.found, onClick: () => lernStart(l.id, false) }, 'Lernrunde starten') : null,
    l.reviewDue ? h('button', { class: 'btn', 'aria-label': `Nachprüfen: ${l.topic}`, 'data-focus': `ln-rev:${l.id}`, disabled: !ui.state.claude.found, onClick: () => lernStart(l.id, true) }, 'Nachprüfen') : null,
    h('button', { class: 'link', 'aria-label': `${isOpen ? 'Protokoll zu' : 'Protokoll'}: ${l.topic}`, 'data-focus': `ln-open:${l.id}`, onClick: () => { lern.open = isOpen ? null : l.id; renderLernenBody(); } }, isOpen ? 'Zuklappen' : 'Protokoll'),
    h('button', { class: 'link', 'aria-label': `${active ? 'Nicht mehr heute' : 'Heute lernen'}: ${l.topic}`, 'data-focus': `ln-act:${l.id}`,
      onClick: async () => { lern.data = await api.learnActivate(active ? null : l.id); renderLernenBody(); } }, active ? 'Nicht mehr heute' : 'Heute lernen'),
    h('button', { class: 'icon-btn', 'aria-label': `${l.topic} löschen`, onClick: async () => { if (confirm(`„${l.topic}“ löschen? (Protokoll und Lektion bleiben erhalten.)`)) { lern.data = await api.learnRemove(l.id); renderLernenBody(); } } }, trashIcon()));
}

function lernThemen() {
  const d = lern.data;
  if (!d) return h('div', { class: 'card empty', text: 'Lädt …' });
  const active = d.lessons.find((l) => l.id === d.active);
  return [
    active ? h('div', { class: 'notice' }, h('strong', { text: 'Heute lerne ich: ' }), active.topic) : null,
    lernForm(),
    h('section', { class: 'section' }, h('div', { class: 'section-head wrap' }, h('h2', { text: 'Lernthemen' }), h('span', { class: 'spacer' }),
      h('button', { class: 'link', onClick: async () => { const r = await api.learnOpenLessons(); if (r && !r.ok) { lern.message = r.error; renderLernenBody(); } } }, 'Alle Lektionen öffnen')),
      h('div', { class: 'card list' }, d.lessons.length ? d.lessons.map(lernRow) : h('div', { class: 'empty', text: 'Noch keine Lernthemen. Schreib oben auf, was dir an meiner Arbeit nicht gefallen hat.' }))),
  ];
}

async function trainStart(t) {
  if (!okToLeaveBusyChat()) return;
  lern.busy = true; renderLernenBody();
  const r = await api.trainStart(t.id);
  lern.busy = false;
  if (!r || !r.ok) { lern.message = (r && r.error) || 'Ging nicht.'; renderLernenBody(); return; }
  resetChat(r.chat.gen, []);
  sendMessage(r.prompt);
}

function trainRow(t) {
  const [label, tone] = TRAIN_STATUS[t.status] || TRAIN_STATUS.offen;
  const c = lern.changes[t.id];
  return h('div', { class: 'row ln-row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, t.title, h('span', { class: `pill ${tone}`, text: label }), h('span', { class: 'pill', text: t.project })),
      h('div', { class: 'sub', text: t.why }),
      c ? h('pre', { class: 'card log-box', tabindex: '0', text: c.ok ? (c.stat || 'Noch keine Änderungen.') : c.error }) : null),
    t.status === 'offen' || t.status === 'läuft' ? h('button', { class: 'btn', 'aria-label': `${t.status === 'offen' ? 'Trainieren' : 'Weitermachen'}: ${t.title}`, 'data-focus': `tr-go:${t.id}`,
      disabled: lern.busy || !ui.state.claude.found, onClick: () => trainStart(t) }, t.status === 'offen' ? 'Trainieren' : 'Weitermachen') : null,
    t.worktree ? h('button', { class: 'link', 'aria-label': `Änderungen ansehen: ${t.title}`, 'data-focus': `tr-diff:${t.id}`, onClick: async () => { lern.changes[t.id] = await api.trainChanges(t.id); renderLernenBody(); } }, 'Änderungen') : null,
    t.worktree ? h('button', { class: 'link', 'aria-label': `Übernehmen: ${t.title}`, 'data-focus': `tr-adopt:${t.id}`, onClick: async () => {
      const r = await api.trainAdopt(t.id);
      if (r && r.cancelled) return;
      lern.message = r.ok ? `„${t.title}“ ist im Projekt ${t.project}.` : r.error;
      await loadLernen();
    } }, 'Übernehmen') : null,
    t.worktree ? h('button', { class: 'link', 'aria-label': `Im Finder: ${t.title}`, onClick: () => api.trainReveal(t.id) }, 'Im Finder') : null,
    h('button', { class: 'icon-btn', 'aria-label': `Verwerfen: ${t.title}`, title: 'Verwerfen (die Kopie wird gelöscht, dein Projekt war nie berührt)', onClick: async () => {
      if (!confirm(`„${t.title}“ verwerfen? Die Trainings-Kopie wird gelöscht – dein echtes Projekt war nie berührt.`)) return;
      await api.trainDiscard(t.id); await loadLernen();
    } }, '×'));
}

function lernTraining() {
  const t = lern.train;
  if (!t) return h('div', { class: 'card empty', text: 'Lädt …' });
  const time = h('input', { id: 'tr-time', type: 'time', value: t.settings.time, 'data-focus': 'tr-time', onChange: async (e) => { lern.train = await api.trainSettings({ time: e.target.value }); } });
  return [
    h('p', { class: 'date', text: `Jeden Tag sucht die Zentrale in deinen Git-Projekten nach kleinen Verbesserungen (TODOs, zu große Dateien, fehlende Beschreibung, Tests) und legt bis zu 3 Mini-Aufgaben an. Jede läuft in einer abgetrennten Kopie unter ${t.root.replace(/^\/Users\/[^/]+/, '~')} – dein echtes Projekt ändert sich erst, wenn du „Übernehmen“ klickst.` }),
    h('div', { class: 'card form' },
      h('label', { class: 'toggle-line' },
        h('button', { class: 'switch', role: 'switch', 'aria-checked': String(t.settings.enabled), 'aria-label': 'Täglich nach Mini-Aufgaben suchen', 'data-focus': 'tr-on',
          onClick: async () => { lern.train = await api.trainSettings({ enabled: !t.settings.enabled }); renderLernenBody(); } }), 'Täglich suchen um'),
      h('div', { class: 'field' }, h('label', { for: 'tr-time', class: 'sr-only', text: 'Uhrzeit' }), time),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn ghost', 'data-focus': 'tr-scan', disabled: lern.busy, onClick: async () => {
        lern.busy = true; renderLernenBody();
        const r = await api.trainScan();
        lern.busy = false;
        lern.train = r; lern.message = r.added ? `${r.added} neue Mini-Aufgabe(n).` : 'Nichts Neues gefunden.';
        renderLernenBody();
      } }, lern.busy ? 'Sucht …' : 'Jetzt suchen')),
    h('section', { class: 'section' }, h('h2', { text: 'Mini-Aufgaben' }),
      h('div', { class: 'card list' }, t.tasks.length ? t.tasks.map(trainRow) : h('div', { class: 'empty', text: 'Noch keine. „Jetzt suchen“ schaut sofort in deine Projekte.' }))),
  ];
}

function renderLernenBody() {
  const box = $('#ln-body');
  if (!box) return;
  keepFocus(() => fill(box, noticeEl(lern.message), lern.tab === 'themen' ? lernThemen() : lernTraining()));
}

function renderLernen() {
  lern.message = null;
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Lernen & Training' })),
    h('p', { class: 'date', text: 'Mein Bereich, um besser zu werden: Was ich nicht konnte oder was dir nicht gefallen hat, lerne ich hier – mit Protokoll, Lektion fürs Gedächtnis und Nachprüfung nach 1, 3 und 7 Tagen.' }),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Bereiche' },
      [['themen', 'Lernthemen'], ['training', 'Training']].map(([id, label]) => h('button', { 'aria-pressed': String(lern.tab === id), 'data-focus': `ln-tab:${id}`,
        onClick: () => { lern.tab = id; renderLernen(); } }, label))),
    h('div', { id: 'ln-body', class: 'section' }));
  renderLernenBody();
  loadLernen();
}

// Ansicht „Planer“: Videos für YouTube, Instagram und TikTok planen. Zur Wunschzeit kommt eine Mitteilung,
// hochgeladen wird auf Knopfdruck – Claude macht es im Web-Tab und veröffentlicht nur nach deiner Freigabe.
// Nutzt die Helfer aus app.js (h, fill, ui, api …).

const plan = { posts: null, tabs: [], form: null, message: null };
const PLAN_PLATFORM = [[/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'youtube', 'YouTube'], [/(^|\.)instagram\.com$/, 'instagram', 'Instagram'], [/(^|\.)tiktok\.com$/, 'tiktok', 'TikTok']];

function platformOf(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  const hit = PLAN_PLATFORM.find(([re]) => re.test(host));
  return hit ? { id: hit[1], name: hit[2] } : null;
}

async function loadPlanner() {
  try { const r = await api.plannerList(); plan.posts = r.posts; plan.tabs = r.tabs; } catch (e) { plan.message = e.message; }
  if (ui.view === 'planner') renderPlannerBody();
}

// datetime-local braucht Ortszeit ohne Zeitzone.
function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openPlanForm(post) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0);
  plan.form = post ? { ...post, targets: post.targets.map((t) => ({ ...t })), error: null }
    : { id: null, video: '', title: '', description: '', hashtags: '', dueAt: tomorrow.getTime(), targets: [], error: null };
  renderPlannerBody();
  setTimeout(() => { const el = document.querySelector('#main form input, #main form select, #main form textarea'); if (el) el.focus(); }, 0);
}

function planField(id, label, el, hint, full = true) {
  return h('div', { class: `field${full ? ' full' : ''}` }, h('label', { for: id, text: label }), el, hint ? h('span', { class: 'hint', text: hint }) : null);
}

function planForm() {
  const f = plan.form;
  const bind = (el, key) => { el.value = f[key] || ''; el.addEventListener('input', () => { f[key] = el.value; }); return el; };
  const title = bind(h('input', { id: 'pl-title', type: 'text', maxlength: '100', 'data-focus': 'pl-title' }), 'title');
  const desc = bind(h('textarea', { id: 'pl-desc', rows: '4', maxlength: '5000', 'data-focus': 'pl-desc' }), 'description');
  const tags = bind(h('input', { id: 'pl-tags', type: 'text', placeholder: '#ki #news', 'data-focus': 'pl-tags' }), 'hashtags');
  const when = h('input', { id: 'pl-when', type: 'datetime-local', 'data-focus': 'pl-when' });
  when.value = toLocalInput(f.dueAt);
  when.addEventListener('input', () => { const ms = new Date(when.value).getTime(); if (Number.isFinite(ms)) f.dueAt = ms; });
  const social = plan.tabs.map((t) => ({ ...t, platform: platformOf(t.url) })).filter((t) => t.platform);
  const targetBoxes = social.length ? social.map((t) => {
    const on = f.targets.some((x) => x.tabId === t.id);
    return h('label', { class: 'check-line' },
      h('input', { type: 'checkbox', checked: on, 'data-focus': `pl-t:${t.id}`, onChange: (e) => {
        f.targets = e.target.checked ? [...f.targets, { platform: t.platform.id, tabId: t.id, tabName: t.name }] : f.targets.filter((x) => x.tabId !== t.id);
      } }), `${t.name} (${t.platform.name})`);
  }) : h('span', { class: 'hint', text: 'Noch kein YouTube-, Instagram- oder TikTok-Tab. Leg ihn unter „Web“ an und melde dich dort an.' });
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    const r = await api.plannerSave(f);
    if (!r.ok) { f.error = r.error; renderPlannerBody(); return; }
    plan.form = null; plan.message = `„${r.post.title}“ ist geplant.`;
    setTimeout(() => { const b = document.querySelector('[data-focus="pl-new"]'); if (b) b.focus(); }, 0);
    await loadPlanner();
  } },
  h('h2', { class: 'full', text: f.id ? 'Beitrag bearbeiten' : 'Beitrag planen' }),
  h('div', { class: 'field full', role: 'group', 'aria-labelledby': 'pl-video-label' }, h('span', { class: 'label', id: 'pl-video-label', text: 'Video' }),
    h('div', { class: 'folder' }, h('span', { class: 'sub grow', title: f.video, text: f.video ? f.video.replace(/^\/Users\/[^/]+/, '~') : 'Noch kein Video gewählt' }),
      h('button', { type: 'button', class: 'btn ghost', 'data-focus': 'pl-video', 'aria-label': 'Video wählen', onClick: async () => { const v = await api.pickVideo(); if (v) { f.video = v; renderPlannerBody(); } } }, 'Wählen …'))),
  planField('pl-title', 'Titel', title),
  planField('pl-desc', 'Beschreibung', desc),
  planField('pl-tags', 'Hashtags', tags, 'Mit Leerzeichen getrennt, höchstens 30.'),
  planField('pl-when', 'Wann', when, 'Zu dieser Zeit kommt eine Mitteilung – hochgeladen wird erst, wenn du auf „Hochladen“ tippst.', false),
  h('div', { class: 'field' }, h('span', { class: 'label', text: 'Wo' }), h('div', { class: 'check-list' }, targetBoxes)),
  f.error ? h('div', { class: 'full sub warn', role: 'alert', text: f.error }) : null,
  h('div', { class: 'actions full' },
    h('button', { type: 'button', class: 'btn ghost', disabled: !f.video || !ui.state.claude.found, title: 'Claude schaut sich das Video an und schlägt Titel, Beschreibung und Hashtags vor',
      onClick: () => sendMessage(`Schau dir bitte mein Video ${JSON.stringify(f.video)} mit dem Skill „watch“ an und schlag mir dafür vor: einen Titel (max. 100 Zeichen), eine Beschreibung und bis zu 15 passende Hashtags – für ${f.targets.map((t) => t.tabName).join(', ') || 'YouTube, Instagram und TikTok'}. Ich trage sie dann im Planer ein.`) }, 'Texte von Claude'),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', 'data-focus': 'pl-new', onClick: () => { plan.form = null; renderPlannerBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn', 'data-focus': 'pl-new' }, 'Speichern')));
}

async function planUpload(p, t) {
  const r = await api.plannerUpload(p.id, t.tabId);
  if (!r.ok) { plan.message = r.error; renderPlannerBody(); return; }
  sendMessage(r.data);
}

function planRow(p) {
  const pill = { geplant: ['geplant', 'blue'], fällig: ['fällig', 'amber'], hochgeladen: ['hochgeladen', 'green'], übersprungen: ['übersprungen', ''] }[p.status];
  const open = p.status === 'geplant' || p.status === 'fällig';
  return h('div', { class: 'row plan-row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, p.title, h('span', { class: `pill ${pill[1]}`, text: pill[0] })),
      h('div', { class: 'sub', text: `${new Date(p.dueAt).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${p.video.split('/').pop()}` })),
    open ? p.targets.map((t) => h('button', { class: 'btn', 'aria-label': `Hochladen: ${t.tabName} – ${p.title}`, 'data-focus': `pl-up:${p.id}:${t.tabId}`, disabled: !ui.state.claude.found, onClick: () => planUpload(p, t) }, `Hochladen: ${t.tabName}`)) : null,
    open ? h('button', { class: 'link', 'aria-label': `Bearbeiten: ${p.title}`, 'data-focus': `pl-edit:${p.id}`, onClick: () => openPlanForm(p) }, 'Bearbeiten') : null,
    open ? h('button', { class: 'link', 'aria-label': `Erledigt: ${p.title}`, 'data-focus': `pl-done:${p.id}`, onClick: async () => { await api.plannerStatus(p.id, 'hochgeladen'); loadPlanner(); } }, 'Erledigt') : null,
    h('button', { class: 'icon-btn', 'aria-label': `„${p.title}“ löschen`, 'data-focus': 'pl-new', onClick: async () => { if (confirm(`„${p.title}“ aus dem Planer löschen? (Das Video bleibt.)`)) { await api.plannerRemove(p.id); loadPlanner(); } } }, trashIcon()));
}

function renderPlannerBody() {
  const box = $('#plan-body');
  if (!box) return;
  const posts = plan.posts || [];
  const open = posts.filter((p) => p.status === 'geplant' || p.status === 'fällig');
  const done = posts.filter((p) => !open.includes(p)).reverse().slice(0, 20);
  keepFocus(() => fill(box,
    noticeEl(plan.message),
    plan.form ? planForm() : h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-focus': 'pl-new', onClick: () => openPlanForm(null) }, '+ Beitrag planen')),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Geplant' })),
      h('div', { class: 'card list' }, !plan.posts ? h('div', { class: 'empty', text: 'Lädt …' })
        : open.length ? open.map(planRow) : h('div', { class: 'empty', text: 'Nichts geplant.' }))),
    done.length ? h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Erledigt' })),
      h('div', { class: 'card list' }, done.map(planRow))) : null));
}

function renderPlanner() {
  plan.message = null;
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Planer' })),
    h('p', { class: 'date', text: 'Videos für YouTube, Instagram und TikTok vorplanen. Claude lädt im angemeldeten Web-Tab hoch, prüft vorher das Konto und veröffentlicht erst nach deinem Ja.' }),
    h('div', { id: 'plan-body', class: 'section' }));
  renderPlannerBody();
  loadPlanner();
}

// Wird ein Beitrag fällig, sofort anzeigen (nicht erst beim nächsten Öffnen).
window.zentrale.onPlannerChanged(() => { if (typeof ui !== 'undefined' && ui.view === 'planner' && !plan.form) loadPlanner(); });

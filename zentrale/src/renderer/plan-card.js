// Plan-Modus wie in der Claude-App: Claude legt einen Plan vor, Eris nimmt ihn an oder schreibt, was anders soll.
// Nutzt die Helfer aus app.js (h, ui, keepFocus …) und markdown.js (mdRender).
const planDrafts = new Map(); // id → angefangener Änderungswunsch (übersteht ein Neuzeichnen)

function planCard(a, compact = false) {
  if (compact) {
    return h('div', { class: 'card approval question-card compact' },
      h('div', { class: 'approval-head' },
        h('span', { class: 'approval-icon', 'aria-hidden': 'true', text: '✎' }),
        h('div', { class: 'grow' }, h('div', { class: 'name', text: a.title }), h('div', { class: 'where', text: a.source }))),
      h('div', { class: 'approval-actions' }, h('button', { class: 'btn', onClick: () => setView('chat') }, 'Im Chat ansehen')));
  }
  const busy = { done: false };
  const wish = h('textarea', { class: 'plan-wish', rows: '2', maxlength: '4000', placeholder: 'Was soll anders werden? (optional)',
    'aria-label': 'Änderungswunsch zum Plan', 'data-focus': `plan-wish:${a.id}` });
  wish.value = planDrafts.get(a.id) || '';
  wish.addEventListener('input', () => planDrafts.set(a.id, wish.value));
  const answer = async (approve) => {
    if (busy.done) return;
    if (!approve && !wish.value.trim()) { wish.focus(); wish.placeholder = 'Schreib kurz, was anders werden soll – dann „Ändern“.'; return; }
    busy.done = true;
    try {
      const ok = await window.zentrale.answerPlan(a.id, approve, wish.value);
      if (!ok) throw new Error('Claude wartet nicht mehr auf diesen Plan.');
      planDrafts.delete(a.id);
    } catch (e) { busy.done = false; alert(`Die Antwort kam nicht an: ${e.message || e}`); }
  };
  return h('div', { class: 'card plan-card', role: 'group', 'aria-label': a.title },
    h('div', { class: 'q-top' }, h('span', { class: 'q-title', text: a.title }), h('span', { class: 'q-source', text: a.source })),
    h('div', { class: 'plan-body' }, mdRender(a.plan || '(leerer Plan)')),
    wish,
    h('div', { class: 'q-actions' },
      h('button', { class: 'btn ghost', 'data-focus': `plan-change:${a.id}`, onClick: () => answer(false) }, 'Ändern'),
      h('button', { class: 'btn', 'data-focus': `plan-ok:${a.id}`, onClick: () => answer(true) }, 'Plan annehmen')));
}

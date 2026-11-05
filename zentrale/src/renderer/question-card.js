// Auswahlfragen von Claude als Karte – wie in der Claude-App: Möglichkeiten zum Anklicken,
// darunter „Andere Antwort“ zum Selbstschreiben, unten Antworten / Überspringen.
// Tasten: 1–9 wählt in der ersten noch offenen Frage, Enter schickt ab, sobald alles beantwortet ist.

// Auswahl je Frage-Karte, damit sie ein Neuzeichnen übersteht: id → [{ labels: [...], other: '' }]
const questionPicks = new Map();

function picksFor(a) {
  if (!questionPicks.has(a.id)) questionPicks.set(a.id, a.questions.map(() => ({ labels: [], other: '' })));
  return questionPicks.get(a.id);
}

const pickDone = (p) => p.labels.length > 0 || p.other.trim() !== '';

function questionComplete(a) {
  return picksFor(a).every(pickDone);
}

// Neue Auswahl als neues Objekt – die alte bleibt unverändert.
function choose(a, qi, label) {
  const q = a.questions[qi];
  const picks = picksFor(a);
  const p = picks[qi];
  const has = p.labels.includes(label);
  const labels = q.multiSelect ? (has ? p.labels.filter((l) => l !== label) : [...p.labels, label]) : (has ? [] : [label]);
  questionPicks.set(a.id, picks.map((x, i) => (i === qi ? { labels, other: q.multiSelect ? p.other : '' } : x)));
}

function setOther(a, qi, text) {
  const q = a.questions[qi];
  questionPicks.set(a.id, picksFor(a).map((x, i) => (i === qi ? { labels: q.multiSelect ? x.labels : [], other: text } : x)));
}

async function sendAnswer(a, card) {
  if (card.dataset.sending || !questionComplete(a)) return;
  card.dataset.sending = '1';
  try {
    const ok = await window.zentrale.answerQuestion(a.id, picksFor(a));
    if (!ok) throw new Error('Claude wartet nicht mehr auf diese Antwort.');
    questionPicks.delete(a.id);
  } catch (e) {
    delete card.dataset.sending;
    alert(`Die Antwort kam nicht an: ${e.message || e}`);
  }
}

async function skipQuestion(a, card) {
  if (card.dataset.sending) return;
  card.dataset.sending = '1';
  try {
    await window.zentrale.respondApproval(a.id, 'deny');
    questionPicks.delete(a.id);
  } catch (e) {
    delete card.dataset.sending;
    alert(`Die Antwort kam nicht an: ${e.message || e}`);
  }
}

// Karte neu zeichnen, ohne den Rest der Seite anzufassen (Fokus bleibt, wo er war).
function redrawQuestion(a, card) {
  keepFocus(() => card.replaceWith(questionCard(a)));
}

function optionRow(a, qi, o, oi) {
  const q = a.questions[qi];
  const on = picksFor(a)[qi].labels.includes(o.label);
  return h('button', { type: 'button', class: `q-option${on ? ' on' : ''}`, role: q.multiSelect ? 'checkbox' : 'radio',
    'aria-checked': on ? 'true' : 'false', 'data-focus': `q:${a.id}:${qi}:${oi}`,
    onClick: (e) => { choose(a, qi, o.label); redrawQuestion(a, e.currentTarget.closest('.question-card')); } },
  h('span', { class: 'q-key', 'aria-hidden': 'true', text: q.multiSelect ? (on ? '✓' : '') : String(oi + 1) }),
  h('span', { class: 'q-text' },
    h('span', { class: 'q-label', text: o.label }),
    o.description ? h('span', { class: 'q-desc', text: o.description }) : null));
}

function otherField(a, qi) {
  const p = picksFor(a)[qi];
  const input = h('input', { type: 'text', class: `q-other${p.other.trim() ? ' on' : ''}`, maxlength: '2000',
    placeholder: 'Andere Antwort …', 'aria-label': 'Andere Antwort', 'data-focus': `q-other:${a.id}:${qi}`,
    onInput: (e) => {
      const card = e.currentTarget.closest('.question-card');
      const hadLabels = picksFor(a)[qi].labels.length > 0 && !a.questions[qi].multiSelect;
      setOther(a, qi, e.currentTarget.value);
      // Bei Einzelauswahl ersetzt der eigene Text die angeklickte Möglichkeit – Knöpfe dann neu zeichnen.
      if (hadLabels) redrawQuestion(a, card);
      else { e.currentTarget.classList.toggle('on', !!e.currentTarget.value.trim()); updateSend(a, card); }
    },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendAnswer(a, e.currentTarget.closest('.question-card')); }
    } });
  input.value = p.other;
  return input;
}

function updateSend(a, card) {
  const btn = card.querySelector('.q-send');
  if (btn) btn.disabled = !questionComplete(a);
}

function questionCard(a, compact = false) {
  const many = a.questions.length > 1;
  if (compact) {
    return h('div', { class: 'card approval question-card compact' },
      h('div', { class: 'approval-head' },
        h('span', { class: 'approval-icon', 'aria-hidden': 'true', text: '?' }),
        h('div', { class: 'grow' },
          h('div', { class: 'name', text: a.questions[0].question }),
          h('div', { class: 'where', text: a.source }))),
      h('div', { class: 'approval-actions' },
        h('button', { class: 'btn', onClick: () => setView('chat') }, 'Im Chat beantworten')));
  }
  const card = h('div', { class: 'card question-card', role: 'group', 'aria-label': a.title, 'data-qid': a.id },
    h('div', { class: 'q-top' },
      h('span', { class: 'q-title', text: a.title }),
      h('span', { class: 'q-source', text: a.source })),
    a.questions.map((q, qi) => h('section', { class: 'q-block' },
      h('div', { class: 'q-head' },
        q.header ? h('span', { class: 'q-chip', text: q.header }) : null,
        many ? h('span', { class: 'q-count', text: `${qi + 1} von ${a.questions.length}` }) : null,
        q.multiSelect ? h('span', { class: 'q-hint', text: 'Mehrere möglich' }) : null),
      h('div', { class: 'q-question', text: q.question }),
      h('div', { class: 'q-options', role: q.multiSelect ? 'group' : 'radiogroup', 'aria-label': q.question },
        q.options.map((o, oi) => optionRow(a, qi, o, oi)),
        otherField(a, qi)))),
    h('div', { class: 'q-actions' },
      h('button', { class: 'btn ghost', 'data-focus': `q-skip:${a.id}`, onClick: (e) => skipQuestion(a, e.currentTarget.closest('.question-card')) }, 'Überspringen'),
      h('button', { class: 'btn q-send', 'data-focus': `q-send:${a.id}`, disabled: !questionComplete(a),
        onClick: (e) => sendAnswer(a, e.currentTarget.closest('.question-card')) }, many ? 'Antworten senden' : 'Antworten')));
  return card;
}

// Zahlentasten und Enter, solange eine Frage-Karte im Chat steht und kein Textfeld den Fokus hat.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const card = document.querySelector('#chat-approvals .question-card[data-qid]');
  if (!card) return;
  const a = ((ui.state && ui.state.approvals) || []).find((x) => x.id === card.dataset.qid);
  if (!a) return;
  if (e.key === 'Enter' && questionComplete(a) && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); sendAnswer(a, card); return; }
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1) return;
  const qi = picksFor(a).findIndex((p) => !pickDone(p));
  const q = a.questions[qi < 0 ? a.questions.length - 1 : qi];
  if (!q || n > q.options.length) return;
  e.preventDefault();
  choose(a, a.questions.indexOf(q), q.options[n - 1].label);
  redrawQuestion(a, card);
});

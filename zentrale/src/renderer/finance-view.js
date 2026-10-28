// Ansicht „Privat“: Finanzen nur für dich. Öffnet mit Touch ID, sperrt sich nach 5 Minuten und beim Verlassen.
// Die Daten liegen nur im Speicher dieser Ansicht, solange sie offen ist – Claude bekommt davon nichts.
// Nutzt die Helfer aus app.js (h, fill, ui, api …).

const fin = { open: false, data: null, sum: null, form: null, message: null, busy: false };

const FIN_KINDS = { giro: 'Girokonto', spar: 'Sparkonto', kredit: 'Kreditkarte', debit: 'Bankkarte', bar: 'Bargeld', depot: 'Depot', paypal: 'PayPal', sonst: 'Sonstiges' };
const FIN_INTERVALS = { woche: 'wöchentlich', monat: 'monatlich', quartal: 'vierteljährlich', halbjahr: 'halbjährlich', jahr: 'jährlich' };
const FIN_CATEGORIES = ['Wohnen', 'Strom & Internet', 'Handy', 'Versicherung', 'Auto & Mobilität', 'Abos & Software', 'KI & Werkzeuge',
  'Lebensmittel', 'Gesundheit', 'Kredit', 'Sparen', 'Firma', 'Freizeit', 'Sonstiges'];
const eur = (n) => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const dayDe = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '–');

// Formulare je Art: [Feld, Beschriftung, Typ, Optionen]
const FIN_FORMS = {
  accounts: { title: 'Konto oder Karte', fields: [['name', 'Name', 'text', { placeholder: 'z. B. Sparkasse Giro' }], ['bank', 'Bank', 'text'],
    ['kind', 'Art', 'select', FIN_KINDS], ['last4', 'Endet auf (4 Ziffern)', 'text', { placeholder: '1234', maxlength: '4', inputmode: 'numeric' }],
    ['balance', 'Kontostand (minus = Schulden)', 'text', { placeholder: '1.250,00', inputmode: 'decimal' }], ['limit', 'Kreditrahmen (optional)', 'text', { inputmode: 'decimal' }], ['note', 'Notiz', 'text']] },
  fixed: { title: 'Feste Kosten', fields: [['name', 'Wofür', 'text', { placeholder: 'z. B. Miete, Handy, Claude' }], ['amount', 'Betrag', 'text', { inputmode: 'decimal' }],
    ['interval', 'Wie oft', 'select', FIN_INTERVALS], ['category', 'Kategorie', 'select', Object.fromEntries(FIN_CATEGORIES.map((c) => [c, c]))],
    ['account', 'Von welchem Konto', 'account'], ['next', 'Nächste Abbuchung', 'date'], ['cancelBy', 'Kündigen bis (optional)', 'date'], ['note', 'Notiz', 'text']] },
  bills: { title: 'Rechnung', fields: [['name', 'Wofür', 'text'], ['amount', 'Betrag', 'text', { inputmode: 'decimal' }], ['due', 'Fällig am', 'date'],
    ['category', 'Kategorie', 'select', Object.fromEntries(FIN_CATEGORIES.map((c) => [c, c]))], ['paid', 'Schon bezahlt', 'check'], ['note', 'Notiz', 'text']] },
  incomes: { title: 'Einnahme', fields: [['name', 'Woher', 'text', { placeholder: 'z. B. Minijob ESA, Shop, YouTube' }], ['amount', 'Betrag', 'text', { inputmode: 'decimal' }],
    ['interval', 'Wie oft', 'select', { einmal: 'einmalig', ...FIN_INTERVALS }], ['date', 'Datum', 'date'], ['account', 'Auf welches Konto', 'account'], ['note', 'Notiz', 'text']] },
};

function finApply(r) {
  if (!r) return;
  if (r.locked) { finClear(); return; }
  if (!r.ok) { fin.message = r.error; return; }
  fin.data = r.data; fin.sum = r.summary;
}

function finClear(reason) {
  fin.open = false; fin.data = null; fin.sum = null; fin.form = null; fin.message = reason || null;
  if (ui.view === 'finance') renderFinance();
}

async function finUnlock() {
  const r = await api.finUnlock();
  if (r && r.cancelled) return;
  if (!r || !r.ok) { fin.message = (r && r.error) || 'Öffnen ging nicht.'; renderFinance(); return; }
  fin.open = true; fin.message = null;
  finApply(r);
  renderFinance();
  const head = $('#main h1');
  if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
  announce('Privater Bereich geöffnet.');
}

// Läuft vor app.js – deshalb window.zentrale statt api.
window.zentrale.onFinLocked(() => { if (fin.open) finClear('Gesperrt.'); });

function finInput(f, [key, , type, opt]) {
  const id = `fin-${key}`;
  if (type === 'select') {
    const el = h('select', { id, 'data-focus': id }, Object.entries(opt).map(([v, t]) => h('option', { value: v }, t)));
    // Vorgabe: monatlich bzw. Girokonto/Sonstiges, sonst der erste Eintrag.
    const fallback = ['monat', 'giro', 'Sonstiges'].find((v) => v in opt) || Object.keys(opt)[0];
    el.value = f[key] || fallback; f[key] = el.value;
    el.addEventListener('change', () => { f[key] = el.value; });
    return el;
  }
  if (type === 'account') {
    const el = h('select', { id, 'data-focus': id }, h('option', { value: '' }, '–'), fin.data.accounts.map((a) => h('option', { value: a.id }, a.name)));
    el.value = f[key] || '';
    el.addEventListener('change', () => { f[key] = el.value; });
    return el;
  }
  if (type === 'check') {
    const el = h('input', { id, type: 'checkbox', checked: !!f[key], 'data-focus': id });
    el.addEventListener('change', () => { f[key] = el.checked; });
    return el;
  }
  const el = h('input', { id, type: type === 'date' ? 'date' : 'text', autocomplete: 'off', spellcheck: 'false', 'data-focus': id, ...(opt || {}) });
  // Beträge deutsch anzeigen (1250,50); Texte und Daten unverändert.
  el.value = f[key] == null ? '' : typeof f[key] === 'number' ? f[key].toFixed(2).replace('.', ',') : String(f[key]);
  el.addEventListener('input', () => { f[key] = el.value; });
  return el;
}

function finFormCard() {
  const f = fin.form;
  const spec = FIN_FORMS[f.formKind];
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    if (fin.busy) return;
    fin.busy = true;
    // formKind = welche Liste; „kind“ ist bei Konten ein eigenes Feld (Girokonto, Kreditkarte …).
    const { formKind, error, ...item } = f;
    const r = await api.finSave(formKind, item);
    fin.busy = false;
    if (r && !r.ok && !r.locked) { f.error = r.error; renderFinanceBody(); return; }
    fin.form = null;
    finApply(r);
    renderFinanceBody();
  } },
  h('h2', { class: 'full', text: `${f.id ? '' : 'Neu: '}${spec.title}` }),
  spec.fields.map((fd) => h('div', { class: `field${fd[2] === 'text' && fd[0] === 'note' ? ' full' : ''}` }, h('label', { for: `fin-${fd[0]}`, text: fd[1] }), finInput(f, fd))),
  f.error ? h('div', { class: 'full sub warn', role: 'alert', text: f.error }) : null,
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: 'Nur die letzten 4 Ziffern von Karten oder Konten – volle Nummern, PIN oder Prüfziffer gehören hier nie hinein.' }),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn ghost', 'data-focus': `fin-add:${f.formKind}`, onClick: () => { fin.form = null; renderFinanceBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn' }, 'Speichern')));
}

function finFocusForm() {
  setTimeout(() => { const el = document.querySelector('#fin-body form input, #fin-body form select'); if (el) el.focus(); }, 0);
}

function finTile(label, value, sub, tone) {
  return h('div', { class: `card fin-tile${tone ? ` ${tone}` : ''}` }, h('span', { class: 'label', text: label }), h('span', { class: 'value', text: value }), sub ? h('span', { class: 'sub', text: sub }) : null);
}

// Waagrechte Balken, eine Reihe (eine Farbe, Werte als Text daneben).
function finBars(list, label) {
  const max = Math.max(...list.map((x) => x.amount), 1);
  return h('ul', { class: 'fin-bars', 'aria-label': label }, list.map((x) => h('li', { title: `${x.name}: ${eur(x.amount)}` },
    h('span', { class: 'name', text: x.name }),
    h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'bar', style: { width: `${Math.max(2, (x.amount / max) * 100)}%` } })),
    h('span', { class: 'amount', text: eur(x.amount) }))));
}

// Rein/raus je Monat aus den importierten Kontoauszügen.
function finFlowChart(months) {
  const max = Math.max(...months.flatMap((m) => [m.in, m.out]), 1);
  return h('div', { class: 'fin-flow' },
    h('div', { class: 'fin-legend' }, h('span', { class: 'key in', text: 'rein' }), h('span', { class: 'key out', text: 'raus' })),
    h('div', { class: 'fin-cols', role: 'list', tabindex: '0', 'aria-label': 'Geld rein und raus je Monat' }, months.map((m) => {
      const label = new Date(`${m.month}-15`).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' });
      return h('div', { class: 'col', role: 'listitem', title: `${label}: rein ${eur(m.in)} · raus ${eur(m.out)} · ${eur(m.in - m.out)}` },
        h('span', { class: 'sr-only', text: `${label}: rein ${eur(m.in)}, raus ${eur(m.out)}, Saldo ${eur(m.in - m.out)}` }),
        h('div', { class: 'pair', 'aria-hidden': 'true' },
          h('span', { class: 'in', style: { height: `${(m.in / max) * 100}%` } }), h('span', { class: 'out', style: { height: `${(m.out / max) * 100}%` } })),
        h('span', { class: 'm', 'aria-hidden': 'true', text: label }),
        h('span', { class: 'net', 'aria-hidden': 'true', text: `${m.in - m.out >= 0 ? '+' : '−'}${Math.abs(Math.round(m.in - m.out)).toLocaleString('de-DE')}` }));
    })));
}

function finList(kind, rows, render, empty) {
  return h('div', { class: 'card list' }, rows.length ? rows.map((x) => h('div', { class: 'row' }, render(x),
    h('button', { class: 'link', 'aria-label': `Bearbeiten: ${x.name}`, 'data-focus': `fin-edit:${x.id}`, onClick: () => { fin.form = { ...x, formKind: kind, error: null }; renderFinanceBody(); finFocusForm(); } }, 'Bearbeiten'),
    h('button', { class: 'icon-btn', 'aria-label': `${x.name} löschen`, 'data-focus': `fin-add:${kind}`, onClick: async () => { if (confirm(`„${x.name}“ löschen?`)) { finApply(await api.finRemove(kind, x.id)); renderFinanceBody(); } } }, trashIcon())))
    : h('div', { class: 'empty', text: empty }));
}

function finSection(title, kind, body, extra) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head wrap' }, h('h2', { text: title }), h('span', { class: 'spacer' }), extra || null,
      kind ? h('button', { class: 'btn ghost', 'data-focus': `fin-add:${kind}`, 'aria-label': `Hinzufügen: ${title}`, onClick: () => { fin.form = { formKind: kind, error: null }; renderFinanceBody(); finFocusForm(); } }, '+ Hinzufügen') : null),
    body);
}

function renderFinanceBody() {
  const box = $('#fin-body');
  if (!box || !fin.data) return;
  const d = fin.data; const s = fin.sum;
  const accName = (id) => (d.accounts.find((a) => a.id === id) || {}).name || '';
  keepFocus(() => fill(box,
    noticeEl(fin.message),
    fin.form ? finFormCard() : null,
    h('div', { class: 'fin-tiles' },
      finTile('Vermögen (alle Konten)', eur(s.netWorth), s.debt ? `davon ${eur(s.debt)} Schulden` : plural(d.accounts.length, 'Konto', 'Konten'), s.netWorth < 0 ? 'neg' : ''),
      finTile('Einnahmen im Monat', eur(s.incomeMonth), 'regelmäßige'),
      finTile('Feste Kosten im Monat', eur(s.fixedMonth), plural(d.fixed.length, 'Posten', 'Posten')),
      finTile('Bleibt im Monat', eur(s.freeMonth), 'Einnahmen minus feste Kosten', s.freeMonth < 0 ? 'neg' : 'pos'),
      finTile('Offene Rechnungen', eur(s.openBills), `${d.bills.filter((b) => !b.paid).length} offen`, s.openBills ? 'due' : '')),
    s.upcoming.length || s.cancelSoon.length ? finSection('Die nächsten 30 Tage', null, h('div', { class: 'card list' },
      s.cancelSoon.map((f) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title', text: `Kündigen bis ${dayDe(f.cancelBy)}: ${f.name}` }), h('div', { class: 'sub', text: `${eur(f.amount)} ${FIN_INTERVALS[f.interval]}` })), h('span', { class: 'pill amber', text: 'Frist' }))),
      s.upcoming.map((u) => h('div', { class: 'row' }, h('span', { class: 'when', text: dayDe(u.date) }), h('div', { class: 'grow' }, h('div', { class: 'title', text: u.name }), h('div', { class: 'sub', text: u.type === 'Fest' ? 'feste Abbuchung' : 'Rechnung' })),
        u.overdue ? h('span', { class: 'pill red', text: 'überfällig' }) : null, h('span', { class: 'amount', text: eur(u.amount) }))))) : null,
    s.byCategory.length ? finSection('Wofür das Geld jeden Monat geht', null, h('div', { class: 'card' }, finBars(s.byCategory, 'Feste Kosten je Kategorie im Monat'))) : null,
    finSection('Geldfluss aus den Kontoauszügen', null, s.flow.months.length ? h('div', { class: 'card fin-flow-card' }, finFlowChart(s.flow.months),
      h('div', { class: 'fin-two' },
        h('div', {}, h('h3', { text: 'Woher Geld kam' }), finBars(s.flow.inFrom, 'Größte Einnahmequellen')),
        h('div', {}, h('h3', { text: 'Wohin Geld ging' }), finBars(s.flow.outTo, 'Ausgaben je Kategorie'))))
      : h('div', { class: 'card empty', text: 'Lade einen Kontoauszug als CSV aus deinem Online-Banking – die Zentrale liest ihn nur hier auf dem Mac und ordnet die Buchungen zu.' }),
    h('span', { class: 'toggle-line' },
      h('button', { class: 'btn', 'data-focus': 'fin-import', onClick: async () => {
        const r = await api.finImport('');
        if (r && r.cancelled) return;
        finApply(r);
        if (r && r.ok) fin.message = `${r.imported} Buchungen übernommen${r.duplicates ? `, ${r.duplicates} schon vorhanden` : ''}${r.unreadable ? `, ${r.unreadable} Zeilen nicht lesbar` : ''}.`;
        renderFinanceBody();
      } }, 'Kontoauszug laden (CSV)'),
      d.moves.length ? h('button', { class: 'link', onClick: async () => { if (confirm('Alle importierten Buchungen löschen? Konten, Kosten und Rechnungen bleiben.')) { finApply(await api.finClearMoves()); renderFinanceBody(); } } }, 'Buchungen löschen') : null)),
    finSection('Konten & Karten', 'accounts', finList('accounts', d.accounts, (a) => h('div', { class: 'grow' },
      h('div', { class: 'title' }, a.name, h('span', { class: 'pill', text: FIN_KINDS[a.kind] })),
      h('div', { class: 'sub', text: [a.bank, a.last4 ? `•••• ${a.last4}` : null, a.limit ? `Rahmen ${eur(a.limit)}` : null, `Stand ${new Date(a.updatedAt).toLocaleDateString('de-DE')}`].filter(Boolean).join(' · ') }),
    ), 'Noch keine Konten. Trag Konten und Karten mit Stand ein – nur die letzten 4 Ziffern.')),
    finSection('Feste Kosten (Abos, Verträge, Miete)', 'fixed', finList('fixed', d.fixed, (f) => h('div', { class: 'grow' },
      h('div', { class: 'title' }, f.name, h('span', { class: 'pill', text: f.category })),
      h('div', { class: 'sub', text: [`${eur(f.amount)} ${FIN_INTERVALS[f.interval]}`, accName(f.account), f.next ? `nächste ${dayDe(f.next)}` : null, f.cancelBy ? `kündbar bis ${dayDe(f.cancelBy)}` : null].filter(Boolean).join(' · ') })), 'Noch keine festen Kosten.')),
    finSection('Rechnungen', 'bills', finList('bills', [...d.bills].sort((a, b) => Number(a.paid) - Number(b.paid) || String(a.due).localeCompare(String(b.due))), (b) => h('div', { class: 'grow' },
      h('div', { class: 'title' }, b.name, h('span', { class: `pill ${b.paid ? 'green' : 'amber'}`, text: b.paid ? 'bezahlt' : 'offen' })),
      h('div', { class: 'sub', text: `${eur(b.amount)} · fällig ${dayDe(b.due)}` })), 'Keine Rechnungen eingetragen.')),
    finSection('Einnahmen', 'incomes', finList('incomes', d.incomes, (i) => h('div', { class: 'grow' },
      h('div', { class: 'title', text: i.name }),
      h('div', { class: 'sub', text: [`${eur(i.amount)} ${i.interval === 'einmal' ? `am ${dayDe(i.date)}` : FIN_INTERVALS[i.interval]}`, accName(i.account)].filter(Boolean).join(' · ') })), 'Noch keine Einnahmen.'))));
}

function renderFinance() {
  const main = $('#main');
  if (!fin.open) {
    fill(main, h('div', { class: 'card fin-lock' },
      h('div', { class: 'lock-icon', 'aria-hidden': 'true', text: '🔒' }),
      h('h1', { text: 'Privat' }),
      h('p', { text: 'Deine Finanzen: Konten, Karten, feste Kosten, Rechnungen und Einnahmen. Nur auf diesem Mac gespeichert und verschlüsselt. Claude, seine Werkzeuge und das Internet haben keinen Zugriff, und Zahlungen gehen hier nicht.' }),
      fin.message ? h('p', { class: 'sub warn', role: 'alert', text: fin.message }) : null,
      h('button', { class: 'btn', 'data-focus': 'fin-unlock', onClick: finUnlock }, 'Mit Touch ID öffnen')));
    return;
  }
  fill(main,
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Privat · Finanzen' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', 'data-focus': 'fin-lock', onClick: () => api.finLock() }, 'Sperren')),
    h('p', { class: 'date', text: 'Sperrt sich nach 5 Minuten ohne Nutzung, beim Verlassen der Seite und wenn der Mac gesperrt wird. Bildschirmfotos zeigen diesen Bereich nicht.' }),
    h('div', { id: 'fin-body', class: 'section' }));
  renderFinanceBody();
}

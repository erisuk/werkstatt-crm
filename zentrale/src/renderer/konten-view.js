// Ansicht „Konten“: alle Anmeldungen mit E-Mail bzw. Konto – Claude, Konnektoren, Web-Tabs, Dienste, eigene.
// Dazu der Abschnitt „Anmeldungen“ in der Info-Leiste jedes Chats. Nie Passwörter, nur Namen und Adressen.
// Nutzt die Helfer aus app.js (h, fill, ui, api …).
const KONTEN_MS = 60 * 1000;
const KONTEN_GROUPS = ['Claude', 'Konnektoren', 'Dienste', 'Web-Tabs', 'Selbst eingetragen'];
const KONTEN_STAND = {
  angemeldet: ['angemeldet', 'green'], anmelden: ['Anmeldung nötig', 'amber'], fehler: ['Fehler', 'red'],
  aus: ['aus', ''], unbekannt: ['Konto unbekannt', ''], eingetragen: ['eingetragen', 'blue'],
};
const kv = { filter: 'alle', message: null };

function loadKonten(force) {
  if (ui.kontenLoading || (!force && ui.konten && Date.now() - ui.kontenAt < KONTEN_MS)) return;
  ui.kontenLoading = true;
  window.zentrale.konten().then((list) => {
    ui.konten = Array.isArray(list) ? list : [];
    ui.kontenAt = Date.now();
  }).catch(() => {}).finally(() => {
    ui.kontenLoading = false;
    if (ui.view === 'konten') renderKontenBody();
    if (typeof renderChatInfo === 'function') renderChatInfo();
  });
}

function kontenApply(res) {
  if (!res || !res.ok) { kv.message = (res && res.error) || 'Ging nicht.'; renderKontenBody(); return; }
  ui.konten = res.konten;
  ui.kontenAt = Date.now();
  kv.message = null;
  renderKontenBody();
}

// Konto zu einem erkannten Eintrag selbst eintragen (z. B. welche Gmail-Adresse im Gmail-Konnektor steckt).
function kontoFeld(k) {
  if (k.auto || k.eigen || !/^(mcp|tab):|^n8n$/.test(k.key)) return h('span', { class: 'konto-wert', text: k.konto || '–' });
  const input = h('input', { class: 'konto-input', value: k.konto || '', maxlength: '200', placeholder: 'E-Mail oder Benutzername eintragen',
    'aria-label': `Konto für ${k.dienst}`, 'data-focus': `konto:${k.key}`, autocomplete: 'off', spellcheck: 'false' });
  const save = async () => {
    if (input.value.trim() === (k.konto || '')) return;
    kontenApply(await window.zentrale.kontenZuordnen(k.key, input.value));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); input.blur(); } });
  input.addEventListener('blur', save);
  return input;
}

function kontoZeile(k) {
  const [label, pill] = KONTEN_STAND[k.stand] || [k.stand, ''];
  return h('div', { class: 'row konto-row' },
    h('div', { class: 'grow' },
      h('div', { class: 'title', text: k.dienst }),
      k.wo ? h('div', { class: 'sub', text: k.wo }) : null),
    kontoFeld(k),
    h('span', { class: `pill ${pill}`, text: label }),
    k.eigen ? h('button', { class: 'icon-btn', 'aria-label': `${k.dienst} entfernen`, 'data-focus': `konto-weg:${k.id}`,
      onClick: async () => { if (confirm(`„${k.dienst}“ aus deiner Liste entfernen?`)) kontenApply(await window.zentrale.kontenEigen({ remove: k.id })); } }, '×') : null);
}

function kontoNeu() {
  const dienst = h('input', { class: 'konto-input', placeholder: 'Dienst, z. B. ElevenLabs', maxlength: '200', 'aria-label': 'Dienst', 'data-focus': 'konto-neu-dienst' });
  const konto = h('input', { class: 'konto-input', placeholder: 'E-Mail oder Benutzername', maxlength: '200', 'aria-label': 'Konto', 'data-focus': 'konto-neu-konto' });
  const notiz = h('input', { class: 'konto-input', placeholder: 'Notiz (optional), kein Passwort', maxlength: '200', 'aria-label': 'Notiz', 'data-focus': 'konto-neu-notiz' });
  const add = async () => {
    kontenApply(await window.zentrale.kontenEigen({ dienst: dienst.value, konto: konto.value, notiz: notiz.value }));
  };
  return h('div', { class: 'card konto-neu' },
    h('div', { class: 'title', text: 'Konto selbst eintragen' }),
    h('div', { class: 'konto-neu-felder' }, dienst, konto, notiz,
      h('button', { class: 'btn', 'data-focus': 'konto-neu-add', onClick: add }, 'Hinzufügen')));
}

function renderKontenBody() {
  const box = $('#konten-body');
  if (!box) return;
  const list = ui.konten;
  if (!list) { fill(box, h('div', { class: 'card empty', text: 'Lädt …' })); return; }
  const shown = kv.filter === 'offen' ? list.filter((k) => k.stand === 'anmelden' || k.stand === 'unbekannt' || k.stand === 'fehler') : list;
  const groups = KONTEN_GROUPS.map((g) => [g, shown.filter((k) => k.gruppe === g)]).filter(([, l]) => l.length);
  const offen = list.filter((k) => k.stand === 'anmelden').length;
  keepFocus(() => fill(box,
    kv.message ? h('div', { class: 'card notice', text: kv.message }) : null,
    h('div', { class: 'konten-head' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter' },
        [['alle', `Alle (${list.length})`], ['offen', `Fehlt / unbekannt (${list.filter((k) => ['anmelden', 'unbekannt', 'fehler'].includes(k.stand)).length})`]]
          .map(([id, label]) => h('button', { 'aria-pressed': String(kv.filter === id), 'data-focus': `konten-filter:${id}`, onClick: () => { kv.filter = id; renderKontenBody(); } }, label))),
      offen ? h('span', { class: 'pill amber', text: `${offen} Anmeldung${offen === 1 ? '' : 'en'} nötig` }) : null),
    ...groups.map(([g, l]) => h('section', { class: 'konten-group' },
      h('h2', { class: 'konten-title', text: g }),
      h('div', { class: 'card list' }, l.map(kontoZeile)))),
    kontoNeu()));
}

function renderKonten() {
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Konten' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: () => loadKonten(true) }, 'Neu prüfen')),
    h('p', { class: 'date', text: 'Wo du überall angemeldet bist – und mit welcher E-Mail. Passwörter stehen hier nie; die bleiben im Schlüsselbund.' }),
    h('div', { id: 'konten-body', class: 'section' }));
  renderKontenBody();
  loadKonten(true);
}

// ---------- Abschnitt „Anmeldungen“ in der Info-Leiste eines Chats ----------

// Wie konten.forChat im Hauptprozess: welche Konten dieser Chat benutzt (aus seinen Schritten).
function chatKonten(steps, list) {
  const used = [];
  const add = (k) => { if (k && !used.some((x) => x.key === k.key)) used.push(k); };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  add(list.find((k) => k.key === 'claude'));
  for (const s of steps) {
    const m = String(s.tool || '').match(/^mcp__(.+?)__/);
    if (!m || ['chats', 'kommentare', 'mac'].includes(m[1])) continue;
    if (m[1] === 'web') {
      add(s.tab ? list.find((k) => k.tab === s.tab) : { key: 'web', dienst: 'Web-Tabs', konto: '', stand: 'unbekannt', wo: 'der gerade angezeigte Tab' });
      continue;
    }
    add(list.find((k) => k.match === norm(m[1])));
  }
  return used;
}

function accountsSection() {
  loadKonten(false);
  const list = ui.konten;
  if (!list) return infoSection('Anmeldungen', h('p', { class: 'info-empty', text: 'Wird geladen …' }));
  const steps = ui.messages.filter((m) => m.kind === 'tool');
  const used = chatKonten(steps, list);
  const rows = used.map((k) => {
    const [label] = KONTEN_STAND[k.stand] || [k.stand];
    const cls = k.stand === 'angemeldet' ? 'ok' : k.stand === 'anmelden' || k.stand === 'fehler' ? 'warn' : '';
    return infoRow(k.stand === 'angemeldet' ? '●' : '○', k.konto ? `${k.dienst} · ${k.konto}` : k.dienst, {
      right: k.konto || k.stand !== 'unbekannt' ? label : 'eintragen', rightClass: cls,
      title: `${k.wo || ''}\nKlicken: alle Konten ansehen`, onClick: () => setView('konten') });
  });
  const missing = list.filter((k) => k.stand === 'anmelden').length;
  return infoSection('Anmeldungen',
    ...rows,
    used.length <= 1 ? h('p', { class: 'info-note', text: 'Weitere erscheinen, sobald Claude hier Gmail, Web-Tabs & Co. benutzt.' }) : null,
    missing ? h('button', { class: 'link info-add', 'data-focus': 'info-konten', onClick: () => { kv.filter = 'offen'; setView('konten'); } },
      `${missing} Anmeldung${missing === 1 ? '' : 'en'} fehlen insgesamt →`) : null);
}

if (typeof module !== 'undefined') module.exports = { chatKonten };

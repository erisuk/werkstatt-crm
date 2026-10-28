// Ansicht „Kommentare“: wer unter Bits Videos das Stichwort kommentiert hat und den Code bekommen soll.
// Claude sammelt die Kommentare in den Web-Tabs ein und tippt Nachrichten vor – auf „Senden“ drückt der Nutzer selbst.
// Nutzt die Helfer aus app.js (h, fill, ui, api …).

const komm = { daten: null, meldung: null, timer: null, filter: 'alle' };
const KOMM_POLL_MS = 4000;      // Claude schreibt in dieselbe Datei – so erscheinen neue Treffer von selbst
const KOMM_STATUS = { offen: ['offen', ''], vorbereitet: ['vorbereitet', 'amber'], gesendet: ['gesendet', 'green'], ignoriert: ['ignoriert', ''] };
const PLATTFORM_NAME = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

async function loadKommentare() {
  if (ui.view !== 'kommentare') { clearInterval(komm.timer); komm.timer = null; return; }
  const res = await api.kommentare();
  if (!res || !res.ok) return;
  if (!changed('kommentare', res.data)) return;
  komm.daten = res.data;
  renderKommentareBody();
}

async function kommAuftrag(art, id) {
  const res = await api.kommentareAuftrag(art, id);
  if (!res || !res.ok) { komm.meldung = (res && res.error) || 'Das hat nicht geklappt.'; renderKommentareBody(); return; }
  sendMessage(res.data);
}

async function kommStatus(id, status) {
  await api.kommentareStatus(id, status);
  loadKommentare();
}

function kommEinstellungen() {
  const d = komm.daten;
  const konto = h('input', { id: 'komm-konto', type: 'text', placeholder: '@bit.ai.news', 'data-focus': 'komm-konto' });
  konto.value = d.konto;
  const wort = h('input', { id: 'komm-wort', type: 'text', 'data-focus': 'komm-wort' });
  wort.value = d.stichwort;
  const vorlage = h('textarea', { id: 'komm-vorlage', rows: '2', 'data-focus': 'komm-vorlage' });
  vorlage.value = d.vorlage;
  return h('form', { class: 'card form', onSubmit: async (e) => {
    e.preventDefault();
    const res = await api.kommentareSettings({ konto: konto.value, stichwort: wort.value, vorlage: vorlage.value });
    komm.meldung = res.ok ? 'Gespeichert.' : res.error;
    loadKommentare();
    renderKommentareBody();
  } },
  h('div', { class: 'field' }, h('label', { for: 'komm-konto', text: 'Eigenes Instagram-Konto' }), konto),
  h('div', { class: 'field' }, h('label', { for: 'komm-wort', text: 'Stichwort' }), wort),
  h('div', { class: 'field full' }, h('label', { for: 'komm-vorlage', text: 'Nachricht ({name} = Profilname)' }), vorlage),
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: 'Claude prüft vor jedem Auftrag, dass genau dieses Konto angemeldet ist – sonst bricht er ab.' }),
    h('span', { class: 'spacer' }), h('button', { type: 'submit', class: 'btn ghost' }, 'Speichern')));
}

function kommZeile(e, frei) {
  const [label, farbe] = KOMM_STATUS[e.status] || KOMM_STATUS.offen;
  const aktionen = [];
  if (e.status === 'offen') {
    aktionen.push(h('button', { class: 'btn', 'data-focus': `komm-prep:${e.id}`, disabled: !ui.state.claude.found || frei === 0,
      title: frei === 0 ? 'Diese Stunde sind genug Nachrichten raus' : 'Claude tippt die Nachricht im Web-Tab vor – senden tust du',
      onClick: () => kommAuftrag('vorbereiten', e.id) }, 'Nachricht vorbereiten'));
  }
  if (e.status === 'vorbereitet') {
    aktionen.push(h('button', { class: 'btn', 'data-focus': `komm-sent:${e.id}`, onClick: () => kommStatus(e.id, 'gesendet') }, 'Hab gesendet'));
  }
  if (e.status === 'offen' || e.status === 'vorbereitet') {
    aktionen.push(h('button', { class: 'link', 'data-focus': `komm-skip:${e.id}`, onClick: () => kommStatus(e.id, 'ignoriert') }, 'Ignorieren'));
  }
  if (e.status === 'ignoriert') {
    aktionen.push(h('button', { class: 'link', 'data-focus': `komm-back:${e.id}`, onClick: () => kommStatus(e.id, 'offen') }, 'Zurückholen'));
  }
  return h('div', { class: 'row' },
    h('span', { class: 'pill blue', text: PLATTFORM_NAME[e.plattform] || e.plattform }),
    h('div', { class: 'grow' },
      h('div', { class: 'title', text: e.name }),
      h('div', { class: 'sub clamp', text: `„${e.kommentar}“` })),
    h('span', { class: 'when', text: formatWhen(e.gefunden) }),
    h('span', { class: `pill ${farbe}`, text: label }),
    aktionen);
}

function renderKommentareBody() {
  const box = $('#komm-body');
  if (!box) return;
  const d = komm.daten;
  if (!d) { fill(box, h('div', { class: 'card empty', text: 'Lädt …' })); return; }
  const zahl = (s) => d.eintraege.filter((e) => e.status === s).length;
  const liste = d.eintraege.filter((e) => komm.filter === 'alle' ? e.status !== 'ignoriert' : e.status === komm.filter)
    .sort((a, b) => b.gefunden - a.gefunden);
  const filterBtn = (f, label) => h('button', { 'aria-pressed': String(komm.filter === f), 'data-focus': `komm-filter:${f}`,
    onClick: () => { komm.filter = f; renderKommentareBody(); } }, label);
  keepFocus(() => fill(box,
    komm.meldung ? h('div', { class: 'notice', role: 'status', text: komm.meldung }) : null,
    h('div', { class: 'stats' },
      stat(`Wollen den Code („${d.stichwort}“)`, d.eintraege.filter((e) => e.status !== 'ignoriert').length),
      stat('Offen', zahl('offen') + zahl('vorbereitet')), stat('Gesendet', zahl('gesendet'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', 'data-focus': 'komm-sammeln', disabled: !ui.state.claude.found,
        onClick: () => kommAuftrag('einsammeln') }, 'Instagram-Kommentare einsammeln'),
      h('span', { class: 'hint', text: `Diese Stunde noch ${d.nochFrei} Nachrichten frei. Lesen geht ohne Rückfrage, Klicks fragt die Zentrale.` })),
    h('section', { class: 'section' },
      h('div', { class: 'section-head wrap' }, h('h2', { text: 'Liste' }), h('span', { class: 'spacer' }),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter' },
          filterBtn('alle', 'Alle'), filterBtn('offen', 'Offen'), filterBtn('vorbereitet', 'Vorbereitet'),
          filterBtn('gesendet', 'Gesendet'), filterBtn('ignoriert', 'Ignoriert'))),
      h('div', { class: 'card list' }, liste.length ? liste.map((e) => kommZeile(e, d.nochFrei))
        : h('div', { class: 'empty', text: d.eintraege.length ? 'Nichts in diesem Filter.' : 'Noch keine Kommentare. Klick auf „Instagram-Kommentare einsammeln“.' }))),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Einstellungen' })), kommEinstellungen())));
}

function renderKommentare() {
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Kommentare' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: () => { ui.sig.kommentare = null; loadKommentare(); } }, 'Aktualisieren')),
    h('p', { class: 'date', text: 'Wer unter deinen Videos das Stichwort kommentiert hat, landet hier. Claude tippt die Nachricht vor – auf „Senden“ drückst du selbst, höchstens 10 pro Stunde.' }),
    h('div', { id: 'komm-body', class: 'section' }));
  komm.meldung = null;
  ui.sig.kommentare = null;
  renderKommentareBody();
  loadKommentare();
  clearInterval(komm.timer);
  komm.timer = setInterval(loadKommentare, KOMM_POLL_MS);
}

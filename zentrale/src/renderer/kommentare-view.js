// Abschnitt „Kommentare & Antworten“ auf der Seite „Bit-Videos“: je Video das Stichwort, das Bit im Video nennt,
// die Antwort, die jeder Kommentierende bekommt, und die Leute, die darauf warten. Claude sammelt die Kommentare ein
// (auf Knopfdruck oder täglich) und tippt die Antworten vor – auf „Senden“ drückt der Nutzer selbst.
// Nutzt die Helfer aus app.js und bitvideos-view.js (h, fill, ui, api, bitAktion, bitFeld …).

const komm = { offen: null, gesendetZeigen: new Set() };
const KOMM_VIDEOS_MAX = 6;
const KOMM_STATUS = { offen: ['wartet', 'amber'], vorbereitet: ['vorgetippt', 'blue'], gesendet: ['gesendet', 'green'], ignoriert: ['ignoriert', ''] };

async function kommAuftrag(art, id) {
  let res;
  try { res = await api.kommentareAuftrag(art, id); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
  if (!res || !res.ok) { zeigeMeldung((res && res.error) || 'Das hat nicht geklappt.', true); return; }
  sendMessage(res.data);
}

function kommKopf(k) {
  const konto = bitFeld('input', { id: 'komm-konto', type: 'text', placeholder: '@bits.konto' }, k.konto);
  const auto = k.automatik && k.automatik.an;
  const claudeDa = ui.state.claude.found;
  return h('form', { class: 'card form', onSubmit: (e) => {
    e.preventDefault();
    bitAktion(() => api.kommentareSettings({ konto: konto.value }), 'Konto gespeichert.', ['komm-konto']);
  } },
  h('div', { class: 'field' }, h('label', { for: 'komm-konto', text: 'Instagram-Konto von Bit' }), konto,
    h('span', { class: 'hint', text: 'Claude prüft vor jedem Auftrag, dass genau dieses Konto angemeldet ist – sonst bricht er ab.' })),
  h('div', { class: 'field' }, h('span', { class: 'label', text: 'Automatisch einsammeln' }),
    h('div', { class: 'toggle-line' },
      h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!auto), 'aria-label': 'Jeden Tag automatisch einsammeln', 'data-focus': 'komm-auto',
        disabled: !k.konto, onClick: () => bitAktion(() => api.kommentareAutomatik(!auto), auto ? 'Automatik aus.' : `Claude sammelt ab jetzt jeden Tag um ${k.automatik ? k.automatik.zeit : '18:00'} ein.`) }),
      h('span', { text: auto ? `jeden Tag um ${k.automatik.zeit}${k.automatik.laeuft ? ' – läuft gerade' : ''}` : 'aus' })),
    h('span', { class: 'hint', text: 'Liest nur – schreibt, liked und sendet nichts. Braucht „Web-Tabs für Claude“ unter Verbindungen.' })),
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: `Diese Stunde gehen noch ${k.nochFrei} Nachrichten (Schutz vor Spam-Sperre).` }),
    h('span', { class: 'spacer' }),
    h('button', { type: 'submit', class: 'btn ghost' }, 'Konto speichern'),
    h('button', { type: 'button', class: 'btn', 'data-focus': 'komm-sammeln', disabled: !claudeDa || !k.konto,
      onClick: () => kommAuftrag('einsammeln') }, 'Jetzt einsammeln')));
}

function kommEditor(a) {
  const wort = bitFeld('input', { id: `komm-wort-${a.video}`, type: 'text', maxlength: '30' }, a.stichwort);
  const text = bitFeld('textarea', { id: `komm-text-${a.video}`, rows: '3', maxlength: '500' }, a.nachricht);
  return h('form', { class: 'form komm-editor', onSubmit: (e) => {
    e.preventDefault();
    bitAktion(() => api.bitAktion(a.video, { stichwort: wort.value, nachricht: text.value }), 'Antwort gespeichert.',
      [`komm-wort-${a.video}`, `komm-text-${a.video}`]);
    komm.offen = null;
  } },
  h('div', { class: 'field' }, h('label', { for: `komm-wort-${a.video}`, text: 'Stichwort (wie im Video gesagt)' }), wort),
  h('div', { class: 'field' }, h('span', { class: 'label', text: 'Aktion' }),
    h('div', { class: 'toggle-line' },
      h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(a.aktiv), 'aria-label': `Kommentar-Aktion für ${a.stichwort}`,
        'data-focus': `komm-aktiv-${a.video}`, onClick: () => bitAktion(() => api.bitAktion(a.video, { aktiv: !a.aktiv }), a.aktiv ? 'Aktion aus.' : 'Aktion an.') }),
      h('span', { text: a.aktiv ? 'an – Kommentare werden eingesammelt' : 'aus' }))),
  h('div', { class: 'field full' }, h('label', { for: `komm-text-${a.video}`, text: 'Antwort ({name} = Profilname)' }), text),
  h('div', { class: 'actions full' },
    h('button', { type: 'button', class: 'link', onClick: () => { komm.offen = null; renderBitBody(); } }, 'Abbrechen'),
    h('button', { type: 'submit', class: 'btn ghost' }, 'Speichern')));
}

function kommPerson(e, frei) {
  const [label, farbe] = KOMM_STATUS[e.status] || KOMM_STATUS.offen;
  const aktionen = [];
  if (e.status === 'offen') {
    aktionen.push(h('button', { class: 'link', 'aria-label': `Antwort vortippen für ${e.name}`, 'data-focus': `komm-prep:${e.id}`,
      disabled: !ui.state.claude.found || frei === 0, title: frei === 0 ? 'Diese Stunde sind genug Nachrichten raus' : 'Claude tippt die Antwort im Web-Tab vor – senden tust du',
      onClick: () => kommAuftrag('vorbereiten', e.id) }, 'Antwort vortippen'));
  }
  if (e.status === 'vorbereitet') {
    aktionen.push(h('button', { class: 'link', 'aria-label': `Gesendet an ${e.name}`, 'data-focus': `komm-sent:${e.id}`,
      onClick: () => bitAktion(() => api.kommentareStatus(e.id, 'gesendet'), `${e.name} ist erledigt.`) }, 'Hab gesendet'));
  }
  if (e.status === 'offen' || e.status === 'vorbereitet') {
    aktionen.push(h('button', { class: 'link', 'aria-label': `Ignorieren: ${e.name}`, 'data-focus': `komm-skip:${e.id}`,
      onClick: () => bitAktion(() => api.kommentareStatus(e.id, 'ignoriert'), 'Ignoriert.') }, 'Ignorieren'));
  }
  return h('div', { class: 'row bit-row komm-person' },
    h('span', { class: `pill ${farbe}`, text: label }),
    h('div', { class: 'grow' }, h('div', { class: 'title', text: e.name }), h('div', { class: 'sub clamp', text: `„${e.kommentar}“` })),
    h('span', { class: 'when', text: formatWhen(e.gefunden) }),
    aktionen);
}

function kommVideo(a, eintraege, frei) {
  const meine = eintraege.filter((e) => e.video === a.video && e.status !== 'ignoriert').sort((x, y) => y.gefunden - x.gefunden);
  const wartend = meine.filter((e) => e.status !== 'gesendet');
  const gesendet = meine.filter((e) => e.status === 'gesendet');
  const zeigen = komm.gesendetZeigen.has(a.video);
  return h('div', { class: 'card list komm-video' },
    h('div', { class: 'row bit-row' },
      h('span', { class: 'pill', text: `#${String(a.nr).padStart(3, '0')}` }),
      h('div', { class: 'grow' }, h('div', { class: 'title', text: a.thema }),
        h('div', { class: 'sub clamp', text: `Antwort: ${a.nachricht}` })),
      h('span', { class: `pill ${a.aktiv ? 'blue' : ''}`, text: a.aktiv ? `💬 ${a.stichwort}` : `${a.stichwort} · aus` }),
      h('span', { class: 'when', text: `${wartend.length} wartet · ${gesendet.length} gesendet` }),
      h('button', { class: 'link', 'aria-label': `Antwort ändern für ${a.stichwort}`, 'data-focus': `komm-edit:${a.video}`,
        onClick: () => { komm.offen = komm.offen === a.video ? null : a.video; renderBitBody(); } }, komm.offen === a.video ? 'Schließen' : 'Ändern')),
    komm.offen === a.video ? kommEditor(a) : null,
    wartend.map((e) => kommPerson(e, frei)),
    gesendet.length ? h('button', { class: 'link komm-mehr', 'data-focus': `komm-gesendet:${a.video}`,
      onClick: () => { if (zeigen) komm.gesendetZeigen.delete(a.video); else komm.gesendetZeigen.add(a.video); renderBitBody(); } },
    zeigen ? 'Gesendete ausblenden' : `${gesendet.length} gesendete zeigen`) : null,
    zeigen ? gesendet.map((e) => kommPerson(e, frei)) : null);
}

// Der ganze Abschnitt. k = Antwort von api.kommentare().
function bitKommentare(k) {
  if (!k) return h('div', { class: 'card empty', text: 'Lädt …' });
  const wartend = k.eintraege.filter((e) => e.status === 'offen' || e.status === 'vorbereitet');
  // Videos mit wartenden Leuten immer zeigen, sonst die neuesten aktiven.
  const mitWartenden = new Set(wartend.map((e) => e.video));
  const videos = k.aktionen.filter((a, i) => mitWartenden.has(a.video) || (a.aktiv && i < KOMM_VIDEOS_MAX) || komm.offen === a.video);
  return [
    kommKopf(k),
    h('div', { class: 'stats' },
      stat('Warten auf ihre Antwort', wartend.length),
      stat('Gesendet', k.eintraege.filter((e) => e.status === 'gesendet').length),
      stat('Videos mit Stichwort', k.aktionen.filter((a) => a.aktiv).length)),
    // ausgepackt: h() und fill() glätten nur eine Ebene
    ...(videos.length ? videos.map((a) => kommVideo(a, k.eintraege, k.nochFrei))
      : [h('div', { class: 'card empty', text: 'Noch kein Video mit Kommentar-Stichwort.' })]),
  ];
}

// Ansicht „Bit-Videos“: worüber Bit jeden Tag ein Video macht – Status, Wunschthemen, Radar-Themen, Suchradius, letzte Videos.
// Alles wirkt ab dem nächsten automatischen Lauf (täglich 10:00). Nutzt die Helfer aus app.js (h, fill, ui, api …).

const bit = { daten: null, meldung: null, timer: null };
const BIT_POLL_MS = 10000;   // Radar und Telegram-Freigaben ändern die Dateien auch von außen
const FORMAT_NAME = { superkraft: 'Neue Fähigkeit', 'tool-ersatz': 'Spart Geld', 'github-fund': 'GitHub-Fund',
  'top-liste': 'Top-Liste', 'trend-erklaert': 'Erklärt', raum: 'Raum-Video' };
const VIDEO_STATUS = { wartet: ['wartet auf Freigabe', 'amber'], freigegeben: ['freigegeben', 'green'],
  abgelehnt: ['abgelehnt', ''], 'in Arbeit': ['in Arbeit', ''] };
const PLATTFORM_KURZ = { insta: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

const datumDE = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

async function loadBitVideos() {
  if (ui.view !== 'bitvideos') { clearInterval(bit.timer); bit.timer = null; return; }
  const res = await api.bit();
  if (!res) return;
  if (!res.ok) { bit.daten = null; bit.meldung = res.error; renderBitBody(); return; }
  if (!changed('bitvideos', res.data)) return;
  bit.daten = res.data;
  renderBitBody();
}

// Führt eine Änderung aus, zeigt Fehler oder eine kurze Bestätigung und lädt neu.
async function bitAktion(aufruf, okText) {
  const res = await aufruf();
  bit.meldung = res && res.ok ? okText : (res && res.error) || 'Das hat nicht geklappt.';
  ui.sig.bitvideos = null;
  await loadBitVideos();
  renderBitBody();
}

function bitSchritt(nr, titel, text) {
  return h('div', { class: 'section-head wrap' },
    h('h2', { text: `${nr}. ${titel}` }),
    text ? h('span', { class: 'sub', text }) : null);
}

// 1. Läuft die Automatik, und was kommt als Nächstes?
function bitStatus(d) {
  const naechstes = d.wuensche[0] ? `dein Wunschthema „${d.wuensche[0].thema}“`
    : 'das beste neue Thema vom Radar';
  if (d.pauseBis) {
    return h('div', { class: 'card form' },
      h('div', { class: 'full bit-status' },
        h('div', { class: 'title', text: `⏸ Pausiert bis ${datumDE(d.pauseBis)}` }),
        h('div', { class: 'hint', text: `Ab dem ${datumDE(d.pauseBis)} macht Bit wieder jeden Tag um 10:00 ein Video. Als Nächstes dran: ${naechstes}.` })),
      h('div', { class: 'actions full' },
        h('button', { class: 'btn', 'data-focus': 'bit-weiter', onClick: () => bitAktion(() => api.bitPause(null), 'Pause beendet – morgen um 10:00 geht es weiter.') }, 'Pause beenden')));
  }
  const bis = h('input', { id: 'bit-pause-bis', type: 'date', 'data-focus': 'bit-pause-bis' });
  return h('form', { class: 'card form', onSubmit: (e) => {
    e.preventDefault();
    bitAktion(() => api.bitPause(bis.value), 'Pausiert.');
  } },
  h('div', { class: 'full bit-status' },
    h('div', { class: 'title', text: '▶ Läuft – jeden Tag um 10:00 ein neues Video' }),
    h('div', { class: 'hint', text: `Als Nächstes dran: ${naechstes}. Das fertige Video kommt zur Freigabe in Telegram.` })),
  h('div', { class: 'field' }, h('label', { for: 'bit-pause-bis', text: 'Pausieren bis (z. B. wenn das Stimmen-Guthaben leer ist)' }), bis),
  h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn ghost' }, 'Pausieren')));
}

// 2. Eigene Themen – kommen vor dem Radar dran.
function bitWuensche(d) {
  const thema = h('input', { id: 'bit-w-thema', type: 'text', maxlength: '200', placeholder: 'z. B. Claude kann jetzt Excel-Tabellen bauen', 'data-focus': 'bit-w-thema' });
  const link = h('input', { id: 'bit-w-link', type: 'url', placeholder: 'https://… (optional, aber empfohlen)', 'data-focus': 'bit-w-link' });
  const form = h('form', { class: 'card form', onSubmit: (e) => {
    e.preventDefault();
    bitAktion(() => api.bitWunschAdd(thema.value, link.value), 'Wunschthema gespeichert.');
  } },
  h('div', { class: 'field' }, h('label', { for: 'bit-w-thema', text: 'Thema' }), thema),
  h('div', { class: 'field' }, h('label', { for: 'bit-w-link', text: 'Link zur Quelle' }), link),
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: 'Mit Link liest Bit die Quelle und erklärt sie genau. Ohne Link bleibt er bei sicheren Allgemeinfakten.' }),
    h('span', { class: 'spacer' }), h('button', { type: 'submit', class: 'btn' }, 'Hinzufügen')));
  const liste = d.wuensche.length ? h('div', { class: 'card list' }, d.wuensche.map((w, i) => h('div', { class: 'row bit-row' },
    h('span', { class: `pill ${i === 0 ? 'blue' : ''}`, text: i === 0 ? 'als Nächstes' : `${i + 1}.` }),
    h('div', { class: 'grow' }, h('div', { class: 'title', text: w.thema }), h('div', { class: 'sub', text: w.link || 'ohne Link' })),
    i > 0 ? h('button', { class: 'link', 'data-focus': `bit-w-vor:${w.id}`, onClick: () => bitAktion(() => api.bitWunschVor(w.id), 'Kommt als Nächstes dran.') }, 'Als Nächstes') : null,
    h('button', { class: 'link', 'data-focus': `bit-w-weg:${w.id}`, onClick: () => bitAktion(() => api.bitWunschRemove(w.id), 'Entfernt.') }, 'Entfernen'))))
    : null;
  return [form, liste];
}

// 3. Was das Radar zuletzt gefunden hat.
function bitRadar(d) {
  const r = d.radar;
  if (!r.themen.length) return h('div', { class: 'card empty', text: 'Noch keine Themenliste. Das Radar läuft automatisch vor jedem Video.' });
  return h('div', { class: 'card list' }, r.themen.map((t) => {
    const wunschLink = t.quellen.find((q) => /^https?:\/\//.test(q)) || '';
    return h('div', { class: 'row bit-row' },
      h('span', { class: 'pill', title: `Superkraft ${t.werte.superkraft} · spart ${t.werte.spart} · Wow ${t.werte.wow} · einfach ${t.werte.einfach} · aktuell ${t.werte.aktuell}`, text: `${t.summe}/25` }),
      h('div', { class: 'grow' },
        h('div', { class: 'title', text: t.thema }),
        h('div', { class: 'sub clamp', text: `${FORMAT_NAME[t.format] || t.format}${t.hook ? ` · „${t.hook}“` : ''}` })),
      t.gemacht ? h('span', { class: 'pill green', text: 'schon gemacht' }) : null,
      t.gesperrt ? h('span', { class: 'pill', text: 'gesperrt' }) : null,
      !t.gemacht && !t.gesperrt ? h('button', { class: 'link', 'data-focus': `bit-r-wunsch:${t.thema}`,
        onClick: () => bitAktion(() => api.bitWunschAdd(t.thema, wunschLink), 'Als Wunschthema übernommen.') }, 'Als Wunsch') : null,
      h('button', { class: 'link', 'data-focus': `bit-r-sperre:${t.thema}`,
        onClick: () => bitAktion(() => api.bitSperren(t.thema, !t.gesperrt), t.gesperrt ? 'Wieder freigegeben.' : 'Gesperrt – kommt nie wieder.') },
      t.gesperrt ? 'Freigeben' : 'Sperren'));
  }));
}

// 4. Wo und wie das Radar sucht.
function bitSuchradius(d) {
  const e = d.einstellungen;
  const quellen = h('div', { class: 'card list' }, d.quellen.map((q) => {
    const an = !e.quellen_aus.includes(q.id);
    return h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'title', text: q.name }), h('div', { class: 'sub', text: q.info })),
      h('button', { class: 'switch', role: 'switch', 'aria-checked': String(an), 'aria-label': q.name, 'data-focus': `bit-q:${q.id}`,
        onClick: () => {
          const aus = an ? [...e.quellen_aus, q.id] : e.quellen_aus.filter((x) => x !== q.id);
          bitAktion(() => api.bitSettings({ quellen_aus: aus }), `${q.name} ${an ? 'aus' : 'an'}.`);
        } }));
  }));
  const subs = h('input', { id: 'bit-subs', type: 'text', 'data-focus': 'bit-subs' });
  subs.value = e.reddit_subs.join(', ');
  const takt = h('select', { id: 'bit-takt', 'data-focus': 'bit-takt' },
    [0, 2, 3, 4, 5].map((n) => h('option', { value: String(n), text: n === 0 ? 'nie bevorzugen' : `jedes ${n}. Video` })));
  takt.value = String(e.github_alle);
  const fokus = h('textarea', { id: 'bit-fokus', rows: '2', maxlength: '300', placeholder: 'z. B. mehr Bild- und Video-KI, weniger Programmier-Themen', 'data-focus': 'bit-fokus' });
  fokus.value = e.fokus;
  const form = h('form', { class: 'card form', onSubmit: (ev) => {
    ev.preventDefault();
    bitAktion(() => api.bitSettings({ reddit_subs: subs.value, github_alle: Number(takt.value), fokus: fokus.value }), 'Gespeichert – gilt ab dem nächsten Lauf.');
  } },
  h('div', { class: 'field full' }, h('label', { for: 'bit-fokus', text: 'Worauf soll Bit besonders achten?' }), fokus,
    h('span', { class: 'hint', text: 'Grundregel bleibt immer: KI-Bezug und echter Nutzen für normale Leute.' })),
  h('div', { class: 'field' }, h('label', { for: 'bit-subs', text: 'Reddit-Subreddits' }), subs,
    h('span', { class: 'hint', text: 'Mit Komma trennen, ohne „r/“.' })),
  h('div', { class: 'field' }, h('label', { for: 'bit-takt', text: 'GitHub-Fund bevorzugen' }), takt,
    h('span', { class: 'hint', text: 'Nur wenn der Fund fast so gut ist wie das beste Thema.' })),
  h('div', { class: 'actions full' }, h('button', { type: 'submit', class: 'btn ghost' }, 'Speichern')));
  return [quellen, form];
}

// 5. Die letzten Videos.
function bitVideos(d) {
  if (!d.videos.length) return h('div', { class: 'card empty', text: 'Noch keine Videos.' });
  return h('div', { class: 'card list' }, d.videos.slice(0, 8).map((v) => {
    const [label, farbe] = VIDEO_STATUS[v.status] || [v.status, ''];
    return h('div', { class: 'row bit-row' },
      h('span', { class: 'pill', text: `#${String(v.nr).padStart(3, '0')}` }),
      h('div', { class: 'grow' }, h('div', { class: 'title', text: v.thema }),
        h('div', { class: 'sub', text: v.gepostet.length ? `gepostet: ${v.gepostet.map((p) => PLATTFORM_KURZ[p] || p).join(', ')}` : 'noch nicht gepostet' })),
      h('span', { class: `pill ${farbe}`, text: label }));
  }));
}

function renderBitBody() {
  const box = $('#bit-body');
  if (!box) return;
  const d = bit.daten;
  const meldung = bit.meldung ? h('div', { class: 'notice', role: 'status', text: bit.meldung }) : null;
  if (!d) { fill(box, meldung || h('div', { class: 'card empty', text: 'Lädt …' })); return; }
  const radarText = d.radar.datum ? `Stand ${datumDE(d.radar.datum)} – die besten Themen, Bit nimmt das oberste` : '';
  keepFocus(() => fill(box, meldung,
    h('section', { class: 'section' }, bitSchritt(1, 'Läuft die Automatik?'), bitStatus(d)),
    h('section', { class: 'section' }, bitSchritt(2, 'Deine Wunschthemen', 'kommen vor dem Radar dran, ältestes zuerst'), bitWuensche(d)),
    h('section', { class: 'section' }, bitSchritt(3, 'Themen vom Radar', radarText), bitRadar(d)),
    h('section', { class: 'section' }, bitSchritt(4, 'Wo Bit nach Themen sucht', 'Quellen an/aus und eigener Schwerpunkt'), bitSuchradius(d)),
    h('section', { class: 'section' }, bitSchritt(5, 'Letzte Videos'), bitVideos(d))));
}

function renderBitVideos() {
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Bit-Videos' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: () => { ui.sig.bitvideos = null; loadBitVideos(); } }, 'Aktualisieren')),
    h('p', { class: 'date', text: 'Hier steuerst du, worüber Bit jeden Tag ein Video macht. Änderungen gelten ab dem nächsten Lauf.' }),
    h('div', { id: 'bit-body', class: 'section' }));
  bit.meldung = null;
  ui.sig.bitvideos = null;
  renderBitBody();
  loadBitVideos();
  clearInterval(bit.timer);
  bit.timer = setInterval(loadBitVideos, BIT_POLL_MS);
}
